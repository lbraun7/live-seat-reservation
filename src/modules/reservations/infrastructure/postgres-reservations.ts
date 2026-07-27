import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { HoldExpirationScheduler } from '../application/hold-expiration.js';
import {
  type CreateHoldCommand,
  type Hold,
  type HoldCommand,
  ReservationError,
  type ReservationResult,
  type Reservations,
} from '../domain/reservations.js';

const HOLD_DURATION = '5 minutes';
const RETRYABLE_CODES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;

interface HoldRow {
  id: string;
  event_id: string;
  seat_id: string;
  user_id: string;
  status: Hold['status'];
  expires_at: Date;
  created_at: Date;
  order_id: string | null;
}

interface IdempotencyRow {
  request_hash: string;
  response_status: number | null;
  response_body: ReservationResult['body'] | null;
}

export class PostgresReservations implements Reservations {
  constructor(
    private readonly pool: Pool,
    private readonly expirationScheduler?: HoldExpirationScheduler,
  ) {}

  async createHold(command: CreateHoldCommand): Promise<ReservationResult> {
    const result = await this.idempotent(command, 'create-hold', async (client) => {
      const seat = await client.query<{ status: string }>(
        `SELECT s.status
           FROM seats s
           JOIN events e ON e.id = s.event_id
          WHERE s.id = $1 AND s.event_id = $2
          FOR UPDATE OF s`,
        [command.seatId, command.eventId],
      );
      if (!seat.rowCount) {
        const event = await client.query('SELECT 1 FROM events WHERE id = $1', [command.eventId]);
        throw event.rowCount
          ? new ReservationError('SEAT_NOT_FOUND', 'Seat not found', 404)
          : new ReservationError('EVENT_NOT_FOUND', 'Event not found', 404);
      }

      if (seat.rows[0]?.status === 'HELD') {
        await client.query(
          `UPDATE holds
              SET status = 'EXPIRED', expired_at = now(), updated_at = now()
            WHERE seat_id = $1 AND status = 'ACTIVE' AND expires_at <= now()`,
          [command.seatId],
        );
        await client.query(
          `UPDATE seats
              SET status = 'AVAILABLE'
            WHERE id = $1 AND status = 'HELD'
              AND NOT EXISTS (
                SELECT 1 FROM holds WHERE seat_id = $1 AND status = 'ACTIVE'
              )`,
          [command.seatId],
        );
      }

      const acquired = await client.query(
        `UPDATE seats SET status = 'HELD'
          WHERE id = $1 AND event_id = $2 AND status = 'AVAILABLE'
          RETURNING id`,
        [command.seatId, command.eventId],
      );
      if (!acquired.rowCount) {
        throw new ReservationError('SEAT_UNAVAILABLE', 'Seat is not available', 409);
      }

      const holdId = randomUUID();
      const inserted = await client.query<HoldRow>(
        `INSERT INTO holds (id, event_id, seat_id, user_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + $5::interval)
         RETURNING id, event_id, seat_id, user_id, status, expires_at, created_at,
                   NULL::uuid AS order_id`,
        [holdId, command.eventId, command.seatId, command.userId, HOLD_DURATION],
      );
      return { statusCode: 201, body: mapHold(requireRow(inserted.rows[0])) };
    });
    if (
      result.statusCode === 201 &&
      !result.replayed &&
      'id' in result.body &&
      this.expirationScheduler
    ) {
      await this.expirationScheduler
        .schedule({
          holdId: result.body.id,
          expectedExpiresAt: result.body.expiresAt,
        })
        .catch(() => undefined);
    }
    return result;
  }

  async getHold(holdId: string, userId: string): Promise<Hold> {
    return this.transaction(async (client) => {
      const row = await this.lockHold(client, holdId);
      this.assertOwnership(row, userId);
      await this.expireIfNeeded(client, row);
      return mapHold(row);
    });
  }

