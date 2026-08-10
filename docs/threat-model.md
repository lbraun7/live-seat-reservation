# Threat model

## Ativos e fronteiras

Os ativos principais são inventário, identidade do comprador, tokens de admissão,
idempotência, pedidos e segredos de webhook. Internet→API/gateway, processos→PostgreSQL,
processos→Redis e provider→webhook são fronteiras de confiança.

| Ameaça                            | Controle existente                                            | Risco residual / ação de produção                                  |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| overselling por corrida           | transação, lock, índice único e testes concorrentes           | erro operacional em migration; bloquear deploy se migration falhar |
| replay de comando                 | chave de idempotência vinculada a usuário, operação e payload | limitar retenção com política compatível ao retry do cliente       |
| token de admissão forjado/reusado | HMAC, TTL, vínculo a usuário/evento/sessão e consumo único    | armazenar segredo em KMS e rotacionar com sobreposição             |
| webhook forjado/reordenado        | HMAC, deduplicação por eventId e occurredAt                   | allowlist/mTLS se o provider oferecer                              |
| abuso HTTP/WS                     | limites por usuário/sessão/IP, payload, mensagens e buffer    | WAF e limite distribuído por ASN/IP em produção                    |
| exaustão de pool/fila             | admission control, pool limitado, backpressure e alertas      | autoscaling e budgets por evento                                   |
| leitura ou alteração de Redis     | rede privada; Redis nunca autoriza venda                      | TLS/ACL e isolamento de rede                                       |
| vazamento em logs/traces          | correlação sem payload sensível e política de redaction       | scanner de logs e retenção mínima                                  |
| dependência comprometida          | lockfile e CI                                                 | Dependabot/SBOM, assinatura e scan de imagem                       |

Não há autenticação final, pagamento real, TLS termination ou gestão de segredo no escopo do
primeiro release. Portanto, este repositório é demonstrável, mas não deve ser exposto à
internet como produto financeiro sem esses controles.
