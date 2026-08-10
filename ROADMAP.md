# Roadmap — Live Seat Reservation

A high-demand seat reservation system built to demonstrate concurrency control, consistency, fault tolerance, asynchronous processing, real-time communication, and observability with Node.js.

## Objective

Build and demonstrate a system in which thousands of users can compete for seats at the same event without overselling, including during:

- concurrent requests and network retries;
- duplicated or delayed messages;
- process restarts and unavailable workers;
- multiple API and WebSocket gateway instances;
- temporary Redis unavailability.

PostgreSQL is the source of truth. Redis, BullMQ, and WebSocket improve performance, coordination, and event propagation, but they are not required to guarantee that a seat is sold only once.

## Architectural principles

1. PostgreSQL is the authority for consistency.
2. Redis does not participate in the no-overselling guarantee.
3. Every repeatable operation must be idempotent.
4. Asynchronous processing assumes at-least-once delivery.
5. WebSocket is an update mechanism, not a source of truth.
6. Transactional Outbox prevents dual writes.
7. Expected failures require recovery mechanisms.
8. Constraints, concurrent tests, and failure tests prove correctness.
9. The system starts as a modular monolith running in separate processes.
10. Complexity is added only for a measurable hypothesis.

## Domain invariants

- A seat cannot belong to two confirmed orders.
- A seat can have at most one active hold.
- A user may only confirm or cancel their own hold.
- An expired hold cannot be confirmed.
- Concurrent confirmation and expiration cannot corrupt state.
- Repeating the same idempotency key and payload returns the same result.
- Reusing an idempotency key with a different payload fails.
- Reprocessing a job or event cannot duplicate effects.
- A delayed release cannot free a newer hold or order.
- A client not admitted by the waiting room cannot create a hold.
- Redis unavailability cannot cause overselling.

## State machines

### Seat

```text
AVAILABLE ──hold──▶ HELD ──confirm──▶ SOLD
    ▲                 │
    └────expire───────┘
```

### Hold

```text
ACTIVE ──confirm──▶ CONFIRMED
   ├────cancel────▶ CANCELLED
   └────expire────▶ EXPIRED
```

Transitions are conditional and atomic in PostgreSQL. Only one operation can win a race between confirmation, cancellation, and expiration.

## Target architecture

```text
                               ┌─────────────────────┐
                               │ Waiting Room        │
Client ──HTTP/WS──▶ API/Gateway│ Redis ZSET          │
                               └─────────┬───────────┘
                                         │ admission token
                                         ▼
                               ┌─────────────────────┐
                               │ Reservation Module  │
                               └─────────┬───────────┘
                                         │ transaction
                                         ▼
                               ┌─────────────────────┐
                               │ PostgreSQL          │
                               │ seats / holds       │
                               │ orders / outbox     │
                               └──────┬────────┬─────┘
                                      │        │
                           expiration │        │ outbox relay
                                      ▼        ▼
                                  BullMQ    Redis Pub/Sub
                                      │        │
                                      ▼        ▼
                                   Worker   WS gateways
```

### Processes

- `api`: HTTP commands and queries;
- `websocket-gateway`: presence, waiting-room positions, and real-time updates;
- `worker`: expiration, reconciliation, and asynchronous jobs;
- `outbox-relay`: reliable publication of committed events;
- `admission-controller`: adaptive admission from the waiting room.

All processes share the codebase and domain modules but can be started and scaled independently.

## Technology choices

- Node.js 22 and strict TypeScript;
- Fastify and TypeBox/JSON Schema;
- PostgreSQL and explicit SQL for concurrency;
- Redis, BullMQ, and `ws`;
- SQL migrations;
- OpenTelemetry, Prometheus, Grafana, and Tempo;
- Vitest and k6;
- Docker Compose.

## Project structure

```text
src/
├── apps/
│   ├── api/
│   ├── websocket-gateway/
│   ├── worker/
│   ├── outbox-relay/
│   └── admission-controller/
├── modules/
│   ├── catalog/
│   ├── reservations/
│   ├── waiting-room/
│   ├── checkout/
│   ├── outbox/
│   └── realtime/
└── shared/
    ├── database/
    ├── redis/
    ├── health/
    ├── config/
    └── observability/
```

Modules separate domain, application, infrastructure, and transport concerns where appropriate. Business rules do not directly depend on Fastify, BullMQ, or WebSocket.

