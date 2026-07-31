import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCheckout } from '../../src/modules/checkout/infrastructure/postgres-checkout.js';
import { FakePaymentProvider } from '../../src/modules/checkout/infrastructure/fake-payment-provider.js';
import { PostgresReservations } from '../../src/modules/reservations/infrastructure/postgres-reservations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('checkout and payment invariants', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const checkout = new PostgresCheckout(pool, new FakePaymentProvider());
  const reservations = new PostgresReservations(pool);
  const eventId = randomUUID();
  const sectionId = randomUUID();
  const userId = randomUUID();
  const seatIds = Array.from({ length: 4 }, () => randomUUID());

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO events (id,name,venue_name,starts_at,sales_start_at) VALUES ($1,'Checkout test','Test',now()+interval '1 day',now())`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO seat_sections (id,event_id,name,display_order) VALUES ($1,$2,'Test',0)`,
      [sectionId, eventId],
    );
    for (const [index, seatId] of seatIds.entries())
      await pool.query(
        `INSERT INTO seats (id,event_id,section_id,seat_label,row_label,seat_number) VALUES ($1,$2,$3,$4,'A',$5)`,
        [seatId, eventId, sectionId, `P-${String(index)}`, index + 1],
      );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM idempotency_keys WHERE user_id=$1`, [userId]);
    await pool.query(
      `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)`,
      [eventId],
    );
    await pool.query(
      `DELETE FROM payment_webhooks WHERE payment_id IN (SELECT id FROM payments WHERE user_id=$1)`,
      [userId],
    );
    await pool.query(
      `DELETE FROM payment_transitions WHERE payment_id IN (SELECT id FROM payments WHERE user_id=$1)`,
      [userId],
    );
    await pool.query(`DELETE FROM payments WHERE user_id=$1`, [userId]);
    await pool.query(`DELETE FROM orders WHERE event_id=$1`, [eventId]);
    await pool.query(`DELETE FROM holds WHERE event_id=$1`, [eventId]);
    await pool.query(`DELETE FROM events WHERE id=$1`, [eventId]);
    await pool.end();
  });

  async function payment(index: number) {
    const seatId = seatIds[index];
    if (!seatId) throw new Error('test seat not found');
    const created = await reservations.createHold({
      eventId,
      seatId,
      userId,
      idempotencyKey: `hold-${String(index)}`,
      requestHash: hash(`hold-${String(index)}`),
    });
    if (!('id' in created.body)) throw new Error('hold not created');
    const command = {
      holdId: created.body.id,
      userId,
      idempotencyKey: `checkout-${String(index)}`,
      requestHash: hash(`checkout-${String(index)}`),
    };
    const started = await checkout.start(command);
    if (!('providerPaymentId' in started.body)) throw new Error('checkout not started');
    return { hold: created.body, payment: started.body, command };
  }

  it('replays checkout and a duplicate webhook creates exactly one order', async () => {
    const data = await payment(0);
    expect(await checkout.start(data.command)).toMatchObject({
      replayed: true,
      body: { id: data.payment.id },
    });
    const event = {
      eventId: randomUUID(),
      providerPaymentId: data.payment.providerPaymentId,
      type: 'payment.succeeded' as const,
      occurredAt: new Date().toISOString(),
    };
    expect(await checkout.handleWebhook(event)).toMatchObject({
      duplicate: false,
      outcome: 'order_confirmed',
    });
    expect(await checkout.handleWebhook(event)).toMatchObject({ duplicate: true });
    const orders = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM orders WHERE hold_id=$1',
      [data.hold.id],
    );
    expect(orders.rows[0]?.count).toBe('1');
  });

  it('does not sell a seat after payment failure and ignores an older callback', async () => {
    const data = await payment(1);
    const failureTime = new Date();
    await checkout.handleWebhook({
      eventId: randomUUID(),
      providerPaymentId: data.payment.providerPaymentId,
      type: 'payment.failed',
      occurredAt: failureTime.toISOString(),
    });
    const old = await checkout.handleWebhook({
      eventId: randomUUID(),
      providerPaymentId: data.payment.providerPaymentId,
      type: 'payment.succeeded',
      occurredAt: new Date(failureTime.getTime() - 1000).toISOString(),
    });
    expect(old.outcome).toBe('ignored_out_of_order');
    const seat = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id=$1', [
      data.hold.seatId,
    ]);
    expect(seat.rows[0]?.status).toBe('AVAILABLE');
  });

  it('marks a success after expiration for refund without selling the seat', async () => {
    const data = await payment(2);
    await pool.query(
      `UPDATE holds SET created_at=now()-interval '10 minutes',expires_at=now()-interval '1 second' WHERE id=$1`,
      [data.hold.id],
    );
    const result = await checkout.handleWebhook({
      eventId: randomUUID(),
      providerPaymentId: data.payment.providerPaymentId,
      type: 'payment.succeeded',
      occurredAt: new Date().toISOString(),
    });
    expect(result.outcome).toBe('late_success_requires_refund');
    const latePayment = await checkout.get(data.payment.id, userId);
    expect(latePayment.status).toBe('LATE_SUCCEEDED');
    expect(latePayment).not.toHaveProperty('orderId');
    const seat = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id=$1', [
      data.hold.seatId,
    ]);
    expect(seat.rows[0]?.status).toBe('AVAILABLE');
  });

  it('cancels a pending payment idempotently without creating an order', async () => {
    const data = await payment(3);
    const command = {
      paymentId: data.payment.id,
      userId,
      idempotencyKey: 'cancel-payment',
      requestHash: hash('cancel-payment'),
    };
    expect(await checkout.cancel(command)).toMatchObject({
      statusCode: 200,
      body: { status: 'CANCELLED' },
    });
    expect(await checkout.cancel(command)).toMatchObject({
      replayed: true,
      body: { status: 'CANCELLED' },
    });
  });
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
