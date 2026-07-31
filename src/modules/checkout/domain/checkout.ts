export type PaymentStatus =
  'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LATE_SUCCEEDED';

export interface Payment {
  id: string;
  providerPaymentId: string;
  holdId: string;
  userId: string;
  status: PaymentStatus;
  createdAt: string;
  completedAt?: string;
  orderId?: string;
}

export interface CheckoutResult {
  statusCode: number;
  body: Payment | { code: string; message: string };
  replayed?: boolean;
}

export interface IdempotentPaymentCommand {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface StartCheckoutCommand extends IdempotentPaymentCommand {
  holdId: string;
}

export interface PaymentCommand extends IdempotentPaymentCommand {
  paymentId: string;
}

export interface PaymentWebhook {
  eventId: string;
  providerPaymentId: string;
  type: 'payment.succeeded' | 'payment.failed';
  occurredAt: string;
}

export class CheckoutError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  createPayment(): Promise<{ providerPaymentId: string }>;
}

export interface Checkout {
  start(command: StartCheckoutCommand): Promise<CheckoutResult>;
  get(paymentId: string, userId: string): Promise<Payment>;
  cancel(command: PaymentCommand): Promise<CheckoutResult>;
  timeout(paymentId: string): Promise<Payment>;
  handleWebhook(event: PaymentWebhook): Promise<{ duplicate: boolean; outcome: string }>;
}
