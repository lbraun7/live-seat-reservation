# ADR 002 — Transactional Outbox com entrega pelo menos uma vez

**Status:** aceito.

A mudança e seu evento são gravados na mesma transação. Relays concorrentes usam
`SKIP LOCKED`; publicar antes de marcar pode duplicar. Preferimos duplicação recuperável a
perda silenciosa, exigindo `eventId` estável e consumidores idempotentes.
