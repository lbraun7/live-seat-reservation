import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/shared/config/config.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('loads defaults and coerces numeric values', () => {
    expect(loadConfig({ ...validEnvironment, PORT: '4000' })).toMatchObject({
      nodeEnv: 'test',
      host: '0.0.0.0',
      port: 4000,
      logLevel: 'info',
    });
  });

  it('reports all invalid values at startup', () => {
    expect(() => loadConfig({ NODE_ENV: 'invalid', PORT: 'zero' })).toThrow(
      /DATABASE_URL is required[\s\S]*REDIS_URL is required[\s\S]*NODE_ENV must be one of[\s\S]*PORT must be an integer/,
    );
  });
});
