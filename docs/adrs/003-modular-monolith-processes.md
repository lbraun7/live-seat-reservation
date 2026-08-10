# ADR 003 — Modular monolith with specialized processes

**Status:** accepted.

One codebase and one schema reduce transactional and operational cost. The API, gateway, worker, relay, and controller have independent image targets and scaling units. The trade-off is deployment coupling; module contracts and controlled migrations prepare for future extraction without introducing microservices prematurely.
