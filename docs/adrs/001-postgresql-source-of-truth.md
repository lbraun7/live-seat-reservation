# ADR 001 — PostgreSQL como fonte da verdade

**Status:** aceito.

Reservas, confirmação e venda usam transações, locks e constraints PostgreSQL. Redis não
participa da decisão final. Isso preserva correção durante falhas de cache ao custo de maior
pressão no banco. Fast-rejection em Redis só pode ser uma otimização mensurada e removível.
