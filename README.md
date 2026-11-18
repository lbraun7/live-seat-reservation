# Live Seat Reservation

> A production-inspired backend that demonstrates how to reserve and sell seats under heavy concurrency without overselling.

## The engineering problem

Seat reservation looks simple until hundreds of clients read the same seat as available and try to reserve it at once. A naive read-then-write flow can accept multiple buyers, while retries, duplicated messages, delayed payments, and crashed workers introduce additional ways to corrupt state.

This project models that failure-prone environment and keeps the core business invariants intact. When 100 concurrent requests compete for the same seat, PostgreSQL selects exactly one winner. Expired holds are eventually released, duplicated operations remain safe, and real-time clients can recover from missed updates.

The system is implemented as a **modular monolith running as specialized processes**. PostgreSQL is the source of truth; Redis is deliberately limited to queueing, coordination, jobs, and event propagation rather than reservation correctness.

> Backend-only project. Its behavior is demonstrated through HTTP, WebSocket, automated tests, SQL invariant audits, and k6 load scenarios.

## Project highlights

- **Correctness under contention:** PostgreSQL transactions, row locks, conditional updates, and constraints prevent overselling.
- **Idempotent operations:** safe HTTP retries detect both repeated requests and keys reused with a different payload.
- **Controlled admission:** a distributed Redis waiting room limits how many buyers reach the reservation flow.
- **Failure recovery:** BullMQ schedules hold expiration while a PostgreSQL reconciler recovers lost or delayed jobs.
- **Asynchronous payments:** signed webhooks are deduplicated, ordered, and handled safely after terminal states.
- **Reliable event propagation:** Transactional Outbox prevents database changes from being lost between commit and publication.
- **Recoverable real-time updates:** versioned WebSocket messages detect gaps and direct clients back to authoritative HTTP snapshots.
- **Operational evidence:** unit, integration, concurrency, load, resilience, and SQL invariant tests exercise the guarantees.

## Built with

- **Application:** Node.js 22, strict TypeScript, Fastify, TypeBox, and WebSocket (`ws`).
- **Data and messaging:** PostgreSQL 17, Redis 7, BullMQ, and Transactional Outbox.
- **Quality and operations:** Vitest, k6, OpenTelemetry, Prometheus, Grafana, Tempo, and Docker Compose.

## 60-second concurrency demo

With Docker running, start the complete stack:

```bash
docker compose up --build -d
```

After the services become healthy, run the portfolio demo:

```bash
./scripts/demo-concurrency.sh
```

The script verifies readiness, runs a short k6 scenario with 100 virtual users contending for the same seat, and audits the persisted PostgreSQL state. Conflicting requests are expected; violating a reservation invariant is not.

The final audit must report:

```text
PASS: reservation invariants hold; oversold_seats=0 active_hold_collisions=0
```

Detailed k6 output is saved under `load-tests/results/`. The first Docker image build may take longer than a minute; the demo itself uses a 15-second contention window.

## Correctness evidence

The guarantees below are backed by executable tests rather than architecture claims alone.

| Guarantee                                                                      | Mechanism                                                                                                      | Executable proof                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| One winner for a contested seat                                                | Row locking, conditional state changes, a partial unique active-hold index, and a unique sold-seat constraint  | [100-request PostgreSQL race](tests/integration/reservations-postgres.test.ts) and [SQL invariant audit](load-tests/audit.sql) |
| Safe request retries                                                           | Persisted idempotency key, request hash, status code, and response body                                        | [Reservation idempotency integration test](tests/integration/reservations-postgres.test.ts)                                    |
| Confirmation cannot race expiration or cancellation into an invalid state      | Hold locks and conditional terminal transitions inside one transaction                                         | [Concurrent transition tests](tests/integration/reservations-postgres.test.ts)                                                 |
| Lost, duplicated, or stale expiration jobs remain safe                         | Deterministic BullMQ job IDs, expected expiration timestamps, and PostgreSQL reconciliation with `SKIP LOCKED` | [Expiration recovery tests](tests/integration/hold-expiration-postgres.test.ts)                                                |
| Duplicate, delayed, and late payment callbacks do not create extra orders      | Signed webhooks, provider-event deduplication, event ordering, and transactional state changes                 | [Checkout and webhook tests](tests/integration/checkout-postgres.test.ts)                                                      |
| Multiple admission controllers respect one global capacity                     | An atomic Redis Lua script moves sessions between sorted sets                                                  | [Distributed waiting-room tests](tests/integration/waiting-room-redis.test.ts)                                                 |
| A publish failure cannot erase a committed domain event                        | Transactional Outbox, retry metadata, stable event IDs, and idempotent consumers                               | [Outbox recovery tests](tests/integration/outbox-postgres.test.ts)                                                             |
| Duplicate or missing real-time updates do not silently corrupt the client view | Monotonic versions, duplicate rejection, and HTTP snapshot resynchronization                                   | [Cross-instance realtime tests](tests/integration/realtime-redis.test.ts)                                                      |

