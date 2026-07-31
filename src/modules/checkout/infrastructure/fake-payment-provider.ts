import { randomUUID } from 'node:crypto';

import type { PaymentProvider } from '../domain/checkout.js';

/** A deterministic-boundary fake: it creates references but never calls the application directly. */
export class FakePaymentProvider implements PaymentProvider {
  createPayment(): Promise<{ providerPaymentId: string }> {
    return Promise.resolve({ providerPaymentId: randomUUID() });
  }
}
