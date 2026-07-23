import { loadConfig } from '../../shared/config/config.js';
import { createDatabasePool } from '../../shared/database/client.js';

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const SECTION_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
] as const;

const pool = createDatabasePool(loadConfig());
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO events (id, name, venue_name, starts_at, sales_start_at)
     VALUES ($1, 'Flash Sale Live', 'Arena Principal', '2027-01-23T22:00:00Z', now())
     ON CONFLICT (id) DO NOTHING`,
    [EVENT_ID],
  );

  const sections = [
    [SECTION_IDS[0], 'Pista', 0],
    [SECTION_IDS[1], 'Arquibancada A', 1],
    [SECTION_IDS[2], 'Arquibancada B', 2],
  ] as const;
  for (const [id, name, order] of sections) {
    await client.query(
      `INSERT INTO seat_sections (id, event_id, name, display_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, EVENT_ID, name, order],
    );
  }

  for (const [sectionIndex, sectionId] of SECTION_IDS.entries()) {
    await client.query(
      `INSERT INTO seats (id, event_id, section_id, seat_label, row_label, seat_number)
       SELECT (
                substr(md5($1::text || '-' || row_number::text || '-' || seat_number::text), 1, 8)
                || '-' || substr(md5($1::text || '-' || row_number::text || '-' || seat_number::text), 9, 4)
                || '-4' || substr(md5($1::text || '-' || row_number::text || '-' || seat_number::text), 14, 3)
                || '-8' || substr(md5($1::text || '-' || row_number::text || '-' || seat_number::text), 18, 3)
                || '-' || substr(md5($1::text || '-' || row_number::text || '-' || seat_number::text), 21, 12)
              )::uuid,
              $2::uuid,
              $1::uuid,
              $3 || '-' || chr(64 + row_number) || '-' || seat_number,
              chr(64 + row_number),
              seat_number
         FROM generate_series(1, 20) AS row_number
        CROSS JOIN generate_series(1, 50) AS seat_number
       ON CONFLICT (event_id, seat_label) DO NOTHING`,
      [sectionId, EVENT_ID, `S${String(sectionIndex + 1)}`],
    );
    console.log(`Seeded section ${String(sectionIndex + 1)}/${String(SECTION_IDS.length)}`);
  }
  await client.query('COMMIT');
  console.log(`Seed complete: event ${EVENT_ID}, 3 sections, 3000 seats`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
