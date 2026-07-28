import type { PoolClient } from 'pg';

export const OUTBOX_CHANNEL = 'reservation.domain-events';

export interface DomainEvent {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface OutboxPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export async function appendOutboxEvent(
  client: PoolClient,
  event: Omit<DomainEvent, 'eventId' | 'occurredAt'>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events
       (id, aggregate_type, aggregate_id, event_type, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [event.aggregateType, event.aggregateId, event.eventType, event.payload],
  );
}