Run the fast quality gate with `npm run check`, the dependency-backed suite with `npm run test:integration`, and the persisted-state acceptance gate with `npm run load:audit`.

## Architecture

The project is one codebase with isolated domain modules, deployed as processes that can scale independently. The request path stays small, while expiration, admission, event publication, and WebSocket delivery run outside the API process.

```mermaid
flowchart LR
  Client["HTTP / WebSocket client"] --> API["Fastify API"]
  API --> PG[("PostgreSQL\nsource of truth")]
  API --> Redis[("Redis\nwaiting room and jobs")]
  Admission["Admission controller"] --> Redis
  Redis --> Worker["Expiration worker"]
  Worker --> PG
  PG --> Relay["Outbox relay"]
  Relay -->|Redis Pub/Sub| Gateway["WebSocket gateway"]
  Gateway --> Client
```

### Why a modular monolith?

The domain remains cohesive and transactional without the network and deployment overhead of independent microservices. Workloads with different scaling characteristics still run separately: HTTP traffic scales the API, persistent connections scale the gateway, and asynchronous backlogs scale workers and relays.

### Runtime processes

| Process                | Role                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `api`                  | Serves catalog, waiting-room, reservation, checkout, webhook, health, and metrics endpoints |
| `admission-controller` | Admits queued users in adaptive batches without exceeding active capacity                   |
| `worker`               | Processes delayed expiration jobs and reconciles expired holds directly from PostgreSQL     |
| `outbox-relay`         | Publishes committed domain events from PostgreSQL to Redis Pub/Sub                          |
| `websocket-gateway`    | Broadcasts versioned seat changes and waiting-room updates                                  |
| `migrate` / `seed`     | Applies the schema and creates deterministic demonstration data                             |

### Code organization

```text
src/
├── apps/                     # process entry points
│   ├── api/
│   ├── worker/
│   ├── outbox-relay/
│   ├── websocket-gateway/
│   ├── admission-controller/
│   └── seed/
├── modules/
│   ├── catalog/              # events and seat-map snapshots
│   ├── reservations/         # hold, confirm, cancel, and expire
│   ├── checkout/             # payments, webhooks, and orders
│   ├── waiting-room/         # queue, admission, and rate limits
│   ├── outbox/               # reliable event publishing
│   └── realtime/             # real-time update contracts
└── shared/                   # config, database, Redis, health, observability
```

Each module separates the following layers when needed:

- `domain`: business contracts, states, and errors;
- `application`: use cases and orchestration;
- `infrastructure`: PostgreSQL, Redis, and BullMQ adapters;
- `transport`: HTTP adapters.

The detailed component diagram, critical sequences, and scaling notes live in [docs/architecture.md](docs/architecture.md).

## How it works

### 1. Catalog

The seed job creates one event with three sections and 3,000 seats. The API returns event metadata and section-based paginated snapshots. Each snapshot carries a monotonic version so clients can detect gaps in real-time updates.

### 2. Waiting room

Before creating a hold, a user joins a Redis ZSET queue. The `admission-controller` runs an atomic Lua script that removes expired admissions, respects the global capacity, and admits the next batch. The batch size is reduced when PostgreSQL latency or connection-pool pressure increases.

The HMAC token issued after admission is bound to a user, event, and session. It expires, is subject to rate limits, and is consumed against the idempotency key used to create the reservation.

### 3. Reservation without overselling

Hold creation runs inside a database transaction. PostgreSQL locks the required state, and the partial `holds_one_active_per_seat` constraint prevents more than one active hold for the same seat. The per-user active-hold limit is also applied atomically.

Confirmation, cancellation, and expiration use conditional state transitions. During a race, only one terminal transition can win. The uniqueness of `order_items.seat_id` provides a second barrier against duplicate sales.

### 4. Resilient expiration

