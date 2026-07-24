CREATE TYPE hold_status AS ENUM ('ACTIVE', 'CONFIRMED', 'CANCELLED', 'EXPIRED');
CREATE TYPE order_status AS ENUM ('CONFIRMED');

CREATE TABLE holds (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  seat_id uuid NOT NULL REFERENCES seats(id),
  user_id uuid NOT NULL,
  status hold_status NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX holds_one_active_per_seat
  ON holds (seat_id)
  WHERE status = 'ACTIVE';
CREATE INDEX holds_user_idx ON holds (user_id, created_at DESC);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(id),
  event_id uuid NOT NULL REFERENCES events(id),
  user_id uuid NOT NULL,
  status order_status NOT NULL DEFAULT 'CONFIRMED',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seat_id),
  UNIQUE (seat_id)
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  operation text NOT NULL CHECK (length(operation) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, operation, idempotency_key),
  CHECK (
    (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

