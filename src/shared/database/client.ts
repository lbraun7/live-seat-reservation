import { Pool } from 'pg';

import type { AppConfig } from '../config/config.js';

export function createDatabasePool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    max: 10,
    application_name: 'live-seat-reservation-api',
  });
}