When a hold is created, the API schedules its expiration in BullMQ. The worker releases the seat when the deadline—calculated using PostgreSQL's clock—is reached. Because Redis or an individual job may fail, a reconciler also scans expired holds directly from PostgreSQL using `FOR UPDATE SKIP LOCKED`. Losing a job therefore cannot lock a seat forever.

### 5. Checkout and payment

The fake provider creates a `PENDING` payment. Its webhook is authenticated with HMAC-SHA256, deduplicated by `eventId`, and processed transactionally. Success confirms the payment, hold, seat, and order. Failure, cancellation, or timeout releases the seat. A success received after a terminal state becomes `LATE_SUCCEEDED`: the seat is not sold, and the payment is explicitly flagged for a refund.

### 6. Outbox and real-time updates

A reservation change writes both the new state and its event to `outbox_events` in the same transaction. The relay claims batches with `FOR UPDATE SKIP LOCKED` and publishes them through Redis Pub/Sub. Delivery is at least once, so every envelope has a stable `eventId`, and an idempotent consumer implementation is available.

The gateway sends `seat.updated`. If versions are not contiguous, it sends `resync.required`, and the client must fetch a fresh HTTP snapshot. WebSocket improves responsiveness but is never the source of truth.

## Architectural decisions and trade-offs

The design favors explicit consistency and recoverability over the appearance of exactly-once processing.

| Decision                                                                                         | Why it was chosen                                                                                                 | Accepted trade-off                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [PostgreSQL is the source of truth](docs/adrs/001-postgresql-source-of-truth.md)                 | Transactions, locks, and constraints keep reservations correct even when Redis is unavailable                     | More contention and connection pressure reach the database                     |
| [Use a modular monolith with specialized processes](docs/adrs/003-modular-monolith-processes.md) | One codebase and schema keep domain transactions simple while workloads scale independently                       | Processes remain deployment-coupled and share schema evolution                 |
| [Publish through a Transactional Outbox](docs/adrs/002-transactional-outbox.md)                  | A committed state change cannot be silently separated from its domain event                                       | Delivery is at least once, so duplicates and idempotent consumers are expected |
| Treat Redis as disposable coordination infrastructure                                            | Waiting-room ordering, delayed jobs, and broadcasts benefit from Redis without making it a correctness dependency | Redis outages reduce availability and real-time behavior until recovery        |
| Combine delayed expiration jobs with database reconciliation                                     | Fast scheduled releases and eventual recovery both work when individual jobs are lost                             | Two expiration paths must remain idempotent and observable                     |
| Use versioned WebSocket events with HTTP resynchronization                                       | Gateways stay stateless and clients can detect duplicate or missing updates                                       | Clients must implement snapshot recovery and tolerate temporary staleness      |

### Business invariants

- A seat has at most one active hold and can appear in at most one confirmed order.
- Only the owning user can confirm or cancel a hold.
- An expired hold cannot be confirmed or made active again.
- Confirmation, cancellation, and expiration are atomic terminal transitions.
- The same idempotency key and payload return the persisted result; another payload is rejected.
- Duplicate jobs, messages, and webhooks cannot duplicate their business effects.
- Expiration deadlines use PostgreSQL time to avoid process clock drift.

See the [detailed architecture](docs/architecture.md), [accepted ADRs](docs/adrs), [failure modes](docs/failure-modes.md), and [threat model](docs/threat-model.md) for the complete reasoning.

## Run locally

Requirements: Docker with Compose and ports `3000`, `3001`, `3002`, `5432`, `6379`, `9090`, `9464`, and `3200` available.

```bash
docker compose up --build -d
docker compose ps
curl --fail http://localhost:3000/health/ready
```

`migrate` and `seed` are idempotent one-shot jobs. The API starts only after both finish successfully.

| Service    | Address                                     |
| ---------- | ------------------------------------------- |
| API        | `http://localhost:3000`                     |
| WebSocket  | `ws://localhost:3001/ws`                    |
| Grafana    | `http://localhost:3002` (`admin` / `admin`) |
| Prometheus | `http://localhost:9090`                     |
| Tempo      | `http://localhost:3200`                     |

Stop the stack with `docker compose down`. Add `-v` only when intentionally deleting all local volumes.

For source-level development, install dependencies, start PostgreSQL and Redis, migrate, seed, and run each workload in its own terminal:

```bash
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run migrate
npm run seed
npm run dev
```

The remaining processes are available through `dev:worker`, `dev:outbox-relay`, `dev:websocket-gateway`, and `dev:admission-controller`.

