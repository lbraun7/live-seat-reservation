CREATE TABLE events (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  venue_name text NOT NULL CHECK (length(trim(venue_name)) > 0),
  starts_at timestamptz NOT NULL,
  sales_start_at timestamptz NOT NULL,
  map_version bigint NOT NULL DEFAULT 1 CHECK (map_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seat_sections (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, name),
  UNIQUE (event_id, display_order),
  UNIQUE (id, event_id)
);

CREATE TYPE seat_status AS ENUM ('AVAILABLE', 'HELD', 'SOLD');

CREATE TABLE seats (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id uuid NOT NULL,
  seat_label text NOT NULL CHECK (length(trim(seat_label)) > 0),
  row_label text NOT NULL CHECK (length(trim(row_label)) > 0),
  seat_number integer NOT NULL CHECK (seat_number > 0),
  status seat_status NOT NULL DEFAULT 'AVAILABLE',
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (section_id, event_id)
    REFERENCES seat_sections(id, event_id)
    ON DELETE CASCADE,
  UNIQUE (event_id, seat_label),
  UNIQUE (section_id, row_label, seat_number)
);

CREATE INDEX seats_snapshot_idx
  ON seats (event_id, section_id, row_label, seat_number, id);

CREATE FUNCTION publish_seat_state_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  published_version bigint;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE events
       SET map_version = map_version + 1,
           updated_at = now()
     WHERE id = NEW.event_id
     RETURNING map_version INTO published_version;

    NEW.state_version := published_version;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER seats_publish_state_change
BEFORE UPDATE OF status ON seats
FOR EACH ROW
EXECUTE FUNCTION publish_seat_state_change();
