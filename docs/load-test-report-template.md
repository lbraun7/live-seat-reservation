# Load-test report — YYYY-MM-DD / commit SHA

## Environment

- machine/CPU/memory:
- Docker and operating system:
- commit and configuration:
- duration and UTC window:
- scenario, VUs/rate:

## Results

| Scenario           | req/s | p50 | p95 | p99 | errors | expected conflicts |
| ------------------ | ----: | --: | --: | --: | -----: | -----------------: |
| Distinct seats     |       |     |     |     |        |                n/a |
| Same seat          |       |     |     |     |        |                    |
| Waiting-room spike |       |     |     |     |        |                n/a |
| Reconnect storm    |       |     |     |     |        |                n/a |
| Slow clients       |       |     |     |     |        |                n/a |

| Operational signal          | baseline | peak | after recovery |
| --------------------------- | -------: | ---: | -------------: |
| event-loop lag              |          |      |                |
| CPU/memory per process      |          |      |                |
| WS connections per instance |          |      |                |
| broadcast propagation p95   |          |      |                |
| expiration delay            |          |      |                |
| outbox size/age             |          |      |                |
| pool wait/saturation        |          |      |                |

## Failures and recovery

For Redis, worker, API, relay, and pool failures, record the injection time, observed responses, maximum backlog, time to readiness, and time to convergence.

## Invariants

Paste the output of `load-tests/results/*-audit.txt`.

- seats sold more than once: **0**
- seats with more than one active hold: **0**
- idempotent replay: pass/fail

## Conclusion

Record passed thresholds, the dominant bottleneck, estimated safe capacity, and proposed actions.