---

# Implementation phases

## Phase 0 — Design and decisions

- [x] Define the first release objectives and non-objectives.
- [x] Document domain invariants and state machines.
- [x] Define expiration, confirmation, and idempotency semantics.
- [x] Define initial SLOs and capacity limits.
- [x] Record PostgreSQL, Transactional Outbox, and modular-monolith ADRs.
- [x] Document at-least-once delivery and WebSocket resynchronization.

**Acceptance:** the main decisions and invariants are documented before and alongside the reservation core.

## Phase 1 — Project foundation

- [x] Initialize Git and the Node.js project.
- [x] Configure strict TypeScript, linting, formatting, and type checking.
- [x] Create Docker Compose with PostgreSQL and Redis.
- [x] Validate configuration during startup.
- [x] Add SQL migrations and their runner.
- [x] Implement structured logs and correlation IDs.
- [x] Add liveness and readiness endpoints.
- [x] Implement graceful shutdown.
- [x] Configure CI for linting, type checking, tests, and build.
- [x] Add a secret-free `.env.example`.

**Acceptance:** one command starts the infrastructure and application; CI and health checks pass in a clean environment.

## Phase 2 — Event and seat catalog

- [x] Create `events`, `seat_sections`, and `seats` tables.
- [x] Enforce `event_id + seat_label` uniqueness.
- [x] Seed an event with thousands of seats.
- [x] Implement event queries and versioned seat-map snapshots.
- [x] Paginate seats by section.
- [x] Validate and serialize requests and responses with schemas.

**Acceptance:** a client can fetch a consistent, versioned seat-map snapshot.

## Phase 3 — Reservation core

- [x] Create `holds`, `orders`, and `order_items` tables.
- [x] Add constraints that prevent duplicate sales.
- [x] Create holds through conditional updates.
- [x] Calculate expiration using PostgreSQL time.
- [x] Query, cancel, and confirm holds with ownership checks.
- [x] Add bounded deadlock/serialization retries.
- [x] Define stable domain error codes.
- [x] Persist idempotency request hashes and results.
- [x] Prove one winner across 100 same-seat requests.
- [x] Test replay, conflicting payloads, ownership, expiration races, and terminal states.

**Acceptance:** tests prove zero overselling using PostgreSQL as the correctness mechanism.

## Phase 4 — Resilient expiration

- [x] Configure BullMQ and delayed expiration jobs.
- [x] Implement an idempotent worker with retry and backoff.
- [x] Handle permanently failed jobs.
- [x] Reconcile expired holds periodically.
- [x] Process concurrent batches with `FOR UPDATE SKIP LOCKED`.
- [x] Support multiple reconciler instances.
- [x] Measure effective expiration delay.
- [x] Test duplicate jobs, worker restart, lost jobs, and stale releases.

**Acceptance:** expired holds are eventually released even after worker or Redis failures.

## Phase 5 — Transactional Outbox

- [x] Create `outbox_events`.
- [x] Write state and events in the same transaction.
- [x] Implement concurrent batch relays.
- [x] Publish to Redis and record attempts/completion.
- [x] Tolerate duplicate publication.
- [x] Archive old records.
- [x] Expose pending-event and oldest-event-age metrics.
- [x] Test crashes around commit/publication and duplicate consumption.

**Acceptance:** every committed domain change is eventually published without unsafe dual writes.

## Phase 6 — Real-time updates

- [x] Create an authenticated WebSocket gateway.
- [x] Support per-event subscriptions and ping/pong heartbeat.
- [x] Remove dead connections.
- [x] Propagate events across gateway instances through Redis.
- [x] Include `eventId`, `seatId`, `version`, and `occurredAt`.
- [x] Ignore old/duplicate events and detect version gaps.
- [x] Resynchronize through HTTP snapshots.
- [x] Limit message size/rate and slow-client buffers.
- [x] Implement graceful gateway draining.
- [x] Test multi-gateway delivery, duplicates, gaps, reconnect storms, and slow clients.

**Acceptance:** clients receive low-latency updates and recover safely after disconnects or gaps.

## Phase 7 — Waiting room

