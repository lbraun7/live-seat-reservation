# ADR 001 — PostgreSQL as the source of truth

**Status:** accepted.

Reservations, confirmations, and sales use PostgreSQL transactions, locks, and constraints. Redis does not participate in the final decision. This preserves correctness during cache failures at the cost of additional database pressure. Fast rejection in Redis may only be introduced as a measurable and removable optimization.
