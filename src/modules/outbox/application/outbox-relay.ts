import type { Pool } from 'pg';

import type { DomainEvent, OutboxPublisher } from '../domain/outbox.js';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export interface OutboxMetrics {
  pendingCount: number;
  oldestPendingAgeMs: number;
}

export class OutboxRelay {
  constructor(
    private readonly pool: Pool,
    private readonly publisher: OutboxPublisher,
  ) {}

  async relayBatch(batchSize: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<OutboxRow>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, occurred_at
           FROM outbox_events
          WHERE published_at IS NULL AND available_at <= now()
          ORDER BY occurred_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [batchSize],
      );

      for (const row of selected.rows) {
        await client.query(
          `UPDATE outbox_events
              SET attempts = attempts + 1, last_attempt_at = now(), last_error = NULL
            WHERE id = $1`,
          [row.id],
        );
        try {
          await this.publisher.publish(mapEvent(row));
          await client.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [
            row.id,
          ]);
        } catch (error) {
          await client.query(
            `UPDATE outbox_events
                SET last_error = left($2, 2000),
                    available_at = now() + make_interval(secs => LEAST(60, attempts * attempts))
              WHERE id = $1`,
            [row.id, errorMessage(error)],
          );
        }
      }
      await client.query('COMMIT');
      return selected.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async metrics(): Promise<OutboxMetrics> {
    const result = await this.pool.query<{ pending_count: string; oldest_age_ms: string | null }>(
      `SELECT count(*) AS pending_count,
              extract(epoch FROM (now() - min(occurred_at))) * 1000 AS oldest_age_ms
         FROM outbox_events
        WHERE published_at IS NULL`,
    );
    const row = result.rows[0];
    return {
      pendingCount: Number(row?.pending_count ?? 0),
      oldestPendingAgeMs: Math.max(0, Number(row?.oldest_age_ms ?? 0)),
    };
  }

  async archivePublished(retentionDays: number, batchSize: number): Promise<number> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT id FROM outbox_events
          WHERE published_at < now() - make_interval(days => $1)
            AND archived_at IS NULL
          ORDER BY published_at
          LIMIT $2
       )
       UPDATE outbox_events o SET archived_at = now()
        FROM candidates c WHERE o.id = c.id`,
      [retentionDays, batchSize],
    );
    return result.rowCount ?? 0;
  }
}

function mapEvent(row: OutboxRow): DomainEvent {
  return {
    eventId: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