  cancelHold(command: HoldCommand): Promise<ReservationResult> {
    return this.idempotent(command, 'cancel-hold', async (client) => {
      const row = await this.lockHold(client, command.holdId);
      this.assertOwnership(row, command.userId);
      await this.expireIfNeeded(client, row);
      if (row.status === 'EXPIRED') {
        throw new ReservationError('HOLD_EXPIRED', 'Hold has expired', 409);
      }
      if (row.status !== 'ACTIVE') {
        throw new ReservationError('HOLD_NOT_ACTIVE', 'Hold is not active', 409);
      }
      await client.query(
        `UPDATE holds SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `UPDATE seats SET status = 'AVAILABLE' WHERE id = $1 AND status = 'HELD'`,
        [row.seat_id],
      );
      row.status = 'CANCELLED';
      return { statusCode: 200, body: mapHold(row) };
    });
  }

  confirmHold(command: HoldCommand): Promise<ReservationResult> {
    return this.idempotent(command, 'confirm-hold', async (client) => {
      const row = await this.lockHold(client, command.holdId);
      this.assertOwnership(row, command.userId);
      await this.expireIfNeeded(client, row);
      if (row.status === 'EXPIRED') {
        throw new ReservationError('HOLD_EXPIRED', 'Hold has expired', 409);
      }
      if (row.status !== 'ACTIVE') {
        throw new ReservationError('HOLD_NOT_ACTIVE', 'Hold is not active', 409);
      }

      const orderId = randomUUID();
      await client.query(
        `UPDATE holds SET status = 'CONFIRMED', updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await client.query(`UPDATE seats SET status = 'SOLD' WHERE id = $1 AND status = 'HELD'`, [
        row.seat_id,
      ]);
      await client.query(
        `INSERT INTO orders (id, hold_id, event_id, user_id) VALUES ($1, $2, $3, $4)`,
        [orderId, row.id, row.event_id, row.user_id],
      );
      await client.query(`INSERT INTO order_items (id, order_id, seat_id) VALUES ($1, $2, $3)`, [
        randomUUID(),
        orderId,
        row.seat_id,
      ]);
      row.status = 'CONFIRMED';
      row.order_id = orderId;
      return { statusCode: 200, body: mapHold(row) };
    });
  }

  private async idempotent(
    command: { userId: string; idempotencyKey: string; requestHash: string },
    operation: string,
    execute: (client: PoolClient) => Promise<ReservationResult>,
  ): Promise<ReservationResult> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO idempotency_keys (user_id, operation, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [command.userId, operation, command.idempotencyKey, command.requestHash],
      );
      const stored = await client.query<IdempotencyRow>(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [command.userId, operation, command.idempotencyKey],
      );
      const existing = requireRow(stored.rows[0]);
      if (existing.request_hash !== command.requestHash) {
        return {
          statusCode: 409,
          body: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was already used with a different request',
          },
        };
      }
      if (existing.response_status !== null && existing.response_body !== null) {
        return {
          statusCode: existing.response_status,
          body: existing.response_body,
          replayed: true,
        };
      }

      await client.query('SAVEPOINT reservation_operation');
      let result: ReservationResult;
      try {
        result = await execute(client);
      } catch (error) {
        if (!(error instanceof ReservationError)) {
          await client.query('ROLLBACK TO SAVEPOINT reservation_operation');
          throw error;
        }
        result = {
          statusCode: error.statusCode,
          body: { code: error.code, message: error.message },
        };
      }
      await client.query(
        `UPDATE idempotency_keys
            SET response_status = $4, response_body = $5, completed_at = now()
          WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3`,
        [command.userId, operation, command.idempotencyKey, result.statusCode, result.body],
      );
      return result;
    });
  }

  private async lockHold(client: PoolClient, holdId: string): Promise<HoldRow> {
    const result = await client.query<HoldRow>(
      `SELECT h.id, h.event_id, h.seat_id, h.user_id, h.status, h.expires_at,
              h.created_at, o.id AS order_id
         FROM holds h
         LEFT JOIN orders o ON o.hold_id = h.id
        WHERE h.id = $1
        FOR UPDATE OF h`,
      [holdId],
    );
    if (!result.rowCount) throw new ReservationError('HOLD_NOT_FOUND', 'Hold not found', 404);
    return requireRow(result.rows[0]);
  }

  private assertOwnership(row: HoldRow, userId: string): void {
    if (row.user_id !== userId) {
      throw new ReservationError('HOLD_FORBIDDEN', 'Hold belongs to another user', 403);
    }
  }

  private async expireIfNeeded(client: PoolClient, row: HoldRow): Promise<void> {
    if (row.status !== 'ACTIVE') return;
    const expired = await client.query(
      `UPDATE holds SET status = 'EXPIRED', expired_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= now()
        RETURNING id`,
      [row.id],
    );
    if (!expired.rowCount) return;
    await client.query(`UPDATE seats SET status = 'AVAILABLE' WHERE id = $1 AND status = 'HELD'`, [
      row.seat_id,
    ]);
    row.status = 'EXPIRED';
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

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_CODES.has(error.code)
  );
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}

function mapHold(row: HoldRow): Hold {
  return {
    id: row.id,
    eventId: row.event_id,
    seatId: row.seat_id,
    userId: row.user_id,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.order_id ? { orderId: row.order_id } : {}),
  };
}
