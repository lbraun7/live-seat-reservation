import type { Pool, PoolClient } from 'pg';

import type { DomainEvent } from '../domain/outbox.js';

export type EventHandler = (client: PoolClient, event: DomainEvent) => Promise<void>;

export class IdempotentEventConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly consumerName: string,
    private readonly handler: EventHandler,
  ) {}

  async consume(event: DomainEvent): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO consumed_events (consumer_name, event_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [this.consumerName, event.eventId],
      );
      if (!claimed.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      await this.handler(client, event);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
