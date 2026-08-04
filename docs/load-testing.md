# Testes de carga e resiliência

Esta suíte implementa a Fase 10 com cenários k6 reproduzíveis, falhas controladas pelo
Docker Compose, resultados brutos em JSON e uma auditoria independente dos invariantes no
PostgreSQL. O banco continua sendo a fonte da verdade: Redis participa da admissão, filas e
broadcast, mas não decide se um assento pode ser vendido.

## Preparação

Suba a stack limpa e aguarde os health checks:

```bash
docker compose down -v
docker compose up -d --build
docker compose ps
```

O `down -v` apaga dados locais e deve ser usado somente no ambiente descartável de carga.
Cada execução grava o resumo completo do k6 em `load-tests/results/` e termina executando
`load-tests/audit.sql`. A auditoria retorna código diferente de zero se houver mais de um
pedido ou mais de um hold ativo para o mesmo assento.

## Cenários

```bash
npm run load:test -- distinct-seats
npm run load:test -- same-seat
npm run load:test -- waiting-room-spike
npm run load:test -- websocket-storm
npm run load:test -- websocket-slow-clients
npm run load:test -- duplicate-delivery
```

| Cenário                  | Evidência produzida                                           |
| ------------------------ | ------------------------------------------------------------- |
| `distinct-seats`         | throughput e latência com usuários em assentos diferentes     |
| `same-seat`              | uma vitória e conflitos `409` esperados sob contenção         |
| `waiting-room-spike`     | comportamento da fila em uma subida abrupta de chegadas       |
| `websocket-storm`        | latência e sucesso de milhares de reconnects                  |
| `websocket-slow-clients` | limites de conexão e descarte/backpressure                    |
| `duplicate-delivery`     | replay idempotente com mesmo status, corpo e hold             |
| `resilience`             | sonda contínua usada durante falhas de dependências/processos |

Os valores são deliberadamente configuráveis. Por exemplo, uma execução de 3.000 usuários
em assentos distintos usa os três setores do seed:

```bash
RATE=50 DURATION=1m PRE_ALLOCATED_VUS=200 MAX_VUS=3000 \
  npm run load:test -- distinct-seats
```

Para preservar a independência entre experimentos, recrie os volumes antes de uma nova
baseline. Holds anteriores alteram legitimamente o número de conflitos.

## Experimentos de falha

O orquestrador aquece a carga por 15 segundos, injeta a falha, restaura o processo e audita
o banco. O trap de saída também restaura serviços após interrupção do terminal.

```bash
npm run load:chaos -- redis-unavailable
npm run load:chaos -- worker-unavailable
npm run load:chaos -- api-restart
npm run load:chaos -- outbox-interrupted
RATE=500 MAX_VUS=2000 npm run load:chaos -- postgres-pool-saturation
```

- Redis pausado testa respostas durante reservas/admissões sem transferir a correção para
  Redis.
- Worker parado acumula expirações; após voltar, meça a recuperação por
  `expiration_lag_seconds` e pela fila BullMQ.
- API reiniciada testa requisições interrompidas e retries idempotentes.
- Relay parado acumula commits na outbox; depois da retomada, a idade e o tamanho devem
  convergir a zero, mesmo que uma publicação seja repetida.
- Saturação usa uma taxa maior que a capacidade da pool. Ajuste `RATE`, `MAX_VUS` e a
  duração conforme a máquina; observe `database_pool_waiting` e latências.

O cenário de duplicação cobre comandos HTTP. A garantia para eventos está na chave primária
`consumed_events(consumer_name, event_id)` e a garantia para jobs na transição condicional de
estado do reconciliador/worker; os testes de integração exercitam essas transições. A
Transactional Outbox aceita publicação pelo menos uma vez e consumidores deduplicam pelo
`eventId` estável.

## Coleta e relatório

Durante cada janela, exporte ou fotografe o dashboard Grafana e consulte o Prometheus. As
consultas abaixo cobrem os resultados obrigatórios (use a mesma janela do teste):

```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))
rate(hold_attempts_total[1m])
rate(hold_conflicts_total[1m])
event_loop_lag_seconds
websocket_connections
histogram_quantile(0.95, sum by (le) (rate(websocket_broadcast_duration_seconds_bucket[1m])))
expiration_lag_seconds
outbox_pending_events
outbox_oldest_event_age_seconds
database_pool_waiting
```

CPU e memória por processo são obtidas com `docker stats --no-stream`; conexões, backlog e
event-loop lag vêm do Prometheus. Copie os números e o commit testado para
`docs/load-test-report-template.md`. Os JSONs do k6 incluem p50, p95, p99, taxa de erro,
checks, iterações e throughput.

## Critérios de aprovação

- `audit.sql` termina com `oversold_seats=0` e `active_hold_collisions=0`.
- O cenário de contenção só produz `201` ou conflito esperado `409`.
- O replay duplicado devolve o mesmo hold com `idempotency-replayed: true`.
- Depois da recuperação, readiness volta a `200`, a outbox converge e o atraso de expiração
  retorna ao baseline.
- Os thresholds de latência/erro acordados para o hardware testado passam e ficam registrados
  no relatório.

O experimento Redis fast-rejection permanece opcional e não foi adicionado ao caminho de
correção. Se for avaliado, rode primeiro esta baseline PostgreSQL, adicione apenas um lock
curto como rejeição antecipada e repita exatamente a mesma matriz. Uma indisponibilidade do
Redis nunca pode permitir uma venda que as constraints/transações PostgreSQL rejeitariam.
