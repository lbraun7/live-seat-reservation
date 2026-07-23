export interface EventSummary {
  id: string;
  name: string;
  venueName: string;
  startsAt: string;
  salesStartAt: string;
  mapVersion: number;
  sections: SeatSection[];
}

export interface SeatSection {
  id: string;
  name: string;
  displayOrder: number;
  seatCount: number;
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';

export interface SeatSnapshotItem {
  id: string;
  sectionId: string;
  label: string;
  row: string;
  number: number;
  status: SeatStatus;
  version: number;
}

export interface SeatMapSnapshot {
  eventId: string;
  version: number;
  sectionId: string;
  seats: SeatSnapshotItem[];
  page: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface SeatSnapshotQuery {
  sectionId: string;
  limit: number;
  cursor?: string;
}

export interface Catalog {
  findEvent(eventId: string): Promise<EventSummary | null>;
  getSeatMapSnapshot(eventId: string, query: SeatSnapshotQuery): Promise<SeatMapSnapshot | null>;
}
