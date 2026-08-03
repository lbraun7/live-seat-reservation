# Live Seat Reservation

Sistema de reserva de assentos para flash sales, construído como monólito modular em Node.js e TypeScript. O PostgreSQL será a fonte da verdade; Redis apoia coordenação e desempenho.

## Requisitos

- Node.js 22+
- Docker com Docker Compose

## Executar localmente

Toda a stack, incluindo migrations e API, sobe com um comando:

```bash
docker compose up --build
```

Para desenvolver a API localmente com reload automático:

```bash
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run migrate
npm run dev
```

Em outro terminal, inicie o worker de expiração:

```bash
npm run dev:worker
```

E o relay da Transactional Outbox:

```bash
npm run dev:outbox-relay
```

E o gateway de atualizações em tempo real:

```bash
npm run dev:websocket-gateway
```

E o controlador da sala de espera:

```bash
npm run dev:admission-controller
```

A API fica disponível em `http://localhost:3000`.

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

- `GET /health/live` confirma que o processo está respondendo.
- `GET /health/ready` retorna `200` somente se PostgreSQL e Redis responderem; caso contrário, retorna `503`.
- Toda resposta inclui `x-correlation-id`. Um valor enviado pelo cliente nesse header é preservado quando tem até 128 caracteres.

## Catálogo e mapa de assentos

O startup do Docker Compose aplica as migrations e cria, de forma idempotente, um evento
de demonstração com três seções e 3.000 assentos:

```bash
EVENT_ID=10000000-0000-4000-8000-000000000001
SECTION_ID=20000000-0000-4000-8000-000000000001

curl "http://localhost:3000/events/$EVENT_ID"
curl "http://localhost:3000/events/$EVENT_ID/seats?sectionId=$SECTION_ID&limit=200"
```

O mapa é paginado por seção. Para buscar a página seguinte, envie o `nextCursor` retornado
como query parameter `cursor`. Cada snapshot contém uma versão monotônica do evento, que
permite ao cliente detectar mudanças e ressincronizar o mapa.

## Reservas

Comandos de reserva exigem um usuário UUID em `x-user-id` e uma chave de idempotência.
Para criar um hold, o cliente também precisa passar primeiro pela sala de espera e enviar o
token de admissão:

```bash
USER_ID=40000000-0000-4000-8000-000000000001
SEAT_ID=30000000-0000-4000-8000-000000000001

curl -X POST "http://localhost:3000/events/$EVENT_ID/waiting-room" \
  -H "x-user-id: $USER_ID"

# Envie heartbeat até a resposta conter token:
curl -X POST \
  "http://localhost:3000/events/$EVENT_ID/waiting-room/$SESSION_ID/heartbeat" \
  -H "x-user-id: $USER_ID"

curl -X POST "http://localhost:3000/events/$EVENT_ID/holds" \
  -H "content-type: application/json" \
  -H "x-user-id: $USER_ID" \
  -H "x-admission-token: $ADMISSION_TOKEN" \
  -H "idempotency-key: create-1" \
  -d "{\"seatId\":\"$SEAT_ID\"}"

curl "http://localhost:3000/holds/$HOLD_ID" -H "x-user-id: $USER_ID"

curl -X POST "http://localhost:3000/holds/$HOLD_ID/confirm" \
  -H "x-user-id: $USER_ID" \
  -H "idempotency-key: confirm-1"

curl -X POST "http://localhost:3000/holds/$HOLD_ID/cancel" \
  -H "x-user-id: $USER_ID" \
  -H "idempotency-key: cancel-1"
```

Repetir um comando com a mesma chave e payload devolve a resposta persistida e inclui
`idempotency-replayed: true`. Reutilizar a chave com outro payload retorna
`IDEMPOTENCY_KEY_REUSED`.

## Checkout e pagamento simulado

Um checkout só começa para um hold ativo e pertence ao mesmo usuário. A mesma chave de
idempotência devolve o pagamento original:

```bash
curl -X POST "http://localhost:3000/holds/$HOLD_ID/checkout" \
  -H "x-user-id: $USER_ID" -H "idempotency-key: checkout-1"
```

O fake provider devolve um `providerPaymentId`. Para simular seu callback, envie um evento
para `POST /webhooks/fake-payment` com `x-payment-signature`, calculado como HMAC-SHA256 de
`eventId.providerPaymentId.type.occurredAt` usando `PAYMENT_WEBHOOK_SECRET`. Eventos são
deduplicados por `eventId` e os mais antigos que o último callback aplicado são ignorados.

O sucesso confirma hold, assento e pedido na mesma transação. Falha, cancelamento e timeout
liberam o assento sem criar pedido. A política para sucesso após expiração ou outro estado
terminal é marcar o pagamento como `LATE_SUCCEEDED`: o assento não é vendido e o registro
fica explicitamente sinalizado para estorno. Toda mudança fica em `payment_transitions`.

## Sala de espera

A fila de cada evento é um Redis ZSET ordenado pelo instante de entrada e, em empates, pelo
UUID da sessão. Sessões sem heartbeat expiram e são removidas. Um ou mais processos
`admission-controller` executam um script Lua atômico que limpa admissões vencidas, respeita
o teto global de admissões ativas e libera o próximo lote.

