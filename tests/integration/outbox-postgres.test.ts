import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { IdempotentEventConsumer } from '../../src/modules/outbox/application/idempotent-event-consumer.js';
import { OutboxRelay } from '../../src/modules/outbox/application/outbox-relay.js';
import type { DomainEvent, OutboxPublisher } from '../../src/modules/outbox/domain/outbox.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

class RecordingPublisher implements OutboxPublisher {
  readonly events: DomainEvent[] = [];
  fail = false;

  publish(event: DomainEvent): Promise<void> {
    if (this.fail) return Promise.reject(new Error('publisher unavailable'));
    this.events.push(event);
    return Promise.resolve();
  }
}

describeWithDatabase('transactional outbox', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const publisher = new RecordingPublisher();
  const relay = new OutboxRelay(pool, publisher);
  const eventIds: string[] = [];

  afterAll(async () => {
    await pool.query('DELETE FROM consumed_events WHERE consumer_name = $1', ['outbox-test']);
    await pool.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [eventIds]);
    await pool.end();
  });

  it('keeps a committed event pending when publication fails and publishes it after restart', async () => {
    const eventId = await insertEvent();
    publisher.fail = true;

    await relay.relayBatch(10);
    const failed = await pool.query<{ attempts: number; published_at: Date | null }>(
      'SELECT attempts, published_at FROM outbox_events WHERE id = $1',
      [eventId],
    );
    expect(failed.rows[0]).toMatchObject({ attempts: 1, published_at: null });

    await pool.query('UPDATE outbox_events SET available_at = now() WHERE id = $1', [eventId]);
    publisher.fail = false;
    const restartedRelay = new OutboxRelay(pool, publisher);
    await restartedRelay.relayBatch(10);

    const published = await pool.query<{ attempts: number; published_at: Date | null }>(
      'SELECT attempts, published_at FROM outbox_events WHERE id = $1',
      [eventId],
    );
    expect(published.rows[0]?.attempts).toBe(2);
    expect(published.rows[0]?.published_at).toBeInstanceOf(Date);
    expect(publisher.events.some(({ eventId: publishedId }) => publishedId === eventId)).toBe(true);
  });

  it('deduplicates the same stable event id and its domain effect atomically', async () => {
    const eventId = randomUUID();
    const event: DomainEvent = {
      eventId,
      eventType: 'hold.created',
      aggregateType: 'hold',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: {},
    };
    let effects = 0;
    const consumer = new IdempotentEventConsumer(pool, 'outbox-test', async (client) => {
      await client.query('SELECT 1');
      effects += 1;
    });

    expect(await consumer.consume(event)).toBe(true);
    expect(await consumer.consume(event)).toBe(false);
    expect(effects).toBe(1);
  });

  async function insertEvent(): Promise<string> {
    const id = randomUUID();
    eventIds.push(id);
    await pool.query(
      `INSERT INTO outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'hold', $2, 'hold.created', '{}')`,
      [id, randomUUID()],
    );
    return id;
  }
});
