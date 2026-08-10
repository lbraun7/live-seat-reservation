# Observability

Each process publishes Prometheus metrics and starts OpenTelemetry when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is configured. W3C `traceparent` propagation is accepted on HTTP requests; Fastify/HTTP, PostgreSQL, Redis, and BullMQ instrumentation creates spans across technical boundaries. `x-correlation-id` remains the client-visible support identifier and must be included in API logs.

## Local usage

```bash
docker compose up --build
```

- Grafana: http://localhost:3002 (`admin` / `admin`, development only)
- Prometheus: http://localhost:9090
- Tempo: http://localhost:3200
- API metrics: http://localhost:3000/metrics
- gateway metrics: http://localhost:3001/metrics
- relay metrics: http://localhost:9464/metrics

The provisioned **Live Seat Reservation — Overview** dashboard shows HTTP latency, conflicts, PostgreSQL pool state, expiration/BullMQ, outbox, waiting room, WebSocket, and event-loop signals. Tempo is configured as a Grafana data source for trace searches by service and trace ID.

## Correlation

1. Preserve `x-correlation-id` when retrying a request or investigating an error.
2. Use the HTTP trace in Tempo to follow PostgreSQL queries, Redis operations, and BullMQ jobs.
3. Use `eventId`, `aggregateId`, `holdId`, and `jobId` from structured logs to correlate the transaction, outbox, expiration, and broadcast. These IDs remain stable when a message is delivered more than once.

## Sensitive-data redaction

Never log `authorization`, `cookie`, `x-admission-token`, or `x-payment-signature` headers, secrets, credential-bearing URLs, or complete webhook bodies. User identifiers and IP addresses must be omitted or hashed in production logs. Technical IDs (`holdId`, `seatId`, `orderId`, `eventId`, `jobId`), error codes, durations, and counts are allowed. Exceptions must be serialized without SQL parameters or payloads. Fastify does not currently log headers or bodies; any future request logger must enforce this explicit redaction list before being enabled.
