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

## Architecture

```mermaid
flowchart LR
  Client["HTTP / WS client"] --> API["Fastify API"]
  Client <--> WS["WebSocket gateway"]
  API --> PG[("PostgreSQL\nsource of truth")]
  API --> Redis[("Redis\nqueue and coordination")]
  API --> Queue["BullMQ"]
  Queue --> Worker["Expiration worker"]
  Worker --> PG
  Reconciler["Reconciler"] --> PG
  Admission["Admission controller"] --> Redis
  Admission --> PG
  PG --> Outbox["Outbox relay"]
  Outbox --> Redis
  Redis --> WS
  API & Worker & Admission & Outbox & WS --> Obs["OpenTelemetry / Prometheus"]
  Obs --> Grafana["Grafana / Tempo"]
```

### Why a modular monolith?

The domain remains in a single codebase, with modules isolated by responsibility, while workloads run as processes with different scaling characteristics. The API, worker, relay, gateway, and admission controller can be deployed and scaled independently without introducing the operational overhead of multiple repositories or fully independent services.

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

### Processes

| Process                | Responsibility                                              | Scaling unit             |
| ---------------------- | ----------------------------------------------------------- | ------------------------ |
| `api`                  | catalog, waiting room, reservations, checkout, and webhooks | HTTP requests            |
| `websocket-gateway`    | seat broadcasts and waiting-room positions                  | persistent connections   |
| `worker`               | expiration jobs and reconciliation                          | job backlog and delay    |
| `outbox-relay`         | publishes persisted events to Redis                         | outbox backlog           |
| `admission-controller` | admits batches without exceeding capacity                   | queue size and wait time |
| `migrate` / `seed`     | prepares the schema and demo data                           | one-shot jobs            |

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

## Core decisions and invariants

- PostgreSQL decides the winner; Redis does not guarantee reservation correctness.
- A seat has at most one active hold and can appear in at most one order item.
- Expiration time comes from the database to avoid clock drift between processes.
- Retries use idempotency keys; reusing a key with another payload fails.
- Messages and jobs are treated as potentially duplicated.
- A crash between outbox publishing and acknowledgment may duplicate an event but cannot lose the persisted event.
- WebSocket clients recover from inconsistencies through versioned snapshots.

See [docs/architecture.md](docs/architecture.md), the [ADRs](docs/adrs), and the [threat model](docs/threat-model.md) for more detail.

## Run with Docker

### Requirements

- Docker with Docker Compose;
- ports `3000`, `3001`, `3002`, `5432`, `6379`, `9090`, `9464`, and `3200` available.

Start the complete stack:

```bash
docker compose up --build
```

`migrate` and `seed` are idempotent one-shot jobs. The API only starts after both complete successfully.

In another terminal, verify the deployment:

```bash
docker compose ps
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

| Service       | Address                                     |
| ------------- | ------------------------------------------- |
| API           | `http://localhost:3000`                     |
| WebSocket     | `ws://localhost:3001/ws`                    |
| Relay metrics | `http://localhost:9464/metrics`             |
| Prometheus    | `http://localhost:9090`                     |
| Grafana       | `http://localhost:3002` (`admin` / `admin`) |
| Tempo         | `http://localhost:3200`                     |

Stop the stack while preserving its volumes:

```bash
docker compose down
```

Use `docker compose down -v` only when you intentionally want to delete local data and start over.

## Local development

```bash
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run migrate
npm run seed
```

Start each workload in a separate terminal:

```bash
npm run dev
npm run dev:worker
npm run dev:outbox-relay
npm run dev:websocket-gateway
npm run dev:admission-controller
```

## Step-by-step testing guide

### Option A — quick portfolio demo

With the complete stack running:

```bash
./scripts/demo-concurrency.sh
```

The script checks the containers, runs a concentrated k6 race for the same seat, and executes the SQL invariant audit. The key expected result is `oversold_seats=0`. Results are saved to `load-tests/results/`.

### Option B — complete manual flow

Set the fixed IDs created by the seed job:

```bash
API_URL=http://localhost:3000
EVENT_ID=10000000-0000-4000-8000-000000000001
SECTION_ID=20000000-0000-4000-8000-000000000001
USER_ID=40000000-0000-4000-8000-000000000001
```

1. Query the event and available seats:

```bash
curl "$API_URL/events/$EVENT_ID"
curl "$API_URL/events/$EVENT_ID/seats?sectionId=$SECTION_ID&limit=3"
```

Copy the `id` of an `AVAILABLE` seat from the second response into `SEAT_ID`.

2. Join the waiting room:

```bash
curl -X POST "$API_URL/events/$EVENT_ID/waiting-room" \
  -H "x-user-id: $USER_ID"
```

Copy `sessionId` into `SESSION_ID`. Send heartbeats until the response contains a `token`:

```bash
curl -X POST \
  "$API_URL/events/$EVENT_ID/waiting-room/$SESSION_ID/heartbeat" \
  -H "x-user-id: $USER_ID"
```

Copy the token into `ADMISSION_TOKEN`.

3. Create the hold:

```bash
curl -i -X POST "$API_URL/events/$EVENT_ID/holds" \
  -H 'content-type: application/json' \
  -H "x-user-id: $USER_ID" \
  -H "x-admission-token: $ADMISSION_TOKEN" \
  -H 'idempotency-key: portfolio-hold-1' \
  -d "{\"seatId\":\"$SEAT_ID\"}"
```

