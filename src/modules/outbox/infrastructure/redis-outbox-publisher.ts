import type { Redis } from 'ioredis';

import { OUTBOX_CHANNEL, type DomainEvent, type OutboxPublisher } from '../domain/outbox.js';

export class RedisOutboxPublisher implements OutboxPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(event: DomainEvent): Promise<void> {
    await this.redis.publish(OUTBOX_CHANNEL, JSON.stringify(event));
  }
}
