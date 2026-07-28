CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) > 0),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text,
  published_at timestamptz,
  archived_at timestamptz,
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (published_at IS NULL OR last_attempt_at IS NOT NULL)
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at, occurred_at, id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_events_published_idx
  ON outbox_events (published_at)
  WHERE published_at IS NOT NULL AND archived_at IS NULL;

CREATE TABLE consumed_events (
  consumer_name text NOT NULL CHECK (length(consumer_name) > 0),
  event_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
