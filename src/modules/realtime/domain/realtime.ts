import type { DomainEvent } from '../../outbox/domain/outbox.js';

export interface SeatRealtimeEvent {
  type: 'seat.updated';
  eventId: string;
  messageId: string;
  seatId: string;
  version: number;
  occurredAt: string;
  status: 'AVAILABLE' | 'HELD' | 'SOLD';
}

export function toSeatRealtimeEvent(event: DomainEvent): SeatRealtimeEvent | null {
  const eventId = event.eventIdRef;
  const status = event.payload.seatStatus;
  if (
    !eventId ||
    !event.seatId ||
    event.version === undefined ||
    !Number.isSafeInteger(event.version) ||
    event.version < 1 ||
    (status !== 'AVAILABLE' && status !== 'HELD' && status !== 'SOLD') ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    return null;
  }
  return {
    type: 'seat.updated',
    eventId,
    messageId: event.eventId,
    seatId: event.seatId,
    version: event.version,
    occurredAt: event.occurredAt,
    status,
  };
}

export function isSlowClient(bufferedAmount: number, maxBufferedBytes: number): boolean {
  return bufferedAmount > maxBufferedBytes;
}

export type VersionDecision = 'ACCEPT' | 'DUPLICATE' | 'GAP';

export function classifyVersion(current: number, incoming: number): VersionDecision {
  if (incoming <= current) return 'DUPLICATE';
  return incoming === current + 1 ? 'ACCEPT' : 'GAP';
}
