# Roadmap — Live Seat Reservation

Sistema de reserva de assentos para flash sales, projetado para demonstrar concorrência, consistência, tolerância a falhas, processamento assíncrono, comunicação em tempo real e observabilidade com Node.js.

## Objetivo

Construir e demonstrar um sistema no qual milhares de usuários possam disputar assentos de um mesmo evento sem overselling, inclusive na presença de:

- requisições concorrentes;
- retries de rede;
- mensagens duplicadas ou atrasadas;
- reinício de processos;
- atraso ou indisponibilidade temporária de workers;
- múltiplas instâncias da API e do gateway WebSocket;
- indisponibilidade temporária do Redis.

O PostgreSQL será a fonte da verdade. Redis, BullMQ e WebSocket serão usados para desempenho, coordenação e propagação de eventos, mas não poderão ser necessários para garantir que um assento seja vendido apenas uma vez.

## Princípios arquiteturais

1. **PostgreSQL é a autoridade de consistência.**
2. **Redis não participa da garantia de ausência de overselling.**
3. **Toda operação que pode ser repetida deve ser idempotente.**
4. **Processamento assíncrono assume entrega pelo menos uma vez.**
5. **WebSocket é um mecanismo de atualização, não uma fonte da verdade.**
6. **Dual writes serão evitados com Transactional Outbox.**
7. **Falhas esperadas devem possuir mecanismos de recuperação.**
8. **A correção será comprovada por constraints, testes concorrentes e testes de falha.**
9. **O projeto começa como monólito modular executado em processos separados.**
10. **Complexidade será adicionada somente quando houver uma hipótese mensurável.**

## Invariantes do domínio

- Um assento não pode pertencer a dois pedidos confirmados.
- Um assento pode possuir no máximo um hold ativo.
- Um usuário só pode confirmar ou cancelar um hold que lhe pertence.
- Um hold expirado não pode ser confirmado.
- Confirmar e expirar o mesmo hold concorrentemente não pode corromper o estado.
- Repetir uma operação com a mesma chave de idempotência e payload deve produzir o mesmo resultado.
- Reutilizar a mesma chave de idempotência com outro payload deve falhar.
- Processar o mesmo job ou evento mais de uma vez não pode duplicar efeitos.
- Uma liberação atrasada não pode liberar um hold ou pedido mais recente.
- Um cliente não admitido pela sala de espera não pode criar holds.
- A indisponibilidade do Redis não pode causar overselling.

## Máquina de estados

### Assento

```text
AVAILABLE ──hold──▶ HELD ──confirm──▶ SOLD
    ▲                 │
    └────expire───────┘
```

### Hold

```text
ACTIVE ──confirm──▶ CONFIRMED
   ├────cancel────▶ CANCELLED
   └────expire────▶ EXPIRED
```

As transições devem ser condicionais e atômicas no PostgreSQL. Apenas uma operação poderá vencer uma corrida entre confirmação, cancelamento e expiração.

## Arquitetura-alvo

```text
                               ┌─────────────────────┐
                               │   Waiting Room      │
Cliente ──HTTP/WS──▶ API/Gateway│   Redis ZSET        │
                               └─────────┬───────────┘
                                         │ admission token
                                         ▼
                               ┌─────────────────────┐
                               │ Reservation Module  │
                               └─────────┬───────────┘
                                         │ transação
                                         ▼
                               ┌─────────────────────┐
                               │ PostgreSQL          │
                               │ seats / holds       │
                               │ orders / outbox     │
                               └──────┬────────┬─────┘
                                      │        │
                         expiração    │        │ outbox relay
                                      ▼        ▼
                                  BullMQ    Redis Pub/Sub
                                      │        │
                                      ▼        ▼
                                   Worker   Gateways WS
```

### Processos

- `api`: comandos e consultas HTTP;
- `websocket-gateway`: fila, presença e atualizações em tempo real;
- `worker`: expiração, reconciliação e tarefas assíncronas;
- `outbox-relay`: publicação confiável dos eventos confirmados no banco.

