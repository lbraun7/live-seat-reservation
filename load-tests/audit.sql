\set ON_ERROR_STOP on

-- This query is the hard acceptance gate: the unique order_items(seat_id) constraint
-- prevents overselling, and this independent audit proves the persisted outcome.
SELECT count(*) AS oversold_seats,
       count(*) > 0 AS overselling_detected
  FROM (SELECT seat_id FROM order_items GROUP BY seat_id HAVING count(*) > 1) AS duplicates
\gset

\if :overselling_detected
  \echo 'FAIL: found' :oversold_seats 'seat(s) sold more than once'
  \quit 1
\endif

SELECT count(*) AS active_hold_collisions,
       count(*) > 0 AS active_hold_collision_detected
  FROM (SELECT seat_id FROM holds WHERE status = 'ACTIVE' GROUP BY seat_id HAVING count(*) > 1) AS duplicates
\gset

\if :active_hold_collision_detected
  \echo 'FAIL: found' :active_hold_collisions 'seat(s) with multiple active holds'
  \quit 1
\endif

SELECT
  (SELECT count(*) FROM holds) AS holds,
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM outbox_events WHERE published_at IS NULL) AS outbox_pending,
  (SELECT coalesce(max(extract(epoch FROM now() - occurred_at)), 0)
     FROM outbox_events WHERE published_at IS NULL) AS outbox_oldest_age_seconds,
  :oversold_seats AS oversold_seats,
  :active_hold_collisions AS active_hold_collisions;

\echo 'PASS: reservation invariants hold; oversold_seats=0 active_hold_collisions=0'
