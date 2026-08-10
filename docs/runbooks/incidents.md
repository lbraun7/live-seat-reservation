# Incident runbook

## Common triage

1. Declare the start time, impact, event, and owner; preserve correlation IDs.
2. Check `docker compose ps`, the Overview dashboard, traces, and alerts.
3. Protect correctness: do not remove constraints or manually edit hold states.
4. Reduce admission or traffic before restarting components in bulk.
5. After recovery, run `npm run load:audit` and record the timeline and root cause.

## Readiness failure

Query `/health/ready`; its body distinguishes PostgreSQL from Redis. Check process logs, latency, and pool state. Do not route traffic while it returns 503. If a migration failed, the `migrate` job blocks the API and workers; fix and rerun it, and never manually edit `schema_migrations`.

## Outbox delay

Inspect `outbox_pending_events` and `outbox_oldest_event_age_seconds`, Redis, and relay logs. Restore the dependency and temporarily scale the relay. Duplicates are expected; do not delete pending events. Confirm convergence to zero.

## Delayed expirations

Inspect BullMQ, `expiration_lag_seconds`, Redis, and the worker. After restoring the worker, the PostgreSQL reconciler covers lost jobs. Wait for backlog convergence and audit collisions.

## Suspected overselling

Freeze new admissions and preserve the database and logs. Run `npm run load:audit`. Any result above zero is the highest severity: do not attempt to fix it by deleting rows. Capture the schema, constraints, transactions, and deployed version for analysis and buyer reconciliation.

## Shutdown/deployment

Send SIGTERM and respect `stop_grace_period`. The API stops accepting connections; the gateway rejects upgrades, sends `server.draining`, and closes with 1012; loops stop and current operations finish. Use SIGKILL only after the timeout, accepting idempotent replay during recovery.
