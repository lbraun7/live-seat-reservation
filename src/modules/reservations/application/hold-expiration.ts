export const HOLD_EXPIRATION_QUEUE = 'hold-expiration';
export const HOLD_EXPIRATION_DEAD_LETTER_QUEUE = 'hold-expiration-dead-letter';

export interface HoldExpirationJob {
  holdId: string;
  expectedExpiresAt: string;
}

export interface HoldExpirationScheduler {
  schedule(job: HoldExpirationJob): Promise<void>;
}

export type ExpirationSource = 'delayed-job' | 'reconciler';

export interface ExpirationResult {
  holdId: string;
  expired: boolean;
  delayMs?: number;
  reason?: 'NOT_FOUND' | 'NOT_DUE' | 'ALREADY_TRANSITIONED' | 'STALE_JOB';
}

export interface HoldExpirationStore {
  expireHold(job: HoldExpirationJob): Promise<ExpirationResult>;
  reconcileExpiredHolds(batchSize: number): Promise<ExpirationResult[]>;
}
