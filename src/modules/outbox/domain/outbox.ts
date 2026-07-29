import type { PoolClient } from 'pg';

export const OUTBOX_CHANNEL = 'reservation.domain-events';

export interface DomainEvent {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  eventIdRef?: string;
  seatId?: string;
  version?: number;
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
     SELECT gen_random_uuid(), $1, $2, $3,
            $4::jsonb || CASE
              WHEN s.id IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'eventId', s.event_id,
                'seatId', s.id,
                'version', s.state_version,
                'seatStatus', s.status
              )
            END
       FROM (SELECT 1) AS singleton
       LEFT JOIN seats s ON s.id = NULLIF($4::jsonb ->> 'seatId', '')::uuid`,
    [event.aggregateType, event.aggregateId, event.eventType, event.payload],
  );
}
