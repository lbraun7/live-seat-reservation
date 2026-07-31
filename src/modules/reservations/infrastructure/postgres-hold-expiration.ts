import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { appendOutboxEvent } from '../../outbox/domain/outbox.js';
import type {
  ExpirationResult,
  HoldExpirationJob,
  HoldExpirationStore,
} from '../application/hold-expiration.js';

const RETRYABLE_CODES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;

interface ExpirationRow {
  id: string;
  status: string;
  expires_at: Date;
  seat_id: string;
}

interface ExpiredRow {
  id: string;
  delay_ms: string;
}

export class PostgresHoldExpirationStore implements HoldExpirationStore {
  constructor(private readonly pool: Pool) {}

  expireHold(job: HoldExpirationJob): Promise<ExpirationResult> {
    return this.transaction(async (client) => {
      const selected = await client.query<ExpirationRow>(
        `SELECT h.id, h.status, h.expires_at, h.seat_id
           FROM holds h
           JOIN seats s ON s.id = h.seat_id
          WHERE h.id = $1
          FOR UPDATE OF s, h`,
        [job.holdId],
      );
      const row = selected.rows[0];
      if (!row) return { holdId: job.holdId, expired: false, reason: 'NOT_FOUND' };
      if (row.expires_at.toISOString() !== job.expectedExpiresAt) {
        return { holdId: job.holdId, expired: false, reason: 'STALE_JOB' };
      }
      if (row.status !== 'ACTIVE') {
        return { holdId: job.holdId, expired: false, reason: 'ALREADY_TRANSITIONED' };
      }

      const expired = await client.query<ExpiredRow>(
        `UPDATE holds
            SET status = 'EXPIRED', expired_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= now()
          RETURNING id, extract(epoch FROM (expired_at - expires_at)) * 1000 AS delay_ms`,
        [job.holdId],
      );
      const result = expired.rows[0];
      if (!result) return { holdId: job.holdId, expired: false, reason: 'NOT_DUE' };

      await releaseSeats(client, [row.seat_id]);
      await timeoutPayments(client, [result.id]);
      await appendExpiredEvent(client, result.id, row.seat_id, result.delay_ms);
      return { holdId: result.id, expired: true, delayMs: Number(result.delay_ms) };
    });
  }

  reconcileExpiredHolds(batchSize: number): Promise<ExpirationResult[]> {
    return this.transaction(async (client) => {
      const expired = await client.query<ExpiredRow & { seat_id: string }>(
        `WITH candidates AS (
           SELECT id
             FROM holds
            WHERE status = 'ACTIVE' AND expires_at <= now()
            ORDER BY expires_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE holds h
            SET status = 'EXPIRED', expired_at = now(), updated_at = now()
           FROM candidates c
          WHERE h.id = c.id
          RETURNING h.id, h.seat_id,
                    extract(epoch FROM (h.expired_at - h.expires_at)) * 1000 AS delay_ms`,
        [batchSize],
      );
      await releaseSeats(
        client,
        expired.rows.map(({ seat_id }) => seat_id),
      );
      await timeoutPayments(
        client,
        expired.rows.map(({ id }) => id),
      );
      for (const row of expired.rows) {
        await appendExpiredEvent(client, row.id, row.seat_id, row.delay_ms);
      }
      return expired.rows.map(({ id, delay_ms }) => ({
        holdId: id,
        expired: true,
        delayMs: Number(delay_ms),
      }));
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryable(error)) continue;
        throw error;
      } finally {
        client.release();
      }
    }
  }
}

async function timeoutPayments(client: PoolClient, holdIds: string[]): Promise<void> {
  if (holdIds.length === 0) return;
  const timedOut = await client.query<{ id: string }>(
    `UPDATE payments SET status = 'TIMED_OUT', completed_at = now(), updated_at = now()
      WHERE hold_id = ANY($1::uuid[]) AND status = 'PENDING' RETURNING id`,
    [holdIds],
  );
  for (const { id } of timedOut.rows) {
    await client.query(
      `INSERT INTO payment_transitions (id, payment_id, from_status, to_status, reason)
       VALUES ($1, $2, 'PENDING', 'TIMED_OUT', 'hold_expired')`,
      [randomUUID(), id],
    );
  }
}

async function appendExpiredEvent(
  client: PoolClient,
  holdId: string,
  seatId: string,
  delayMs: string,
): Promise<void> {
  await appendOutboxEvent(client, {
    aggregateType: 'hold',
    aggregateId: holdId,
    eventType: 'hold.expired',
    payload: { holdId, seatId, delayMs: Number(delayMs) },
  });
}

async function releaseSeats(client: PoolClient, seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return;
  await client.query(
    `UPDATE seats s
        SET status = 'AVAILABLE'
      WHERE s.id = ANY($1::uuid[])
        AND s.status = 'HELD'
        AND NOT EXISTS (
          SELECT 1 FROM holds h WHERE h.seat_id = s.id AND h.status = 'ACTIVE'
        )`,
    [seatIds],
  );
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_CODES.has(error.code)
  );
}
