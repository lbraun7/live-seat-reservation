import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/apps/api/app.js';
import type { AppConfig } from '../../src/shared/config/config.js';
import type { HealthDependencies } from '../../src/shared/health/dependencies.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  redisUrl: 'redis://unused',
  databaseConnectionTimeoutMs: 100,
  redisConnectionTimeoutMs: 100,
  shutdownTimeoutMs: 1000,
};

function dependencies(database: boolean, redis: boolean): HealthDependencies {
  return {
    check: vi.fn().mockResolvedValue({ database, redis }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('health endpoints', () => {
  it('returns liveness without checking external services and propagates correlation ID', async () => {
    const external = dependencies(false, false);
    const app = buildApp({ config, dependencies: external });
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'test-request-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-correlation-id']).toBe('test-request-123');
    // The mock is intentionally inspected without invoking the interface method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(external.check).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns ready only when PostgreSQL and Redis are available', async () => {
    const app = buildApp({ config, dependencies: dependencies(true, true) });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { database: true, redis: true },
    });
    await app.close();
  });

  it('returns 503 with individual dependency status', async () => {
    const app = buildApp({ config, dependencies: dependencies(true, false) });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { database: true, redis: false },
    });
    await app.close();
  });
});
