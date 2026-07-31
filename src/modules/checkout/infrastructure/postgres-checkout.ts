import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { appendOutboxEvent } from '../../outbox/domain/outbox.js';
import {
  CheckoutError,
  type Checkout,
  type CheckoutResult,
  type IdempotentPaymentCommand,
  type Payment,
  type PaymentCommand,
  type PaymentProvider,
  type PaymentStatus,
  type PaymentWebhook,
  type StartCheckoutCommand,
} from '../domain/checkout.js';

interface PaymentRow {
  id: string;
  provider_payment_id: string;
  hold_id: string;
  user_id: string;
  status: PaymentStatus;
  created_at: Date;
  completed_at: Date | null;
  order_id: string | null;
  last_provider_occurred_at: Date | null;
}

interface IdempotencyRow {
  request_hash: string;
  response_status: number | null;
  response_body: CheckoutResult['body'] | null;
}

export class PostgresCheckout implements Checkout {
  constructor(
    private readonly pool: Pool,
    private readonly provider: PaymentProvider,
  ) {}

  start(command: StartCheckoutCommand): Promise<CheckoutResult> {
    return this.idempotent(command, 'start-checkout', async (client) => {
      const hold = await client.query<{ status: string; is_expired: boolean; user_id: string }>(
        'SELECT status, expires_at <= now() AS is_expired, user_id FROM holds WHERE id = $1 FOR UPDATE',
        [command.holdId],
      );
      if (!hold.rowCount) throw new CheckoutError('HOLD_NOT_FOUND', 'Hold not found', 404);
      const row = requireRow(hold.rows[0]);
      if (row.user_id !== command.userId)
        throw new CheckoutError('HOLD_FORBIDDEN', 'Hold belongs to another user', 403);
      if (row.status !== 'ACTIVE' || row.is_expired) {
        throw new CheckoutError(
          'HOLD_NOT_ACTIVE',
          'Checkout requires an active, unexpired hold',
          409,
        );
      }
      const existing = await client.query<PaymentRow>(`${paymentSelect} WHERE p.hold_id = $1`, [
        command.holdId,
      ]);
      if (existing.rowCount)
        return { statusCode: 200, body: mapPayment(requireRow(existing.rows[0])) };
      const provider = await this.provider.createPayment();
      const id = randomUUID();
      const inserted = await client.query<PaymentRow>(
        `INSERT INTO payments (id, provider_payment_id, hold_id, user_id)
         VALUES ($1, $2, $3, $4) RETURNING id, provider_payment_id, hold_id, user_id, status,
         created_at, completed_at, NULL::uuid AS order_id, last_provider_occurred_at`,
        [id, provider.providerPaymentId, command.holdId, command.userId],
      );
      await transition(client, id, null, 'PENDING', 'checkout_started');
      return { statusCode: 201, body: mapPayment(requireRow(inserted.rows[0])) };
    });
  }

  async get(paymentId: string, userId: string): Promise<Payment> {
    const result = await this.pool.query<PaymentRow>(`${paymentSelect} WHERE p.id = $1`, [
      paymentId,
    ]);
    if (!result.rowCount) throw new CheckoutError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    const payment = requireRow(result.rows[0]);
    if (payment.user_id !== userId)
      throw new CheckoutError('PAYMENT_FORBIDDEN', 'Payment belongs to another user', 403);
    return mapPayment(payment);
  }

  cancel(command: PaymentCommand): Promise<CheckoutResult> {
    return this.idempotent(command, 'cancel-payment', async (client) => ({
      statusCode: 200,
      body: await this.finishPending(
        client,
        command.paymentId,
        command.userId,
        'CANCELLED',
        'customer_cancelled',
      ),
    }));
  }

  async timeout(paymentId: string): Promise<Payment> {
    return this.transaction((client) =>
      this.finishPending(client, paymentId, undefined, 'TIMED_OUT', 'payment_timeout'),
    );
  }

