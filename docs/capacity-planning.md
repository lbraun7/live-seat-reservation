# Capacity planning

Capacidade deve ser derivada de teste no hardware de destino, não de números universais.
Use `docs/load-testing.md` e aumente a taxa até o primeiro SLO romper.

## Modelo inicial

- API: `réplicas = ceil(pico de RPS / RPS sustentável por réplica × 1,5)`.
- Gateway: `réplicas = ceil(conexões simultâneas / conexões sustentáveis por réplica × 1,3)`;
  valide também file descriptors, memória por socket e tráfego de broadcast.
- PostgreSQL: limite a soma dos pools a no máximo 70–80% de `max_connections`, reservando
  conexões operacionais. Escale leitura de catálogo separadamente apenas quando necessário.
- Worker: capacidade de consumo precisa superar a criação de holds; o backlog deve voltar a
  zero após um pico antes do próximo pico esperado.
- Relay: `batch_size / interval` deve exceder a taxa máxima de commits com margem de 2×.
- Redis: dimensione memória para sessões, admissões, filas e AOF, com folga de 50%; meça CPU
  em scripts Lua e fan-out Pub/Sub.

## SLOs de referência para a demonstração

| Sinal                   | Objetivo inicial           | Gatilho de escala/investigação |
| ----------------------- | -------------------------- | ------------------------------ |
| API p95                 | < 250 ms fora de contenção | > 250 ms por 5 min             |
| erro inesperado         | < 1%                       | ≥ 1% por 5 min                 |
| pool esperando          | 0 em regime                | > 0 por 2 min                  |
| outbox mais antiga      | < 5 s                      | ≥ 30 s                         |
| atraso de expiração p95 | < 5 s                      | ≥ 30 s                         |
| event-loop p99          | < 100 ms                   | ≥ 250 ms                       |

Conflitos `409` na disputa são resultado de negócio, não indisponibilidade. Antes de cada
evento, execute o cenário `same-seat`, registre o commit, hardware, taxa, p95/p99, CPU,
memória e resultado de `load-tests/audit.sql`.
