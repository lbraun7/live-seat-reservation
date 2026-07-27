ALTER TABLE holds
  ADD COLUMN expired_at timestamptz;

UPDATE holds
   SET expired_at = updated_at
 WHERE status = 'EXPIRED';

CREATE INDEX holds_active_expiration_idx
  ON holds (expires_at, id)
  WHERE status = 'ACTIVE';

ALTER TABLE holds
  ADD CONSTRAINT holds_expired_at_matches_status CHECK (
    (status = 'EXPIRED' AND expired_at IS NOT NULL)
    OR
    (status <> 'EXPIRED' AND expired_at IS NULL)
  );
