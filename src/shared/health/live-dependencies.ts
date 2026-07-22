import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import type { DependencyHealth, HealthDependencies } from './dependencies.js';

export class LiveHealthDependencies implements HealthDependencies {
  public constructor(
    private readonly database: Pool,
    private readonly redis: Redis,
  ) {}

  public async check(): Promise<DependencyHealth> {
    const [database, redis] = await Promise.allSettled([
      this.database.query('SELECT 1'),
      this.ensureRedisConnected(),
    ]);
    return { database: database.status === 'fulfilled', redis: redis.status === 'fulfilled' };
  }

  private async ensureRedisConnected(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    await this.redis.ping();
  }

  public async close(): Promise<void> {
    await Promise.allSettled([this.database.end(), this.closeRedis()]);
  }

  private async closeRedis(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') return;
    await this.redis.quit();
  }
}