  async handleWebhook(event: PaymentWebhook): Promise<{ duplicate: boolean; outcome: string }> {
    return this.transaction(async (client) => {
      const paymentResult = await client.query<PaymentRow>(
        `${paymentSelect} WHERE p.provider_payment_id = $1 FOR UPDATE OF p`,
        [event.providerPaymentId],
      );
      if (!paymentResult.rowCount)
        throw new CheckoutError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
      const payment = requireRow(paymentResult.rows[0]);
      const claimed = await client.query(
        `INSERT INTO payment_webhooks (provider_event_id, payment_id, event_type, occurred_at, payload, outcome)
         VALUES ($1, $2, $3, $4, $5, 'processing') ON CONFLICT DO NOTHING RETURNING provider_event_id`,
        [event.eventId, payment.id, event.type, event.occurredAt, event],
      );
      if (!claimed.rowCount) return { duplicate: true, outcome: 'duplicate' };
      const occurredAt = new Date(event.occurredAt);
      if (payment.last_provider_occurred_at && occurredAt <= payment.last_provider_occurred_at) {
        await this.recordOutcome(client, event.eventId, 'ignored_out_of_order');
        return { duplicate: false, outcome: 'ignored_out_of_order' };
      }
      let outcome = 'ignored_terminal';
      if (payment.status === 'PENDING' && event.type === 'payment.failed') {
        await this.finishPending(
          client,
          payment.id,
          undefined,
          'FAILED',
          'provider_failed',
          event.eventId,
          occurredAt,
        );
        outcome = 'payment_failed';
      } else if (payment.status === 'PENDING' && event.type === 'payment.succeeded') {
        outcome = await this.succeed(client, payment, event.eventId, occurredAt);
      } else if (event.type === 'payment.succeeded' && payment.status !== 'SUCCEEDED') {
        await client.query(
          `UPDATE payments SET status = 'LATE_SUCCEEDED', completed_at = now(), updated_at = now(), last_provider_occurred_at = $2 WHERE id = $1`,
          [payment.id, occurredAt],
        );
        await transition(
          client,
          payment.id,
          payment.status,
          'LATE_SUCCEEDED',
          'success_after_terminal_state',
          event.eventId,
        );
        outcome = 'late_success_requires_refund';
      }
      await this.recordOutcome(client, event.eventId, outcome);
      return { duplicate: false, outcome };
    });
  }

  private async succeed(
    client: PoolClient,
    payment: PaymentRow,
    eventId: string,
    occurredAt: Date,
  ): Promise<string> {
    const hold = await client.query<{
      event_id: string;
      seat_id: string;
      user_id: string;
      status: string;
      is_expired: boolean;
    }>(
      'SELECT event_id, seat_id, user_id, status, expires_at <= now() AS is_expired FROM holds WHERE id = $1 FOR UPDATE',
      [payment.hold_id],
    );
    const row = requireRow(hold.rows[0]);
    if (row.status !== 'ACTIVE' || row.is_expired) {
      if (row.status === 'ACTIVE') await expireHold(client, payment.hold_id, row.seat_id);
      await client.query(
        `UPDATE payments SET status = 'LATE_SUCCEEDED', completed_at = now(), updated_at = now(), last_provider_occurred_at = $2 WHERE id = $1`,
        [payment.id, occurredAt],
      );
      await transition(
        client,
        payment.id,
        'PENDING',
        'LATE_SUCCEEDED',
        'success_after_hold_expiration',
        eventId,
      );
      return 'late_success_requires_refund';
    }
    const orderId = randomUUID();
    await client.query(`UPDATE holds SET status = 'CONFIRMED', updated_at = now() WHERE id = $1`, [
      payment.hold_id,
    ]);
    await client.query(`UPDATE seats SET status = 'SOLD' WHERE id = $1 AND status = 'HELD'`, [
      row.seat_id,
    ]);
    await client.query(`INSERT INTO orders (id, hold_id, event_id, user_id) VALUES ($1,$2,$3,$4)`, [
      orderId,
      payment.hold_id,
      row.event_id,
      row.user_id,
    ]);
    await client.query(`INSERT INTO order_items (id, order_id, seat_id) VALUES ($1,$2,$3)`, [
      randomUUID(),
      orderId,
      row.seat_id,
    ]);
    await client.query(
      `UPDATE payments SET status = 'SUCCEEDED', completed_at = now(), updated_at = now(), last_provider_occurred_at = $2 WHERE id = $1`,
      [payment.id, occurredAt],
    );
    await transition(client, payment.id, 'PENDING', 'SUCCEEDED', 'provider_succeeded', eventId);
    await appendOutboxEvent(client, {
      aggregateType: 'hold',
      aggregateId: payment.hold_id,
      eventType: 'hold.confirmed',
      payload: { holdId: payment.hold_id, seatId: row.seat_id, orderId },
    });
    return 'order_confirmed';
  }

