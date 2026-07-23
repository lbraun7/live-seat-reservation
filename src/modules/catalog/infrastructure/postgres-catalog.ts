import type { Pool, PoolClient } from 'pg';

import type {
  Catalog,
  EventSummary,
  SeatMapSnapshot,
  SeatSnapshotItem,
  SeatSnapshotQuery,
} from '../domain/catalog.js';

interface EventRow {
  id: string;
  name: string;
  venue_name: string;
  starts_at: Date;
  sales_start_at: Date;
  map_version: string;
}

interface SectionRow {
  id: string;
  name: string;
  display_order: number;
  seat_count: string;
}

interface SeatRow {
  id: string;
  section_id: string;
  seat_label: string;
  row_label: string;
  seat_number: number;
  status: SeatSnapshotItem['status'];
  state_version: string;
}

export class PostgresCatalog implements Catalog {
  constructor(private readonly pool: Pool) {}

  async findEvent(eventId: string): Promise<EventSummary | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const event = await this.selectEvent(client, eventId);
      if (!event) {
        await client.query('COMMIT');
        return null;
      }
      const sections = await client.query<SectionRow>(
        `SELECT ss.id, ss.name, ss.display_order, count(s.id)::text AS seat_count
           FROM seat_sections ss
           LEFT JOIN seats s ON s.section_id = ss.id
          WHERE ss.event_id = $1
          GROUP BY ss.id, ss.name, ss.display_order
          ORDER BY ss.display_order`,
        [eventId],
      );
      await client.query('COMMIT');
      return {
        id: event.id,
        name: event.name,
        venueName: event.venue_name,
        startsAt: event.starts_at.toISOString(),
        salesStartAt: event.sales_start_at.toISOString(),
        mapVersion: Number(event.map_version),
        sections: sections.rows.map((section) => ({
          id: section.id,
          name: section.name,
          displayOrder: section.display_order,
          seatCount: Number(section.seat_count),
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getSeatMapSnapshot(
    eventId: string,
    query: SeatSnapshotQuery,
  ): Promise<SeatMapSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const event = await this.selectEvent(client, eventId);
      if (!event) {
        await client.query('COMMIT');
        return null;
      }

      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const result = await client.query<SeatRow>(
        `SELECT id, section_id, seat_label, row_label, seat_number, status, state_version
           FROM seats
          WHERE event_id = $1
            AND section_id = $2
            AND ($3::text IS NULL OR (row_label, seat_number, id) > ($3, $4, $5::uuid))
          ORDER BY row_label, seat_number, id
          LIMIT $6`,
        [
          eventId,
          query.sectionId,
          cursor?.row ?? null,
          cursor?.number ?? 0,
          cursor?.id ?? '00000000-0000-0000-0000-000000000000',
          query.limit + 1,
        ],
      );
      await client.query('COMMIT');

      const hasMore = result.rows.length > query.limit;
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      return {
        eventId,
        version: Number(event.map_version),
        sectionId: query.sectionId,
        seats: rows.map((seat) => ({
          id: seat.id,
          sectionId: seat.section_id,
          label: seat.seat_label,
          row: seat.row_label,
          number: seat.seat_number,
          status: seat.status,
          version: Number(seat.state_version),
        })),
        page: {
          limit: query.limit,
          nextCursor: hasMore && last ? encodeCursor(last) : null,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectEvent(client: PoolClient, eventId: string): Promise<EventRow | null> {
    const result = await client.query<EventRow>(
      `SELECT id, name, venue_name, starts_at, sales_start_at, map_version
         FROM events
        WHERE id = $1`,
      [eventId],
    );
    return result.rows[0] ?? null;
  }
}

interface CursorValue {
  row: string;
  number: number;
  id: string;
}

function encodeCursor(seat: SeatRow): string {
  return Buffer.from(
    JSON.stringify({ row: seat.row_label, number: seat.seat_number, id: seat.id }),
  ).toString('base64url');
}

function decodeCursor(value: string): CursorValue {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('row' in parsed) ||
      typeof parsed.row !== 'string' ||
      parsed.row.length === 0 ||
      !('number' in parsed) ||
      typeof parsed.number !== 'number' ||
      !Number.isInteger(parsed.number) ||
      parsed.number < 1 ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as CursorValue;
  } catch {
    throw new Error('invalid cursor');
  }
}
