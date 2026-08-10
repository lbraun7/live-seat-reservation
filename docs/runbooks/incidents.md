# Runbook de incidentes

## Triagem comum

1. Declare horário, impacto, evento e responsável; preserve correlation IDs.
2. Confira `docker compose ps`, dashboard Overview, traces e alertas.
3. Proteja a correção: não remova constraints nem edite estados de hold manualmente.
4. Reduza admissão ou tráfego antes de reiniciar componentes em massa.
5. Após recuperar, execute `npm run load:audit` e registre timeline e causa.

## Readiness falhando

Consulte `/health/ready`; o corpo separa PostgreSQL e Redis. Confira logs do processo e a
latência/pool. Não rote tráfego enquanto retornar 503. Se uma migration falhou, o job
`migrate` bloqueia API e workers; corrija-a e execute novamente, nunca marque manualmente
`schema_migrations`.

## Outbox atrasada

Observe `outbox_pending_events` e `outbox_oldest_event_age_seconds`, confira Redis e logs do
relay. Restaure a dependência e escale o relay temporariamente. Duplicatas são esperadas;
não apague eventos pendentes. Confirme convergência a zero.

## Expirações atrasadas

Observe BullMQ, `expiration_lag_seconds`, Redis e worker. Ao restaurar o worker, o
reconciliador PostgreSQL cobre jobs perdidos. Espere o backlog convergir e audite colisões.

## Overselling suspeito

Congele novas admissões e preserve banco/logs. Rode `npm run load:audit`. Qualquer resultado
acima de zero é severidade máxima: não tente corrigir apagando linhas. Capture schema,
constraints, transações e versão implantada para análise e reconciliação de compradores.

## Encerramento/deploy

Envie SIGTERM e respeite `stop_grace_period`. API para novas conexões; gateway rejeita novos
upgrades, envia `server.draining` e fecha com 1012; loops param e operações correntes
terminam. Só use SIGKILL depois do timeout, aceitando replay idempotente na retomada.
