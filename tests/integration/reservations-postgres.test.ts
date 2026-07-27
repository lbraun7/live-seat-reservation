import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  HoldExpirationJob,
  HoldExpirationScheduler,
} from '../../src/modules/reservations/application/hold-expiration.js';
import { PostgresReservations } from '../../src/modules/reservations/infrastructure/postgres-reservations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('PostgreSQL reservation invariants', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const reservations = new PostgresReservations(pool);
  const eventId = randomUUID();
  const sectionId = randomUUID();
  const seatIds = Array.from({ length: 7 }, () => randomUUID());
  const seatIdAt = (index: number): string => {
    const id = seatIds[index];
    if (!id) throw new Error(`missing test seat ${String(index)}`);
    return id;
  };

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO events (id, name, venue_name, starts_at, sales_start_at)
       VALUES ($1, 'Concurrency test', 'Test venue', now() + interval '1 day', now())`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO seat_sections (id, event_id, name, display_order)
       VALUES ($1, $2, 'Test', 0)`,
      [sectionId, eventId],
    );
    for (const [index, seatId] of seatIds.entries()) {
      await pool.query(
        `INSERT INTO seats
           (id, event_id, section_id, seat_label, row_label, seat_number)
         VALUES ($1, $2, $3, $4, 'A', $5)`,
        [seatId, eventId, sectionId, `A-${String(index + 1)}`, index + 1],
      );
    }
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM idempotency_keys
        WHERE user_id IN (SELECT user_id FROM holds WHERE event_id = $1)`,
      [eventId],
    );
    await pool.query(
      `DELETE FROM order_items
        WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)`,
      [eventId],
    );
    await pool.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM holds WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.end();
  });

  it('allows exactly one winner among 100 requests for one seat', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const userId = randomUUID();
        return reservations.createHold({
          eventId,
          seatId: seatIdAt(0),
          userId,
          idempotencyKey: `race-${String(index)}`,
          requestHash: hash(`${userId}-${seatIdAt(0)}`),
        });
      }),
    );

    expect(attempts.filter(({ statusCode }) => statusCode === 201)).toHaveLength(1);
    expect(attempts.filter(({ statusCode }) => statusCode === 409)).toHaveLength(99);
  });

  it('replays a request and rejects the same key with another payload', async () => {
    const userId = randomUUID();
    const command = {
      eventId,
      seatId: seatIdAt(1),
      userId,
      idempotencyKey: 'same-key',
      requestHash: hash('original'),
    };
    const first = await reservations.createHold(command);
    const replay = await reservations.createHold(command);
    const conflict = await reservations.createHold({
      ...command,
      seatId: seatIdAt(2),
      requestHash: hash('different'),
    });

    expect(replay).toMatchObject({ ...first, replayed: true });
    expect(conflict).toMatchObject({
      statusCode: 409,
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('enforces ownership and never confirms an expired hold', async () => {
    const userId = randomUUID();
    const created = await reservations.createHold({
      eventId,
      seatId: seatIdAt(3),
      userId,
      idempotencyKey: 'expiry-create',
      requestHash: hash('expiry-create'),
    });
    if (!('id' in created.body)) throw new Error('hold was not created');

    await expect(reservations.getHold(created.body.id, randomUUID())).rejects.toMatchObject({
      code: 'HOLD_FORBIDDEN',
    });
    await pool.query(
      `UPDATE holds
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [created.body.id],
    );
    const confirmation = await reservations.confirmHold({
      holdId: created.body.id,
      userId,
      idempotencyKey: 'expired-confirm',
      requestHash: hash('expired-confirm'),
    });

    expect(confirmation).toMatchObject({
      statusCode: 409,
      body: { code: 'HOLD_EXPIRED' },
    });
    const seat = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [
      seatIds[3],
    ]);
    expect(seat.rows[0]?.status).toBe('AVAILABLE');
  });

  it('serializes confirmation and cancellation without returning a sold seat to available', async () => {
    const userId = randomUUID();
    const created = await reservations.createHold({
      eventId,
      seatId: seatIdAt(4),
      userId,
      idempotencyKey: 'transition-create',
      requestHash: hash('transition-create'),
    });
    if (!('id' in created.body)) throw new Error('hold was not created');

    const [confirm, cancel] = await Promise.all([
      reservations.confirmHold({
        holdId: created.body.id,
        userId,
        idempotencyKey: 'transition-confirm',
        requestHash: hash('transition-confirm'),
      }),
      reservations.cancelHold({
        holdId: created.body.id,
        userId,
        idempotencyKey: 'transition-cancel',
        requestHash: hash('transition-cancel'),
      }),
    ]);
    const winner = [confirm, cancel].find(({ statusCode }) => statusCode === 200);
    expect(winner).toBeDefined();

    const state = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [
      seatIds[4],
    ]);
    expect(state.rows[0]?.status).toBe(
      winner && 'status' in winner.body && winner.body.status === 'CONFIRMED'
        ? 'SOLD'
        : 'AVAILABLE',
    );
  });

  it('serializes confirmation with expiration and keeps the seat consistent', async () => {
    const userId = randomUUID();
    const created = await reservations.createHold({
      eventId,
      seatId: seatIdAt(5),
      userId,
      idempotencyKey: 'expiry-race-create',
      requestHash: hash('expiry-race-create'),
    });
    if (!('id' in created.body)) throw new Error('hold was not created');
    await pool.query(
      `UPDATE holds
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 millisecond'
        WHERE id = $1`,
      [created.body.id],
    );

    const [confirmation, observed] = await Promise.all([
      reservations.confirmHold({
        holdId: created.body.id,
        userId,
        idempotencyKey: 'expiry-race-confirm',
        requestHash: hash('expiry-race-confirm'),
      }),
      reservations.getHold(created.body.id, userId),
    ]);

    expect(confirmation).toMatchObject({
      statusCode: 409,
      body: { code: 'HOLD_EXPIRED' },
    });
    expect(observed.status).toBe('EXPIRED');
    const state = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [
      seatIdAt(5),
    ]);
    expect(state.rows[0]?.status).toBe('AVAILABLE');
  });

  it('schedules the delayed expiration after creating a hold', async () => {
    const scheduler = new RecordingExpirationScheduler();
    const scheduledReservations = new PostgresReservations(pool, scheduler);
    const created = await scheduledReservations.createHold({
      eventId,
      seatId: seatIdAt(6),
      userId: randomUUID(),
      idempotencyKey: 'scheduled-create',
      requestHash: hash('scheduled-create'),
    });
    if (!('id' in created.body)) throw new Error('hold was not created');

    expect(scheduler.jobs).toEqual([
      {
        holdId: created.body.id,
        expectedExpiresAt: created.body.expiresAt,
      },
    ]);
  });
});

class RecordingExpirationScheduler implements HoldExpirationScheduler {
  readonly jobs: HoldExpirationJob[] = [];

  schedule(job: HoldExpirationJob): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