- [x] Implement a deterministic Redis ZSET queue.
- [x] Add waiting-session heartbeats and approximate WebSocket positions.
- [x] Admit batches through one or more controllers.
- [x] Issue short-lived signed tokens bound to user, event, and session.
- [x] Prevent token reuse and protect hold creation.
- [x] Rate-limit by user, session, and IP.
- [x] Limit concurrent holds per user.
- [x] Apply database/worker backpressure and adaptive admission.
- [x] Test rejected, expired, mismatched, reused, and abandoned sessions.
- [x] Prove multiple controllers do not exceed global capacity.

**Acceptance:** traffic reaching the critical reservation path is controlled and horizontally scalable.

## Phase 8 — Checkout and simulated payment

- [x] Create a fake payment provider.
- [x] Start checkout from a valid hold.
- [x] Authenticate and deduplicate webhooks.
- [x] Handle out-of-order callbacks.
- [x] Confirm orders atomically.
- [x] Define late-payment behavior.
- [x] Implement timeout, failure, and cancellation.
- [x] Record payment transition history.
- [x] Test duplicate webhooks, late payments, failure paths, and checkout replay.

**Acceptance:** payment retries and callbacks cannot duplicate orders or sell expired seats.

## Phase 9 — Observability

- [x] Expose Prometheus metrics.
- [x] Provision Grafana dashboards.
- [x] Instrument traces with OpenTelemetry.
- [x] Correlate API, transaction, job, outbox, and broadcast activity.
- [x] Measure connection-pool use and waiters.
- [x] Monitor event-loop lag.
- [x] Add alerts, runbooks, and a sensitive-data redaction policy.

Minimum signals include HTTP rate/error/duration, hold attempts/conflicts, active holds, expiration delay, outbox backlog/age, waiting-room size/wait time, admission rate, WebSocket connections/broadcast duration, pool waiters, and event-loop lag.

**Acceptance:** a contention or failure experiment can be diagnosed without attaching a debugger.

## Phase 10 — Load and resilience testing

- [x] Thousands of users selecting distinct seats.
- [x] Thousands of users competing for the same seat.
- [x] Waiting-room arrival spike.
- [x] WebSocket reconnect storm and deliberately slow clients.
- [x] Redis and worker unavailability.
- [x] API restart during hold creation.
- [x] Interrupted outbox relay.
- [x] Duplicate events and jobs.
- [x] PostgreSQL pool saturation.
- [x] Record p50/p95/p99, throughput, errors, conflicts, resources, backlogs, and recovery.
- [ ] Evaluate optional Redis fast rejection against the PostgreSQL-only baseline.

**Acceptance:** the reproducible suite records zero overselling and documents hardware-specific limits and recovery behavior.

## Phase 11 — Deployment and presentation

- [x] Create separate Docker targets for each process.
- [x] Run migrations as a controlled deployment job.
- [x] Configure dependency-aware readiness and graceful draining.
- [x] Publish architecture and critical sequence diagrams.
- [x] Add a threat model and basic capacity planning.
- [x] Document tolerated and non-tolerated failures.
- [x] Add incident and observability runbooks.
- [x] Publish ADRs, load-test guidance, and a reproducible concurrency demo.
- [x] Create a complete portfolio-oriented English README.

**Acceptance:** a reviewer can understand the trade-offs, start the system, reproduce contention, and inspect correctness and observability evidence.

## Outside the first release

- a complete frontend and seat-map editor;
- real authentication, authorization, and account management;
- integration with a real payment provider;
- dynamic pricing, promotions, refunds, transfers, and resale;
- Kubernetes, multi-region active-active, and global routing;
- a dedicated analytics pipeline and data warehouse;
- service decomposition without measured need.

## Expected portfolio evidence

- an architecture diagram and critical sequence diagrams;
- ADRs explaining PostgreSQL authority, outbox delivery, and process boundaries;
- concurrent tests that prove one winner;
- load-test reports with identified hardware and commit;
- dashboards and traces for successful and failed flows;
- fault-injection evidence and recovery times;
- SQL invariant audit output with zero overselling;
- a short reproducible demo and complete setup guide.

## Definition of done

- [x] critical invariants have automated tests;
- [x] a reproducible load test audits zero overselling;
- [x] retries and duplicates are handled idempotently;
- [x] expiration recovers after worker unavailability;
- [x] event publication survives crashes;
- [x] real-time clients can resynchronize state;
- [x] the waiting room controls admission rate;
- [x] metrics, logs, and traces diagnose critical flows;
- [x] CI, Docker Compose, and documentation support third-party reproduction;
- [x] decisions and limitations are documented in the README and ADRs.
