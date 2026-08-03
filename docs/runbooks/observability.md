# Runbook de observabilidade

## API high error rate

Confira rotas/status no dashboard, abra traces representativos no Tempo e verifique saúde
de PostgreSQL e Redis. Se o banco estiver saudável, procure o código de erro e correlation
ID nos logs. Erros de conflito esperados (409) não entram neste alerta.

## Postgres pool saturated

Compare conexões `busy`, fila do pool e p95 HTTP. Localize queries lentas nos traces e
locks no PostgreSQL. Reduza a admissão temporariamente antes de aumentar o pool; aumentar
conexões sem conferir o limite do banco pode ampliar a saturação.

## Expiration lag high

Confira `bullmq_jobs`, `bullmq_job_lag_seconds` e o estado do worker/Redis. Reinicie ou
escale workers quando seguro. O reconciliador PostgreSQL recupera holds vencidos, portanto
confirme a queda do lag e que `expired_holds_total{source="reconciler"}` avançou.

## Outbox publication gap

Confira conectividade do relay com Redis, erros e tentativas no relay. Reinicie-o após
corrigir a dependência. Não altere `published_at` manualmente: o relay pode republicar e os
consumidores são idempotentes.

## Slow WebSocket clients

Compare conexões, duração de broadcast, drops e event-loop lag. Os clientes lentos são
fechados com código 1013 e devem buscar novo snapshot por HTTP antes de reconectar.

## Event loop lag high

Correlacione com CPU, heap, tráfego e broadcast. Procure trabalho síncrono em traces/logs;
se ocorrer em um único processo, retire a instância de rotação e capture um profile.
