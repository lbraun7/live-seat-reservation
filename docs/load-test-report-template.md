# Relatório de carga — AAAA-MM-DD / commit SHA

## Ambiente

- máquina/CPU/memória:
- Docker e sistema operacional:
- commit e configuração:
- duração e janela UTC:
- cenário, VUs/rate:

## Resultados

| Cenário            | req/s | p50 | p95 | p99 | erro | conflitos esperados |
| ------------------ | ----: | --: | --: | --: | ---: | ------------------: |
| Assentos distintos |       |     |     |     |      |                 n/a |
| Mesmo assento      |       |     |     |     |      |                     |
| Spike da sala      |       |     |     |     |      |                 n/a |
| Reconnect storm    |       |     |     |     |      |                 n/a |
| Clientes lentos    |       |     |     |     |      |                 n/a |

| Sinal operacional           | baseline | pico | após recuperação |
| --------------------------- | -------: | ---: | ---------------: |
| event-loop lag              |          |      |                  |
| CPU/memória por processo    |          |      |                  |
| conexões WS por instância   |          |      |                  |
| propagação p95 do broadcast |          |      |                  |
| atraso de expiração         |          |      |                  |
| outbox: tamanho/idade       |          |      |                  |
| espera/saturação da pool    |          |      |                  |

## Falhas e recuperação

Registre para Redis, worker, API, relay e pool: instante de injeção, respostas observadas,
backlog máximo, tempo até readiness e tempo até convergência.

## Invariantes

Cole a saída de `load-tests/results/*-audit.txt`.

- assentos vendidos mais de uma vez: **0**
- assentos com mais de um hold ativo: **0**
- replay idempotente: aprovado/reprovado

## Conclusão

Thresholds aprovados, gargalo dominante, capacidade segura estimada e ações propostas.