Todos podem compartilhar a mesma codebase e os mesmos módulos de domínio, mas devem poder ser iniciados e escalados separadamente.

## Stack inicial

- Node.js LTS;
- TypeScript com `strict: true`;
- Fastify;
- PostgreSQL;
- Redis;
- BullMQ;
- `ws` ou `@fastify/websocket`;
- Kysely ou Drizzle para queries, mantendo SQL explícito para concorrência;
- migrations SQL;
- TypeBox/JSON Schema para contratos HTTP;
- Pino;
- OpenTelemetry;
- Prometheus e Grafana;
- Vitest;
- k6;
- Docker Compose.

## Estrutura sugerida

```text
src/
├── apps/
│   ├── api/
│   ├── websocket-gateway/
│   ├── worker/
│   └── outbox-relay/
├── modules/
│   ├── catalog/
│   ├── reservations/
│   ├── waiting-room/
│   ├── orders/
│   └── realtime/
├── shared/
│   ├── database/
│   ├── redis/
│   ├── observability/
│   └── contracts/
└── bootstrap/

tests/
├── unit/
├── integration/
├── concurrency/
├── e2e/
└── load/
```

Cada módulo poderá conter `domain`, `application`, `infrastructure` e adaptadores de transporte. As regras de negócio não devem depender diretamente de Fastify, BullMQ ou WebSocket.

---

# Fases de implementação

## Fase 0 — Design e decisões

### Tarefas

- [ ] Definir objetivos e não objetivos do primeiro release.
- [ ] Documentar as invariantes do domínio.
- [ ] Desenhar as máquinas de estado de assento, hold e pedido.
- [ ] Definir a política para confirmação próxima da expiração.
- [ ] Definir a semântica de idempotência.
- [ ] Definir SLOs iniciais e limites de capacidade.
- [ ] Criar o diretório `docs/adr`.
- [ ] Registrar as primeiras Architecture Decision Records.

### ADRs iniciais

- [ ] PostgreSQL como fonte da verdade.
- [ ] Atualização condicional em vez de Redis lock para correção.
- [ ] Monólito modular com múltiplos processos.
- [ ] At-least-once com consumidores idempotentes.
- [ ] Transactional Outbox para publicação de eventos.
- [ ] WebSocket com versionamento e ressincronização por HTTP.

### Critério de aceite

As principais decisões e invariantes estão escritas antes da implementação do núcleo de reservas.

---

## Fase 1 — Fundação do projeto

### Tarefas

- [x] Inicializar Git e o projeto Node.js.
- [x] Configurar TypeScript estrito.
- [x] Configurar lint, formatter e typecheck.
- [x] Criar Docker Compose com PostgreSQL e Redis.
- [x] Adicionar configuração validada no startup.
- [x] Criar migrations e comando de execução.
- [x] Implementar logs estruturados com correlation ID.
- [x] Adicionar endpoints de liveness e readiness.
- [x] Implementar shutdown gracioso e encerramento de conexões.
- [x] Configurar CI para lint, typecheck, testes e build.
- [x] Criar `.env.example` sem segredos reais.

### Critério de aceite

Um comando sobe a infraestrutura e a aplicação; CI e health checks passam em ambiente limpo.

---

## Fase 2 — Catálogo de eventos e assentos

### Tarefas

- [x] Criar tabelas `events`, `seat_sections` e `seats`.
- [x] Garantir unicidade de `event_id + seat_label`.
- [x] Criar seed de um evento com milhares de assentos.
- [x] Implementar consulta do evento.
- [x] Implementar snapshot do mapa de assentos.
- [x] Agrupar ou paginar assentos por seção.
- [x] Adicionar campo monotônico de versão ao estado publicado.
- [x] Validar e serializar requests e responses por schema.

### Critério de aceite

Um cliente consegue consultar um snapshot consistente e versionado do mapa de assentos.

---

