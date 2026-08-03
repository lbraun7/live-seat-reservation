# Observabilidade

Cada processo publica métricas Prometheus e inicia OpenTelemetry quando
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` está definido. A propagação W3C `traceparent` é
aceita nas requisições HTTP; as instrumentações de Fastify/HTTP, PostgreSQL, Redis e
BullMQ criam spans dos limites técnicos. O `x-correlation-id` continua sendo o identificador
de suporte visível ao cliente e deve ser incluído nos logs da API.

## Uso local

```bash
docker compose up --build
```

- Grafana: http://localhost:3002 (`admin` / `admin`, somente desenvolvimento)
- Prometheus: http://localhost:9090
- Tempo: http://localhost:3200
- Métricas da API: http://localhost:3000/metrics
- Métricas do gateway: http://localhost:3001/metrics
- Métricas do relay: http://localhost:9464/metrics

O dashboard provisionado **Live Seat Reservation — Overview** mostra latência HTTP,
conflitos, pool PostgreSQL, expiração/BullMQ, outbox, waiting room, WebSocket e event loop.
Tempo aparece como datasource do Grafana para pesquisar traces por serviço e trace ID.

## Correlação

1. Preserve `x-correlation-id` ao repetir uma chamada ou investigar um erro.
2. Use o trace HTTP no Tempo para seguir queries PostgreSQL, operações Redis e jobs BullMQ.
3. Use `eventId`, `aggregateId`, `holdId` e `jobId` dos logs estruturados para cruzar a
   transação, outbox, expiração e broadcast. Esses IDs são estáveis mesmo quando uma
   mensagem é entregue mais de uma vez.

## Redaction de dados sensíveis

Nunca registrar headers `authorization`, `cookie`, `x-admission-token`,
`x-payment-signature`, segredos, URLs com credenciais ou corpos completos de webhook.
Identificadores de usuário e IP devem ser omitidos ou transformados em hash nos logs de
produção. São permitidos IDs técnicos (`holdId`, `seatId`, `orderId`, `eventId`, `jobId`),
códigos de erro, durações e contagens. Exceções devem ser serializadas sem parâmetros SQL
nem payloads. A configuração do Fastify não registra headers/body; qualquer logger futuro
deve aplicar essa lista explícita de redaction antes de ser habilitado.
