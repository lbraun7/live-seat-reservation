# Observability runbook

## High API error rate

Check routes and status codes in the dashboard, open representative traces in Tempo, and verify PostgreSQL and Redis health. If the database is healthy, locate the error code and correlation ID in logs. Expected `409` conflicts are excluded from this alert.

## PostgreSQL pool saturated

Compare busy connections, pool waiters, and HTTP p95. Locate slow queries in traces and locks in PostgreSQL. Reduce admission temporarily before increasing the pool; adding connections without checking the database limit can worsen saturation.

## High expiration lag

Check `bullmq_jobs`, `bullmq_job_lag_seconds`, and worker/Redis state. Restart or scale workers when safe. The PostgreSQL reconciler recovers expired holds, so confirm that lag falls and `expired_holds_total{source="reconciler"}` increases.

## Outbox publication gap

Check relay connectivity to Redis, errors, and relay attempts. Restart it after fixing the dependency. Do not edit `published_at` manually: the relay may republish, and consumers are idempotent.

## Slow WebSocket clients

Compare connections, broadcast duration, drops, and event-loop lag. Slow clients are closed with code 1013 and must fetch a fresh HTTP snapshot before reconnecting.

## High event-loop lag

Correlate the signal with CPU, heap, traffic, and broadcasts. Look for synchronous work in traces and logs; if isolated to one process, remove that instance from rotation and capture a profile.
