CREATE TYPE payment_status AS ENUM (
  'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LATE_SUCCEEDED'
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  provider_payment_id uuid NOT NULL UNIQUE,
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(id),
  user_id uuid NOT NULL,
  status payment_status NOT NULL DEFAULT 'PENDING',
  last_provider_occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX payments_pending_idx ON payments (created_at, id) WHERE status = 'PENDING';

CREATE TABLE payment_webhooks (
  provider_event_id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_transitions (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  from_status payment_status,
  to_status payment_status NOT NULL,
  reason text NOT NULL,
  provider_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_transitions_payment_idx
  ON payment_transitions (payment_id, occurred_at, id);
