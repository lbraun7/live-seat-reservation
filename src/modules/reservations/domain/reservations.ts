export const reservationErrorCodes = [
  'EVENT_NOT_FOUND',
  'SEAT_NOT_FOUND',
  'SEAT_UNAVAILABLE',
  'HOLD_NOT_FOUND',
  'HOLD_FORBIDDEN',
  'HOLD_NOT_ACTIVE',
  'HOLD_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
] as const;

export type ReservationErrorCode = (typeof reservationErrorCodes)[number];
export type HoldStatus = 'ACTIVE' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface Hold {
  id: string;
  eventId: string;
  seatId: string;
  userId: string;
  status: HoldStatus;
  expiresAt: string;
  createdAt: string;
  orderId?: string;
}

export interface ReservationResult {
  statusCode: number;
  body: Hold | { code: ReservationErrorCode; message: string };
  replayed?: boolean;
}

export interface IdempotentCommand {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateHoldCommand extends IdempotentCommand {
  eventId: string;
  seatId: string;
}

export interface HoldCommand extends IdempotentCommand {
  holdId: string;
}

export class ReservationError extends Error {
  constructor(
    readonly code: ReservationErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface Reservations {
  createHold(command: CreateHoldCommand): Promise<ReservationResult>;
  getHold(holdId: string, userId: string): Promise<Hold>;
  cancelHold(command: HoldCommand): Promise<ReservationResult>;
  confirmHold(command: HoldCommand): Promise<ReservationResult>;
}
