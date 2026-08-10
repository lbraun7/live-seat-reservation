# Modos de falha

| Falha                              | Comportamento tolerado                                                        | Recuperação                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Redis indisponível                 | PostgreSQL continua impedindo overselling; admissão, jobs e realtime degradam | readiness falha; restaurar Redis/AOF e reconciliar expirações |
| worker parado                      | holds vencidos podem permanecer temporariamente                               | reconciliador processa o backlog ao voltar                    |
| relay parado ou crash após publish | outbox acumula ou um evento é duplicado                                       | relay retoma; `eventId` permite deduplicação                  |
| API reiniciada                     | request em voo pode perder resposta, não atomicidade                          | cliente repete com a mesma idempotency-key                    |
| gateway reiniciado                 | sockets recebem 1012 e perdem updates temporariamente                         | reconectar, buscar snapshot e assinar pela versão             |
| PostgreSQL indisponível            | comandos críticos param com readiness 503                                     | failover/restore externo e retry idempotente                  |
| pool saturado                      | latência cresce e admissão reduz lote                                         | reduzir entrada, escalar API ou corrigir query/pool           |

## Não tolerado neste release

- perda ou corrupção do PostgreSQL sem backup/failover externo;
- partição multi-região, active-active ou consistência entre regiões;
- perda permanente simultânea de Redis/AOF e PostgreSQL;
- comprometimento de segredos ou credenciais;
- DDoS além dos limites locais, pois WAF/CDN não fazem parte do repositório;
- alteração incompatível de schema sem estratégia expand/contract.