O lote diminui automaticamente quando há espera no pool PostgreSQL ou quando a sonda do
banco ultrapassa o limite de latência. O token HMAC dura 60 segundos, pertence a um único
usuário, evento e sessão e só pode autorizar uma chave de idempotência. Limites adicionais
são aplicados por usuário, sessão e IP; o PostgreSQL limita atomicamente os holds ativos de
um usuário.

Para receber posições aproximadas pelo gateway, envie:

```json
{
  "type": "waiting-room.subscribe",
  "eventId": "10000000-0000-4000-8000-000000000001",
  "sessionId": "UUID_DA_SESSAO"
}
```

O gateway responde com `waiting-room.position` e, após a admissão,
`waiting-room.admitted`, incluindo o token.

Os testes reais de concorrência precisam de um banco já migrado:

```bash
TEST_DATABASE_URL=postgresql://reservation:reservation@localhost:5432/reservation \
  npm run test:integration
```

## Transactional Outbox

Criação, confirmação, cancelamento e expiração de holds gravam um evento em
`outbox_events` dentro da mesma transação PostgreSQL da mudança. O processo
`outbox-relay` busca lotes concorrentes com `FOR UPDATE SKIP LOCKED` e publica
envelopes JSON no canal Redis `reservation.domain-events`.

O envelope contém um `eventId` UUID estável. Como uma queda após a publicação e
antes da confirmação no banco pode gerar uma republicação, consumidores podem
usar `IdempotentEventConsumer`, que registra o evento em `consumed_events` na
mesma transação do efeito. Tentativas falhas recebem backoff e eventos publicados
são arquivados após o período configurado.

Métricas Prometheus do relay:

```bash
curl http://localhost:9464/metrics
```

As gauges `outbox_pending_events` e `outbox_oldest_event_age_seconds` mostram
o backlog e a idade do evento pendente mais antigo.

## Observabilidade

O Docker Compose também sobe Prometheus, Grafana, OpenTelemetry Collector e Tempo.
Abra o Grafana em `http://localhost:3002` (`admin` / `admin` no ambiente local) para usar
o dashboard provisionado **Live Seat Reservation — Overview** e pesquisar traces. O
Prometheus fica em `http://localhost:9090`; API e gateway expõem `/metrics` em suas portas.

Métricas cobrem HTTP, tentativas/conflitos de hold, holds ativos, expiração, sala de espera,
admissão, conexões e backpressure WebSocket, outbox, pool PostgreSQL, BullMQ e event-loop
lag. Alertas e instruções operacionais estão versionados em `observability/alerts.yml` e
`docs/runbooks/observability.md`. A estratégia de correlação e redaction está em
`docs/observability.md`.

## Atualizações em tempo real

O gateway WebSocket escuta em `ws://localhost:3001/ws`. A conexão exige um UUID em
`x-user-id`; depois de conectar, o cliente informa a versão do snapshot HTTP que já
possui:

```json
{ "type": "subscribe", "eventId": "10000000-0000-4000-8000-000000000001", "lastVersion": 1 }
```

Cada alteração chega como `seat.updated`, com `messageId`, `eventId`, `seatId`,
`version`, `occurredAt` e o novo `status`. Mensagens repetidas ou antigas são
ignoradas. Se a próxima versão não for contígua, o gateway envia
`resync.required` com a URL do snapshot; o cliente deve buscar novamente
`GET /events/:eventId/seats`, considerando todas as páginas/seções necessárias, e
refazer a inscrição com a nova versão.

Cada instância assina o canal Redis da outbox, portanto clientes conectados em
gateways diferentes recebem o mesmo broadcast. Ping/pong remove conexões mortas;
limites de payload, frequência e buffer protegem o processo de clientes abusivos
ou lentos. Durante shutdown o gateway para upgrades, envia `server.draining` e
fecha as conexões com código `1012`.

## Comandos

| Comando                              | Finalidade                                          |
| ------------------------------------ | --------------------------------------------------- |
| `npm run dev`                        | API com reload automático                           |
| `npm run dev:worker`                 | Worker de expiração com reload automático           |
| `npm run dev:outbox-relay`           | Relay da outbox com reload automático               |
| `npm run migrate`                    | Aplica migrations pendentes com lock no PostgreSQL  |
| `npm run seed`                       | Cria o evento de demonstração e 3.000 assentos      |
| `npm run test:integration`           | Testa invariantes contra PostgreSQL real            |
| `npm run check`                      | Lint, formatação, tipos, testes e build             |
| `npm start`                          | Executa o build de produção                         |
| `npm run start:worker`               | Executa o worker compilado                          |
| `npm run start:outbox-relay`         | Executa o relay compilado                           |
| `npm run dev:websocket-gateway`      | Gateway WebSocket com reload automático             |
| `npm run dev:admission-controller`   | Controlador da sala de espera com reload automático |
| `npm run start:websocket-gateway`    | Executa o gateway WebSocket compilado               |
| `npm run start:admission-controller` | Executa o controlador de admissão compilado         |

O processo trata `SIGINT` e `SIGTERM`, para de aceitar requisições e encerra as conexões com PostgreSQL e Redis antes de sair.

Consulte o [ROADMAP.md](./ROADMAP.md) para as próximas fases.
