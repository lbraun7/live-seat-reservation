# ADR 002 — Transactional Outbox with at-least-once delivery

**Status:** accepted.

The state change and its event are written in the same transaction. Concurrent relays use `SKIP LOCKED`; publishing before marking an event as published may produce duplicates. Recoverable duplication is preferred over silent loss, which requires stable `eventId` values and idempotent consumers.
