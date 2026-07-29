import { describe, expect, it, vi } from 'vitest';

import {
  classifyVersion,
  isSlowClient,
  toSeatRealtimeEvent,
} from '../../src/modules/realtime/domain/realtime.js';
import type { DomainEvent } from '../../src/modules/outbox/domain/outbox.js';

const domainEvent: DomainEvent = {
  eventId: '50000000-0000-4000-8000-000000000001',
  eventType: 'hold.created',
  aggregateType: 'hold',
  aggregateId: '60000000-0000-4000-8000-000000000001',
  occurredAt: '2026-01-01T00:00:00.000Z',
  eventIdRef: '10000000-0000-4000-8000-000000000001',
  seatId: '30000000-0000-4000-8000-000000000001',
  version: 2,
  payload: { seatStatus: 'HELD' },
};

describe('realtime event stream', () => {
  it('maps the outbox envelope to the public seat update contract', () => {
    expect(toSeatRealtimeEvent(domainEvent)).toEqual({
      type: 'seat.updated',
      eventId: domainEvent.eventIdRef,
      messageId: domainEvent.eventId,
      seatId: domainEvent.seatId,
      version: 2,
      occurredAt: domainEvent.occurredAt,
      status: 'HELD',
    });
  });

  it('ignores duplicates and detects version gaps', () => {
    const event = toSeatRealtimeEvent(domainEvent);
    if (!event) throw new Error('test fixture must be a valid realtime event');

    expect(classifyVersion(1, event.version)).toBe('ACCEPT');
    expect(classifyVersion(2, event.version)).toBe('DUPLICATE');
    expect(classifyVersion(2, 4)).toBe('GAP');
  });

  it('rejects an event without complete seat version metadata', () => {
    const withoutVersion: DomainEvent = {
      eventId: domainEvent.eventId,
      eventType: domainEvent.eventType,
      aggregateType: domainEvent.aggregateType,
      aggregateId: domainEvent.aggregateId,
      occurredAt: domainEvent.occurredAt,
      eventIdRef: '10000000-0000-4000-8000-000000000001',
      seatId: '30000000-0000-4000-8000-000000000001',
      payload: domainEvent.payload,
    };
    expect(toSeatRealtimeEvent(withoutVersion)).toBeNull();
    expect(toSeatRealtimeEvent({ ...domainEvent, payload: {} })).toBeNull();
  });

  it('identifies a slow client before its buffer can grow without limit', () => {
    const close = vi.fn();
    const client = { readyState: 1, bufferedAmount: 2048, close, send: vi.fn() };
    const maxBufferedBytes = 1024;
    if (client.readyState === 1 && isSlowClient(client.bufferedAmount, maxBufferedBytes)) {
      client.close(1013, 'client too slow');
    }
    expect(close).toHaveBeenCalledWith(1013, 'client too slow');
    expect(client.send).not.toHaveBeenCalled();
  });
});