## Fase 3 — Núcleo de reservas

### Tarefas

- [x] Criar tabelas `holds`, `orders` e `order_items`.
- [x] Modelar constraints que impeçam venda duplicada.
- [x] Implementar criação de hold com atualização condicional.
- [x] Calcular expiração usando o relógio do PostgreSQL.
- [x] Implementar consulta, cancelamento e confirmação de hold.
- [x] Verificar ownership em todas as transições.
- [x] Implementar retry limitado para deadlock e erro de serialização.
- [x] Criar códigos de erro de domínio estáveis.
- [x] Implementar tabela e middleware de idempotência.
- [x] Persistir hash do request e resultado da operação.

### Testes obrigatórios

- [x] Cem ou mais requisições disputam o mesmo assento e exatamente uma vence.
- [x] Repetir uma request retorna o mesmo hold.
- [x] Mesma chave com payload diferente retorna conflito.
- [x] Hold expirado não pode ser confirmado.
- [x] Um usuário não opera o hold de outro.
- [x] Confirmação e expiração concorrentes preservam as invariantes.
- [x] Um assento confirmado jamais volta para disponível.

### Critério de aceite

Os testes comprovam zero overselling usando apenas o PostgreSQL como mecanismo de correção.

---

## Fase 4 — Expiração resiliente

### Tarefas

- [x] Configurar BullMQ.
- [x] Agendar delayed job na criação do hold.
- [x] Implementar worker de expiração idempotente.
- [x] Implementar retries com backoff e jitter.
- [x] Criar estratégia para jobs definitivamente falhos.
- [x] Implementar reconciliador periódico de holds vencidos.
- [x] Processar lotes com `FOR UPDATE SKIP LOCKED`.
- [x] Permitir várias instâncias do reconciliador.
- [x] Medir atraso entre expiração prevista e efetiva.

### Testes obrigatórios

- [x] Executar duas vezes o mesmo job não causa efeito adicional.
- [x] Worker reiniciado recupera holds vencidos.
- [x] Reconciliador corrige um delayed job perdido ou atrasado.
- [x] Job antigo não libera um hold ou pedido mais recente.

### Critério de aceite

Holds vencidos são recuperados mesmo após indisponibilidade temporária dos workers.

---

## Fase 5 — Transactional Outbox

### Tarefas

- [x] Criar tabela `outbox_events`.
- [x] Inserir o evento na mesma transação da mudança de domínio.
- [x] Implementar relay em lotes.
- [x] Publicar eventos no Redis.
- [x] Registrar tentativas e publicação concluída.
- [x] Permitir publicação duplicada sem efeitos incorretos.
- [x] Limpar ou arquivar registros antigos.
- [x] Adicionar métrica de eventos pendentes e idade do mais antigo.

### Testes obrigatórios

- [x] Simular queda entre commit e publicação.
- [x] Confirmar publicação após reinício do relay.
- [x] Processar evento duplicado sem duplicar efeitos.

### Critério de aceite

Toda mudança confirmada no banco produz um evento recuperável sem dual write inseguro.

---

## Fase 6 — Atualizações em tempo real

### Tarefas

- [x] Criar gateway WebSocket autenticado.
- [x] Implementar inscrição por evento.
- [x] Implementar heartbeat com ping/pong.
- [x] Remover conexões mortas.
- [x] Propagar eventos entre múltiplas instâncias via Redis.
- [x] Adicionar `eventId`, `seatId`, `version` e `occurredAt` aos eventos.
- [x] Ignorar eventos antigos ou duplicados no consumidor.
- [x] Detectar gaps de versão.
- [x] Permitir ressincronização por snapshot HTTP.
- [x] Limitar tamanho e frequência de mensagens.
- [x] Controlar clientes lentos usando `bufferedAmount`.
- [x] Implementar graceful draining no gateway.

### Testes obrigatórios

