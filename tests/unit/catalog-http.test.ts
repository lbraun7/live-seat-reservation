import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/apps/api/app.js';
import type { AppConfig } from '../../src/shared/config/config.js';
import type { Catalog } from '../../src/modules/catalog/domain/catalog.js';

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
  holdExpirationJobAttempts: 5,
  holdExpirationBackoffMs: 1000,
  holdReconcilerIntervalMs: 5000,
  holdReconcilerBatchSize: 100,
};

const dependencies = {
  check: vi.fn().mockResolvedValue({ database: true, redis: true }),
  close: vi.fn().mockResolvedValue(undefined),
};

const eventId = '10000000-0000-4000-8000-000000000001';
const sectionId = '20000000-0000-4000-8000-000000000001';

function catalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    findEvent: vi.fn().mockResolvedValue({
      id: eventId,
      name: 'Flash Sale Live',
      venueName: 'Arena Principal',
      startsAt: '2027-01-23T22:00:00.000Z',
      salesStartAt: '2026-07-23T12:00:00.000Z',
      mapVersion: 1,
      sections: [{ id: sectionId, name: 'Pista', displayOrder: 0, seatCount: 1000 }],
    }),
    getSeatMapSnapshot: vi.fn().mockResolvedValue({
      eventId,
      version: 3,
      sectionId,
      seats: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          sectionId,
          label: 'A-1',
          row: 'A',
          number: 1,
          status: 'AVAILABLE',
          version: 1,
        },
      ],
      page: { limit: 200, nextCursor: null },
    }),
    ...overrides,
  };
}

describe('catalog HTTP contracts', () => {
  it('returns event metadata and its sections', async () => {
    const app = buildApp({ config, dependencies, catalog: catalog() });
    const response = await app.inject({ method: 'GET', url: `/events/${eventId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: eventId, mapVersion: 1 });
    await app.close();
  });

  it('returns a versioned seat page and applies the default limit', async () => {
    const getSeatMapSnapshot = vi.fn<Catalog['getSeatMapSnapshot']>().mockResolvedValue({
      eventId,
      version: 3,
      sectionId,
      seats: [],
      page: { limit: 200, nextCursor: null },
    });
    const repository = catalog({ getSeatMapSnapshot });
    const app = buildApp({ config, dependencies, catalog: repository });
    const response = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/seats?sectionId=${sectionId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      version: 3,
      page: { limit: 200, nextCursor: null },
    });
    expect(getSeatMapSnapshot).toHaveBeenCalledWith(eventId, {
      sectionId,
      limit: 200,
    });
    await app.close();
  });

  it('rejects invalid identifiers and pagination limits before the handler', async () => {
    const app = buildApp({ config, dependencies, catalog: catalog() });
    const response = await app.inject({
      method: 'GET',
      url: `/events/not-a-uuid/seats?sectionId=${sectionId}&limit=501`,
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns a stable not-found error', async () => {
    const app = buildApp({
      config,
      dependencies,
      catalog: catalog({ findEvent: vi.fn().mockResolvedValue(null) }),
    });
    const response = await app.inject({ method: 'GET', url: `/events/${eventId}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
    await app.close();
  });
});