## Testing

Run linting, formatting, type checking, dependency-free tests, and the production build:

```bash
npm ci
npm run check
```

Run the PostgreSQL and Redis integration suites:

```bash
docker compose up -d postgres redis
cp .env.example .env
npm run migrate

TEST_DATABASE_URL=postgresql://reservation:reservation@localhost:5432/reservation \
TEST_REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

With the complete stack running, use `npm run load:test -- all` for the standard k6 matrix and `npm run load:audit` for the persisted-state acceptance gate.

See the [complete HTTP purchase walkthrough](docs/demo.md) and the [load and resilience testing guide](docs/load-testing.md) for detailed scenarios and result interpretation.

## API overview

| Method | Route                                                | Purpose                                   |
| ------ | ---------------------------------------------------- | ----------------------------------------- |
| `GET`  | `/health/live`                                       | process liveness                          |
| `GET`  | `/health/ready`                                      | PostgreSQL and Redis readiness            |
| `GET`  | `/metrics`                                           | API Prometheus metrics                    |
| `GET`  | `/events/:eventId`                                   | event details                             |
| `GET`  | `/events/:eventId/seats`                             | section-based paginated snapshot          |
| `POST` | `/events/:eventId/waiting-room`                      | join the queue                            |
| `GET`  | `/events/:eventId/waiting-room/:sessionId`           | query position or admission               |
| `POST` | `/events/:eventId/waiting-room/:sessionId/heartbeat` | keep the session alive and obtain a token |
| `POST` | `/events/:eventId/holds`                             | create a hold                             |
| `GET`  | `/holds/:holdId`                                     | query an owned hold                       |
| `POST` | `/holds/:holdId/confirm`                             | confirm a hold directly                   |
| `POST` | `/holds/:holdId/cancel`                              | cancel a hold                             |
| `POST` | `/holds/:holdId/checkout`                            | start payment                             |
| `GET`  | `/payments/:id`                                      | query an owned payment                    |
| `POST` | `/payments/:id/cancel`                               | cancel a payment                          |
| `POST` | `/webhooks/fake-payment`                             | signed provider callback                  |

User commands require `x-user-id`. Mutating commands require `idempotency-key`; creating a hold also requires `x-admission-token`. Every API response includes `x-correlation-id`.

## WebSocket

Connect to `ws://localhost:3001/ws` with a UUID in the `x-user-id` header. Subscribe to seat updates with:

```json
{ "type": "subscribe", "eventId": "10000000-0000-4000-8000-000000000001", "lastVersion": 1 }
```

Subscribe to waiting-room position updates with:

```json
{
  "type": "waiting-room.subscribe",
  "eventId": "10000000-0000-4000-8000-000000000001",
  "sessionId": "SESSION_UUID"
}
```

The gateway enforces payload and frequency limits, ping/pong heartbeats, buffered-data protection, and graceful shutdown through `server.draining`.

## Observability

The provisioned **Live Seat Reservation — Overview** dashboard covers HTTP traffic and latency, hold conflicts and active holds, expiration and outbox backlogs, waiting-room admission, WebSocket connections, PostgreSQL pool pressure, and event-loop lag. Logs preserve `x-correlation-id`, while traces are exported through OTLP to Tempo. Alerts and runbooks are versioned with the codebase.

See [docs/observability.md](docs/observability.md), [docs/runbooks/observability.md](docs/runbooks/observability.md), and [docs/runbooks/incidents.md](docs/runbooks/incidents.md).

## Technical documentation

- [Demo guide](docs/demo.md)
- [Architecture](docs/architecture.md)
- [Architecture Decision Records](docs/adrs)
- [Capacity planning and SLOs](docs/capacity-planning.md)
- [Failure modes](docs/failure-modes.md)
- [Load testing](docs/load-testing.md)
- [Load-test results](docs/load-test-results.md)
- [Observability](docs/observability.md)
- [Incident runbooks](docs/runbooks/incidents.md)
- [Roadmap](ROADMAP.md)

## Current limitations

This is a backend portfolio project. It uses simplified `x-user-id` authentication, a fake payment provider, one event configured per admission-controller process, and local infrastructure through Docker Compose. A production deployment would additionally require real authentication and authorization, secret management, TLS, edge rate limiting, orchestration, backups, continuous restore tests, and integration with a real payment service provider.

## License

There is currently no license file in this repository. Until one is added, the source code should be treated as all rights reserved.