- [x] Clientes conectados a gateways diferentes recebem a atualização.
- [x] Mensagem duplicada não regride o estado.
- [x] Gap de versão provoca ressincronização.
- [x] Reconnect storm não derruba o processo.
- [x] Cliente lento não causa crescimento ilimitado de memória.

### Critério de aceite

O mapa é atualizado em múltiplas instâncias e consegue se recuperar de mensagens perdidas.

---

## Fase 7 — Sala de espera

### Tarefas

- [x] Implementar fila no Redis ZSET.
- [x] Definir ordenação determinística para empates.
- [x] Implementar heartbeat de sessões em espera.
- [x] Informar posição aproximada via WebSocket.
- [x] Criar admission controller com liberação em lotes.
- [x] Emitir admission token curto, assinado e vinculado ao usuário e evento.
- [x] Impedir reutilização da admissão.
- [x] Proteger a criação de holds com o admission token.
- [x] Aplicar rate limit por usuário, sessão e IP.
- [x] Limitar holds simultâneos por usuário.
- [x] Implementar backpressure quando banco ou workers estiverem saturados.
- [x] Evoluir lote fixo para admissão adaptativa baseada em métricas.

### Testes obrigatórios

- [x] Cliente não admitido não consegue reservar.
- [x] Token expirado ou de outro evento é rejeitado.
- [x] Token consumido não pode ser reutilizado.
- [x] Sessão abandonada é removida.
- [x] Múltiplos admission controllers não liberam além do limite definido.

### Critério de aceite

A fila controla efetivamente a taxa de entrada; não serve apenas como posição visual.

---

## Fase 8 — Checkout e pagamento simulado

### Tarefas

- [x] Criar fake payment provider.
- [x] Iniciar checkout a partir de um hold válido.
- [x] Implementar webhook assinado.
- [x] Deduplicar webhooks.
- [x] Tolerar callbacks fora de ordem.
- [x] Confirmar pedido atomicamente.
- [x] Definir política para pagamento concluído após a expiração.
- [x] Implementar timeout, falha e cancelamento do pagamento.
- [x] Registrar histórico mínimo das transições.

### Testes obrigatórios

- [x] Webhook duplicado não cria dois pedidos.
- [x] Pagamento atrasado segue a política documentada.
- [x] Falha de pagamento não vende o assento.
- [x] Retry do checkout retorna o resultado original.

### Critério de aceite

O fluxo completo tolera webhooks duplicados, atrasados e fora de ordem.

---

## Fase 9 — Observabilidade

### Tarefas

- [x] Expor métricas Prometheus.
- [x] Criar dashboards Grafana.
- [x] Instrumentar traces com OpenTelemetry.
- [x] Correlacionar API, transação, job, outbox e broadcast.
- [x] Medir uso e fila do pool de conexões.
- [x] Monitorar event-loop lag.
- [x] Criar alertas e runbooks básicos.
- [x] Redigir estratégia de redaction de dados sensíveis nos logs.

### Métricas mínimas

- `http_request_duration_seconds`;
- `hold_attempts_total`;
- `hold_conflicts_total`;
- `active_holds`;
- `expired_holds_total`;
- `expiration_lag_seconds`;
- `waiting_room_size`;
- `admission_rate`;
- `websocket_connections`;
- `websocket_broadcast_duration_seconds`;
- `websocket_dropped_messages_total`;
- `outbox_pending_events`;
- `outbox_oldest_event_age_seconds`;
- `event_loop_lag_seconds`;
- tamanho e saturação do pool PostgreSQL;
- atraso e quantidade de jobs BullMQ.

### Critério de aceite

É possível identificar contenção, saturação, atraso de jobs, gaps de publicação e clientes lentos pelos dashboards e traces.

---

## Fase 10 — Testes de carga e resiliência

### Cenários k6

