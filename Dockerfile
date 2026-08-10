FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node

FROM runtime-base AS api
EXPOSE 3000
CMD ["node", "dist/apps/api/main.js"]

FROM runtime-base AS worker
EXPOSE 9464
CMD ["node", "dist/apps/worker/main.js"]

FROM runtime-base AS outbox-relay
EXPOSE 9464
CMD ["node", "dist/apps/outbox-relay/main.js"]

FROM runtime-base AS websocket-gateway
EXPOSE 3001
CMD ["node", "dist/apps/websocket-gateway/main.js"]

FROM runtime-base AS admission-controller
EXPOSE 9464
CMD ["node", "dist/apps/admission-controller/main.js"]

FROM runtime-base AS migrate
CMD ["node", "dist/shared/database/migrate.js"]

FROM runtime-base AS seed
CMD ["node", "dist/apps/seed/main.js"]
