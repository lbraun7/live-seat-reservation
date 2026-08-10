# Load and resilience testing

This suite implements Phase 10 with reproducible k6 scenarios, Docker Compose-controlled failures, raw JSON results, and an independent PostgreSQL invariant audit. The database remains the source of truth: Redis supports admission, queues, and broadcasts, but does not decide whether a seat may be sold.

## Preparation

Start from a clean stack and wait for health checks:

```bash
docker compose down -v
docker compose up -d --build
docker compose ps
```

`down -v` deletes local data and must only be used in a disposable load-test environment. Every run writes its complete k6 summary to `load-tests/results/` and finishes by executing `load-tests/audit.sql`. The audit exits with a non-zero status if more than one order or more than one active hold exists for the same seat.

## Scenarios

```bash
npm run load:test -- distinct-seats
npm run load:test -- same-seat
npm run load:test -- waiting-room-spike
npm run load:test -- websocket-storm
npm run load:test -- websocket-slow-clients
npm run load:test -- duplicate-delivery
```

| Scenario                 | Evidence produced                                           |
| ------------------------ | ----------------------------------------------------------- |
| `distinct-seats`         | throughput and latency with users selecting different seats |
| `same-seat`              | one winner and expected `409` conflicts under contention    |
| `waiting-room-spike`     | queue behavior during a sudden arrival spike                |
| `websocket-storm`        | latency and success rate across thousands of reconnects     |
| `websocket-slow-clients` | connection limits, dropping, and backpressure               |
| `duplicate-delivery`     | idempotent replay with the same status, body, and hold      |
| `resilience`             | continuous probe used during process/dependency failures    |

Values are deliberately configurable. For example, a 3,000-user run across the three seeded sections is:

```bash
RATE=50 DURATION=1m PRE_ALLOCATED_VUS=200 MAX_VUS=3000 \
  npm run load:test -- distinct-seats
```

Recreate volumes before establishing a new baseline so experiments remain independent. Existing holds legitimately change the number of conflicts.

## Failure experiments

The orchestrator warms traffic for 15 seconds, injects a failure, restores the process, and audits the database. Its exit trap also restores services after terminal interruption.

```bash
npm run load:chaos -- redis-unavailable
npm run load:chaos -- worker-unavailable
npm run load:chaos -- api-restart
npm run load:chaos -- outbox-interrupted
RATE=500 MAX_VUS=2000 npm run load:chaos -- postgres-pool-saturation
```

- Pausing Redis tests reservation/admission responses without transferring correctness to Redis.
- Stopping the worker accumulates expirations; after recovery, measure convergence with `expiration_lag_seconds` and the BullMQ queue.
- Restarting the API tests interrupted requests and idempotent retries.
- Stopping the relay accumulates committed outbox events; after recovery, age and size must converge to zero even if one publication is repeated.
- Pool saturation uses traffic above connection-pool capacity. Tune `RATE`, `MAX_VUS`, and duration for the machine; inspect `database_pool_waiting` and latency.

The duplicate-delivery scenario covers HTTP commands. Event deduplication is guaranteed by the `consumed_events(consumer_name, event_id)` primary key, while job deduplication relies on conditional state transitions in the worker/reconciler. Integration tests exercise both transitions. Transactional Outbox uses at-least-once publication, and consumers deduplicate by stable `eventId`.

## Data collection and reporting

During every test window, export or capture the Grafana dashboard and query Prometheus. The following queries cover the required signals; use the same time window as the test:

```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))
rate(hold_attempts_total[1m])
rate(hold_conflicts_total[1m])
event_loop_lag_seconds
websocket_connections
histogram_quantile(0.95, sum by (le) (rate(websocket_broadcast_duration_seconds_bucket[1m])))
expiration_lag_seconds
outbox_pending_events
outbox_oldest_event_age_seconds
database_pool_waiting
```

Obtain per-process CPU and memory with `docker stats --no-stream`; connection counts, backlogs, and event-loop lag come from Prometheus. Copy the values and tested commit to `docs/load-test-report-template.md`. k6 JSON files include p50, p95, p99, error rate, checks, iterations, and throughput.

## Acceptance criteria

- `audit.sql` finishes with `oversold_seats=0` and `active_hold_collisions=0`.
- The contention scenario produces only `201` or expected `409` conflicts.
- Duplicate replay returns the same hold with `idempotency-replayed: true`.
- After recovery, readiness returns to `200`, the outbox converges, and expiration delay returns to baseline.
- Agreed latency/error thresholds pass for the tested hardware and are recorded in the report.

The Redis fast-rejection experiment remains optional and is not part of the correctness path. If evaluated, first run this PostgreSQL baseline, add only a short-lived Redis lock as early rejection, and repeat the exact matrix. Redis unavailability must never allow a sale that PostgreSQL constraints or transactions would reject.