- [x] Milhares de usuários reservando assentos distintos.
- [x] Milhares de usuários disputando o mesmo assento.
- [x] Spike de entrada na sala de espera.
- [x] Reconnect storm no WebSocket.
- [x] Redis indisponível durante reservas.
- [x] Worker indisponível por vários minutos.
- [x] API reiniciada durante a criação de holds.
- [x] Outbox relay interrompido após commits.
- [x] Eventos e jobs entregues mais de uma vez.
- [x] Pool PostgreSQL saturado.
- [x] Clientes WebSocket deliberadamente lentos.

### Resultados a registrar

- throughput;
- p50, p95 e p99;
- taxa de erro;
- conflitos esperados;
- event-loop lag;
- CPU e memória por processo;
- conexões WebSocket por instância;
- tempo de propagação do broadcast;
- atraso de expiração;
- tamanho e idade da outbox;
- número de assentos vendidos mais de uma vez, que deve ser zero.

### Experimento opcional: Redis fast-rejection

- [ ] Medir o fluxo usando apenas PostgreSQL.
- [ ] Adicionar lock curto no Redis apenas como otimização.
- [ ] Repetir o mesmo teste.
- [ ] Comparar throughput, latência, carga no banco e comportamento sob falhas.
- [ ] Documentar por que a correção continua pertencendo ao PostgreSQL.

### Critério de aceite

O relatório é reproduzível e demonstra zero overselling nos cenários de contenção e falha definidos.

---

## Fase 11 — Deploy e apresentação

### Tarefas

- [x] Criar imagens Docker separadas por processo.
- [x] Executar migrations de forma controlada no deploy.
- [x] Configurar readiness com dependências essenciais.
- [x] Implementar draining durante deploy e encerramento.
- [x] Publicar diagrama de arquitetura.
- [x] Publicar diagramas de sequência dos fluxos críticos.
- [x] Adicionar threat model.
- [x] Adicionar capacity planning básico.
- [x] Documentar falhas toleradas e não toleradas.
- [x] Criar runbook de incidentes.
- [x] Publicar ADRs e resultados dos testes de carga.
- [x] Publicar uma demonstração curta e reproduzível do sistema sob disputa concorrente.

### Critério de aceite

Uma pessoa consegue subir, testar, observar e compreender as decisões do sistema seguindo apenas o repositório.

---

## Fora do primeiro release

Itens deliberadamente adiados para evitar complexidade prematura:

- múltiplas regiões;
- Kubernetes;
- Kafka;
- Redlock com múltiplos nós independentes;
- event sourcing completo;
- pagamento real;
- frontend elaborado;
- pricing dinâmico;
- seleção automática sofisticada de assentos;
- microsserviços em repositórios separados.

Esses itens podem ser descritos em uma seção de evolução para produção, sem serem necessários para provar o núcleo do projeto.

## Evidências esperadas para o portfólio

Ao final, o repositório deverá apresentar:

- um teste concorrente com apenas um vencedor por assento;
- zero overselling mesmo quando Redis estiver indisponível;
- teste da corrida entre confirmação e expiração;
- recuperação da outbox após interrupção;
- recuperação do cliente WebSocket após gap de versão;
- dashboard de event-loop lag, backpressure e filas;
- comparação PostgreSQL puro versus Redis como fast-rejection;
- relatório de carga com p50, p95, p99 e throughput;
- ADRs explicando os trade-offs;
- seção clara sobre limites e modos de falha.

## Definição de pronto do projeto

O projeto será considerado pronto quando:

- [ ] todas as invariantes críticas possuírem testes automatizados;
- [ ] o teste de carga reproduzível demonstrar zero overselling;
- [ ] retries e duplicações forem tratados de forma idempotente;
- [ ] expiração funcionar após indisponibilidade de workers;
- [ ] publicação de eventos sobreviver a crashes;
- [ ] clientes em tempo real conseguirem ressincronizar o estado;
- [ ] sala de espera controlar a taxa real de admissão;
- [ ] métricas, logs e traces permitirem diagnosticar os fluxos críticos;
- [ ] CI, Docker Compose e documentação permitirem reprodução por terceiros;
- [ ] decisões e limitações estiverem documentadas no README e nas ADRs.
