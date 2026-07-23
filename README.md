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

## Comandos

| Comando           | Finalidade                                         |
| ----------------- | -------------------------------------------------- |
| `npm run dev`     | API com reload automático                          |
| `npm run migrate` | Aplica migrations pendentes com lock no PostgreSQL |
| `npm run seed`    | Cria o evento de demonstração e 3.000 assentos     |
| `npm run check`   | Lint, formatação, tipos, testes e build            |
| `npm start`       | Executa o build de produção                        |

O processo trata `SIGINT` e `SIGTERM`, para de aceitar requisições e encerra as conexões com PostgreSQL e Redis antes de sair.

Consulte o [ROADMAP.md](./ROADMAP.md) para as próximas fases.
