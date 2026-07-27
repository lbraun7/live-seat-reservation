import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresHoldExpirationStore } from '../../src/modules/reservations/infrastructure/postgres-hold-expiration.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('resilient PostgreSQL hold expiration', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresHoldExpirationStore(pool);
  const eventId = randomUUID();
  const sectionId = randomUUID();
  const seatIds = Array.from({ length: 4 }, () => randomUUID());

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO events (id, name, venue_name, starts_at, sales_start_at)
       VALUES ($1, 'Expiration test', 'Test venue', now() + interval '1 day', now())`,
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
         VALUES ($1, $2, $3, $4, 'E', $5)`,
        [seatId, eventId, sectionId, `E-${String(index + 1)}`, index + 1],
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM holds WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.end();
  });

  it('processes the same delayed job twice without an additional effect', async () => {
    const hold = await insertExpiredHold(seatAt(0));
    const job = { holdId: hold.id, expectedExpiresAt: hold.expiresAt.toISOString() };

    const first = await store.expireHold(job);
    const second = await store.expireHold(job);

    expect(first).toMatchObject({ expired: true });
    expect(first.delayMs).toBeGreaterThanOrEqual(0);
    expect(second).toEqual({
      holdId: hold.id,
      expired: false,
      reason: 'ALREADY_TRANSITIONED',
    });
    await expectSeatStatus(seatAt(0), 'AVAILABLE');
  });

  it('reconciles a hold whose delayed job was lost while the worker was offline', async () => {
    const hold = await insertExpiredHold(seatAt(1));

    const reconciled = await store.reconcileExpiredHolds(10);

    expect(reconciled).toEqual(
      expect.arrayContaining([expect.objectContaining({ holdId: hold.id, expired: true })]),
    );
    await expectSeatStatus(seatAt(1), 'AVAILABLE');
  });

  it('lets concurrent reconciler instances divide work with SKIP LOCKED', async () => {
    const first = await insertExpiredHold(seatAt(2));
    const second = await insertExpiredHold(seatAt(3));

    const batches = await Promise.all([
      store.reconcileExpiredHolds(1),
      store.reconcileExpiredHolds(1),
    ]);

    expect(
      batches
        .flat()
        .map(({ holdId }) => holdId)
        .sort(),
    ).toEqual([first.id, second.id].sort());
  });

  it('does not let an old job release a newer hold on the same seat', async () => {
    const seatId = seatAt(0);
    const old = await pool.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM holds WHERE seat_id = $1 ORDER BY created_at LIMIT 1`,
      [seatId],
    );
    const oldHold = required(old.rows[0]);
    const newHoldId = randomUUID();
    await pool.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);
    await pool.query(
      `INSERT INTO holds (id, event_id, seat_id, user_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
      [newHoldId, eventId, seatId, randomUUID()],
    );

    const result = await store.expireHold({
      holdId: oldHold.id,
      expectedExpiresAt: oldHold.expires_at.toISOString(),
    });

    expect(result).toMatchObject({ expired: false, reason: 'ALREADY_TRANSITIONED' });
    await expectSeatStatus(seatId, 'HELD');
    const newer = await pool.query<{ status: string }>('SELECT status FROM holds WHERE id = $1', [
      newHoldId,
    ]);
    expect(newer.rows[0]?.status).toBe('ACTIVE');
  });

  async function insertExpiredHold(seatId: string): Promise<{ id: string; expiresAt: Date }> {
    const id = randomUUID();
    await pool.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);
    const inserted = await pool.query<{ expires_at: Date }>(
      `INSERT INTO holds
         (id, event_id, seat_id, user_id, created_at, expires_at)
       VALUES
         ($1, $2, $3, $4, now() - interval '10 minutes', now() - interval '1 second')
       RETURNING expires_at`,
      [id, eventId, seatId, randomUUID()],
    );
    return { id, expiresAt: required(inserted.rows[0]).expires_at };
  }

  async function expectSeatStatus(seatId: string, expected: string): Promise<void> {
    const result = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [
      seatId,
    ]);
    expect(result.rows[0]?.status).toBe(expected);
  }

  function seatAt(index: number): string {
    return required(seatIds[index]);
  }
});

function required<T>(value: T | undefined): T {
  if (!value) throw new Error('expected test value');
  return value;
}