Copy `id` into `HOLD_ID`. Repeating the exact request returns the persisted response with the `idempotency-replayed: true` header. Reusing the key with another seat returns `IDEMPOTENCY_KEY_REUSED`.

4. Start checkout:

```bash
curl -X POST "$API_URL/holds/$HOLD_ID/checkout" \
  -H "x-user-id: $USER_ID" \
  -H 'idempotency-key: portfolio-checkout-1'
```

Copy `id` into `PAYMENT_ID` and `providerPaymentId` into `PROVIDER_PAYMENT_ID`. Query the payment with:

```bash
curl "$API_URL/payments/$PAYMENT_ID" -H "x-user-id: $USER_ID"
```

5. Simulate a successful webhook. Generate the values and signature with the local Compose secret:

```bash
WEBHOOK_EVENT_ID=$(node -e "console.log(crypto.randomUUID())")
OCCURRED_AT=$(node -e "console.log(new Date().toISOString())")
SIGNATURE=$(node -e "const c=require('crypto'); const [,e,p,t,o]=process.argv; console.log(c.createHmac('sha256','local-development-payment-webhook-secret').update([e,p,t,o].join('.')).digest('hex'))" "$WEBHOOK_EVENT_ID" "$PROVIDER_PAYMENT_ID" payment.succeeded "$OCCURRED_AT")

curl -X POST "$API_URL/webhooks/fake-payment" \
  -H 'content-type: application/json' \
  -H "x-payment-signature: $SIGNATURE" \
  -d "{\"eventId\":\"$WEBHOOK_EVENT_ID\",\"providerPaymentId\":\"$PROVIDER_PAYMENT_ID\",\"type\":\"payment.succeeded\",\"occurredAt\":\"$OCCURRED_AT\"}"
```

6. Verify the outcome:

```bash
curl "$API_URL/holds/$HOLD_ID" -H "x-user-id: $USER_ID"
curl "$API_URL/payments/$PAYMENT_ID" -H "x-user-id: $USER_ID"
curl "$API_URL/events/$EVENT_ID/seats?sectionId=$SECTION_ID&limit=500"
```

The expected state is a `CONFIRMED` hold, a `SUCCEEDED` payment, an `orderId`, and a `SOLD` seat.

To test the alternative path before sending the webhook:

```bash
curl -X POST "$API_URL/payments/$PAYMENT_ID/cancel" \
  -H "x-user-id: $USER_ID" \
  -H 'idempotency-key: portfolio-payment-cancel-1'
```

### Option C — automated tests

Run the fast checks without external dependencies:

```bash
npm ci
npm run check
```

This runs linting, formatting checks, type checking, tests, and the production build. Without test URLs, Vitest marks suites that require PostgreSQL or Redis as `skipped`.

To run the complete integration suite, start and migrate the infrastructure first:

```bash
docker compose up -d postgres redis
cp .env.example .env
npm run migrate

TEST_DATABASE_URL=postgresql://reservation:reservation@localhost:5432/reservation \
TEST_REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

The tests create isolated UUID-based fixtures and remove them afterward. For maximum CI isolation, use dedicated PostgreSQL and Redis instances.

### Option D — load, resilience, and invariant tests

With the complete stack running:

```bash
npm run load:test -- same-seat
npm run load:test -- distinct-seats
npm run load:test -- waiting-room-spike
npm run load:test -- websocket-storm
npm run load:test -- duplicate-delivery
npm run load:test -- resilience
npm run load:audit
```

Run every standard scenario with `npm run load:test -- all`. Thresholds and result interpretation are documented in [docs/load-testing.md](docs/load-testing.md).

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

## Useful commands

| Command                            | Purpose                                  |
| ---------------------------------- | ---------------------------------------- |
| `npm run dev`                      | API with hot reload                      |
| `npm run dev:worker`               | expiration worker with hot reload        |
| `npm run dev:outbox-relay`         | outbox relay with hot reload             |
| `npm run dev:websocket-gateway`    | WebSocket gateway with hot reload        |
| `npm run dev:admission-controller` | admission controller with hot reload     |
| `npm run migrate`                  | migrations protected by an advisory lock |
| `npm run seed`                     | demo event and 3,000 seats               |
| `npm run check`                    | quality checks, local tests, and build   |
| `npm run test:integration`         | PostgreSQL and Redis integration suites  |
| `npm run load:test -- <scenario>`  | k6 scenario and invariant audit          |
| `npm run load:chaos -- <failure>`  | controlled failure during load           |
| `npm run load:audit`               | audit persisted PostgreSQL invariants    |

## Technical documentation

- [Architecture](docs/architecture.md)
- [Architecture Decision Records](docs/adrs)
- [Capacity planning and SLOs](docs/capacity-planning.md)
- [Failure modes](docs/failure-modes.md)
- [Load testing](docs/load-testing.md)
- [Load-test results](docs/load-test-results.md)
- [Short demo](docs/demo.md)
- [Roadmap](ROADMAP.md)

## Current limitations

This is a backend portfolio project. It uses simplified `x-user-id` authentication, a fake payment provider, one event configured per admission-controller process, and local infrastructure through Docker Compose. A production deployment would additionally require real authentication and authorization, secret management, TLS, edge rate limiting, orchestration, backups, continuous restore tests, and integration with a real payment service provider.

## License

There is currently no license file in this repository. Until one is added, the source code should be treated as all rights reserved.
