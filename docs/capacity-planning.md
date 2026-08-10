# Capacity planning

Capacity must be derived from tests on the target hardware, not from universal numbers. Follow `docs/load-testing.md` and increase traffic until the first SLO is breached.

## Initial model

- API: `replicas = ceil(peak RPS / sustainable RPS per replica × 1.5)`.
- Gateway: `replicas = ceil(concurrent connections / sustainable connections per replica × 1.3)`; also validate file descriptors, memory per socket, and broadcast traffic.
- PostgreSQL: keep the sum of all pools below 70–80% of `max_connections`, reserving operational connections. Scale catalog reads separately only when necessary.
- Worker: consumption capacity must exceed hold creation; backlog must return to zero after one peak before the next expected peak.
- Relay: `batch_size / interval` must exceed the maximum commit rate with a 2× margin.
- Redis: size memory for sessions, admissions, queues, and AOF with 50% headroom; measure CPU usage in Lua scripts and Pub/Sub fan-out.

## Reference SLOs for the demo

| Signal               | Initial objective           | Scale/investigation trigger |
| -------------------- | --------------------------- | --------------------------- |
| API p95              | < 250 ms outside contention | > 250 ms for 5 min          |
| unexpected errors    | < 1%                        | ≥ 1% for 5 min              |
| pool waiters         | 0 at steady state           | > 0 for 2 min               |
| oldest outbox event  | < 5 s                       | ≥ 30 s                      |
| expiration delay p95 | < 5 s                       | ≥ 30 s                      |
| event-loop p99       | < 100 ms                    | ≥ 250 ms                    |

Expected `409` contention conflicts are business outcomes, not unavailability. Before each event, run the `same-seat` scenario and record the commit, hardware, rate, p95/p99, CPU, memory, and `load-tests/audit.sql` result.
