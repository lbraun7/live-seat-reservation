import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../config/config.js';
import { createDatabasePool } from './client.js';

const MIGRATION_LOCK_ID = 1_276_584_377;

async function migrate(): Promise<void> {
  const pool = createDatabasePool(loadConfig());
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const directory = resolve(process.cwd(), 'migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const appliedResult = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(appliedResult.rows.map(({ version }) => version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

await migrate();
