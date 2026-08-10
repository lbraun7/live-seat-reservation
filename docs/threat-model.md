# Threat model

## Assets and trust boundaries

The primary assets are inventory, buyer identity, admission tokens, idempotency state, orders, and webhook secrets. Internet→API/gateway, processes→PostgreSQL, processes→Redis, and provider→webhook are trust boundaries.

| Threat                        | Existing control                                              | Residual risk / production action                                  |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| race-condition overselling    | transactions, locks, unique indexes, and concurrent tests     | operational migration error; block deployment when migrations fail |
| command replay                | idempotency key bound to user, operation, and payload         | define retention compatible with the client retry policy           |
| forged/reused admission token | HMAC, TTL, user/event/session binding, and single use         | store the secret in KMS and rotate with overlap                    |
| forged/reordered webhook      | HMAC, `eventId` deduplication, and `occurredAt` ordering      | use allowlists/mTLS when supported by the provider                 |
| HTTP/WS abuse                 | user/session/IP, payload, message, and buffer limits          | WAF and distributed ASN/IP limits in production                    |
| pool/queue exhaustion         | admission control, bounded pools, backpressure, and alerts    | autoscaling and per-event budgets                                  |
| Redis reads or tampering      | private network; Redis never authorizes a sale                | TLS/ACL and network isolation                                      |
| log/trace leakage             | correlation without sensitive payloads and a redaction policy | log scanning and minimal retention                                 |
| compromised dependency        | lockfile and CI                                               | Dependabot/SBOM, signatures, and image scanning                    |

Final authentication, real payments, TLS termination, and secret management are outside the first release. This repository is suitable for demonstration but must not be exposed to the internet as a financial product without those controls.
