# Failure modes

| Failure                                | Tolerated behavior                                                            | Recovery                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Redis unavailable                      | PostgreSQL still prevents overselling; admission, jobs, and real time degrade | readiness fails; restore Redis/AOF and reconcile expirations |
| worker stopped                         | expired holds may remain temporarily                                          | reconciler processes the backlog after restart               |
| relay stopped or crashes after publish | outbox accumulates or an event is duplicated                                  | relay resumes; `eventId` enables deduplication               |
| API restarted                          | an in-flight request may lose its response, but not atomicity                 | client retries with the same idempotency key                 |
| gateway restarted                      | sockets receive 1012 and temporarily miss updates                             | reconnect, fetch a snapshot, and subscribe from its version  |
| PostgreSQL unavailable                 | critical commands stop and readiness returns 503                              | external failover/restore and idempotent retry               |
| pool saturated                         | latency rises and admission reduces its batch                                 | reduce admission, scale the API, or fix the query/pool       |

## Not tolerated in this release

- PostgreSQL loss or corruption without external backups/failover;
- multi-region partitions, active-active operation, or cross-region consistency;
- simultaneous permanent loss of Redis/AOF and PostgreSQL;
- compromised secrets or credentials;
- DDoS beyond local limits, because WAF/CDN controls are outside this repository;
- incompatible schema changes without an expand/contract strategy.