  private async finishPending(
    client: PoolClient,
    paymentId: string,
    userId: string | undefined,
    status: 'FAILED' | 'CANCELLED' | 'TIMED_OUT',
    reason: string,
    eventId?: string,
    providerOccurredAt?: Date,
  ): Promise<Payment> {
    const result = await client.query<PaymentRow>(
      `${paymentSelect} WHERE p.id = $1 FOR UPDATE OF p`,
      [paymentId],
    );
    if (!result.rowCount) throw new CheckoutError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    const payment = requireRow(result.rows[0]);
    if (userId && payment.user_id !== userId)
      throw new CheckoutError('PAYMENT_FORBIDDEN', 'Payment belongs to another user', 403);
    if (payment.status !== 'PENDING')
      throw new CheckoutError('PAYMENT_NOT_PENDING', 'Payment is no longer pending', 409);
    const hold = await client.query<{ seat_id: string; status: string }>(
      'SELECT seat_id, status FROM holds WHERE id = $1 FOR UPDATE',
      [payment.hold_id],
    );
    await client.query(
      `UPDATE payments SET status = $2, completed_at = now(), updated_at = now(), last_provider_occurred_at = COALESCE($3,last_provider_occurred_at) WHERE id = $1`,
      [payment.id, status, providerOccurredAt ?? null],
    );
    if (hold.rows[0]?.status === 'ACTIVE') {
      await client.query(
        `UPDATE holds SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
        [payment.hold_id],
      );
      await client.query(
        `UPDATE seats SET status = 'AVAILABLE' WHERE id = $1 AND status = 'HELD'`,
        [hold.rows[0].seat_id],
      );
    }
    await transition(client, payment.id, 'PENDING', status, reason, eventId);
    payment.status = status;
    payment.completed_at = new Date();
    return mapPayment(payment);
  }

  private async recordOutcome(client: PoolClient, eventId: string, outcome: string): Promise<void> {
    await client.query('UPDATE payment_webhooks SET outcome = $2 WHERE provider_event_id = $1', [
      eventId,
      outcome,
    ]);
  }

  private idempotent(
    command: IdempotentPaymentCommand,
    operation: string,
    work: (client: PoolClient) => Promise<CheckoutResult>,
  ): Promise<CheckoutResult> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO idempotency_keys (user_id, operation, idempotency_key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [command.userId, operation, command.idempotencyKey, command.requestHash],
      );
      const stored = await client.query<IdempotencyRow>(
        `SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE`,
        [command.userId, operation, command.idempotencyKey],
      );
      const prior = requireRow(stored.rows[0]);
      if (prior.request_hash !== command.requestHash)
        return {
          statusCode: 409,
          body: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was already used with a different request',
          },
        };
      if (prior.response_status !== null && prior.response_body !== null)
        return { statusCode: prior.response_status, body: prior.response_body, replayed: true };
      await client.query('SAVEPOINT checkout_operation');
      let result: CheckoutResult;
      try {
        result = await work(client);
      } catch (error) {
        if (!(error instanceof CheckoutError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT checkout_operation');
        result = {
          statusCode: error.statusCode,
          body: { code: error.code, message: error.message },
        };
      }
      await client.query(
        `UPDATE idempotency_keys SET response_status=$4,response_body=$5,completed_at=now() WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3`,
        [command.userId, operation, command.idempotencyKey, result.statusCode, result.body],
      );
      return result;
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const paymentSelect = `SELECT p.id,p.provider_payment_id,p.hold_id,p.user_id,p.status,p.created_at,p.completed_at,p.last_provider_occurred_at,o.id AS order_id FROM payments p LEFT JOIN orders o ON o.hold_id=p.hold_id`;
function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    providerPaymentId: row.provider_payment_id,
    holdId: row.hold_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.order_id ? { orderId: row.order_id } : {}),
  };
}
async function transition(
  client: PoolClient,
  paymentId: string,
  from: PaymentStatus | null,
  to: PaymentStatus,
  reason: string,
  providerEventId?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO payment_transitions (id,payment_id,from_status,to_status,reason,provider_event_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), paymentId, from, to, reason, providerEventId ?? null],
  );
}
async function expireHold(client: PoolClient, holdId: string, seatId: string): Promise<void> {
  await client.query(
    `UPDATE holds SET status='EXPIRED',expired_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'`,
    [holdId],
  );
  await client.query(`UPDATE seats SET status='AVAILABLE' WHERE id=$1 AND status='HELD'`, [seatId]);
}
function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected database row was not returned');
  return row;
}
