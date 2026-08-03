import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Pool } from 'pg';

export class ServiceMetrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly holdAttempts: Counter<'result'>;
  readonly holdConflicts: Counter<'code'>;
  readonly activeHolds: Gauge;
  readonly expiredHolds: Counter<'source'>;
  readonly expirationLag: Histogram<'source'>;
  readonly waitingRoomSize: Gauge;
  readonly admissionRate: Counter;
  readonly websocketConnections: Gauge;
  readonly websocketBroadcastDuration: Histogram<'result'>;
  readonly websocketDroppedMessages: Counter<'reason'>;
  readonly outboxPending: Gauge;
  readonly outboxOldestAge: Gauge;
  readonly bullmqJobs: Gauge<'queue' | 'state'>;
  readonly bullmqJobLag: Gauge<'queue'>;
  private pool?: Pool;
  private activeHoldsPool?: Pool;

  private readonly poolTotal = new Gauge({
    name: 'postgres_pool_connections',
    help: 'PostgreSQL pool connections by state.',
    labelNames: ['state'] as const,
    registers: [this.registry],
    collect: () => {
      if (!this.pool) return;
      this.poolTotal.set({ state: 'total' }, this.pool.totalCount);
      this.poolTotal.set({ state: 'idle' }, this.pool.idleCount);
      this.poolTotal.set({ state: 'busy' }, this.pool.totalCount - this.pool.idleCount);
    },
  });
  private readonly poolWaiting = new Gauge({
    name: 'postgres_pool_waiting_requests',
    help: 'Requests waiting for a PostgreSQL connection.',
    registers: [this.registry],
    collect: () => {
      if (this.pool) this.poolWaiting.set(this.pool.waitingCount);
    },
  });
  private readonly eventLoopLag = new Gauge({
    name: 'event_loop_lag_seconds',
    help: 'Event loop delay percentiles in seconds.',
    labelNames: ['quantile'] as const,
    registers: [this.registry],
    collect: () => {
      this.eventLoopLag.set({ quantile: 'p50' }, finite(this.loop.percentile(50) / 1e9));
      this.eventLoopLag.set({ quantile: 'p95' }, finite(this.loop.percentile(95) / 1e9));
      this.eventLoopLag.set({ quantile: 'p99' }, finite(this.loop.percentile(99) / 1e9));
      this.loop.reset();
    },
  });
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor(readonly service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration.',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.holdAttempts = new Counter({
      name: 'hold_attempts_total',
      help: 'Hold creation attempts.',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });
    this.holdConflicts = new Counter({
      name: 'hold_conflicts_total',
      help: 'Hold conflicts.',
      labelNames: ['code'] as const,
      registers: [this.registry],
    });
    this.activeHolds = new Gauge({
      name: 'active_holds',
      help: 'Active holds.',
      registers: [this.registry],
      collect: async () => {
        if (!this.activeHoldsPool) return;
        const result = await this.activeHoldsPool.query<{ count: string }>(
          "SELECT count(*) AS count FROM holds WHERE status = 'ACTIVE'",
        );
        this.activeHolds.set(Number(result.rows[0]?.count ?? 0));
      },
    });
    this.expiredHolds = new Counter({
      name: 'expired_holds_total',
      help: 'Expired holds.',
      labelNames: ['source'] as const,
      registers: [this.registry],
    });
    this.expirationLag = new Histogram({
      name: 'expiration_lag_seconds',
      help: 'Hold expiration delay.',
      labelNames: ['source'] as const,
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
      registers: [this.registry],
    });
    this.waitingRoomSize = new Gauge({
      name: 'waiting_room_size',
      help: 'Waiting room sessions.',
      registers: [this.registry],
    });
    this.admissionRate = new Counter({
      name: 'admission_rate',
      help: 'Admitted waiting-room sessions.',
      registers: [this.registry],
    });
    this.websocketConnections = new Gauge({
      name: 'websocket_connections',
      help: 'Open WebSocket connections.',
      registers: [this.registry],
    });
    this.websocketBroadcastDuration = new Histogram({
      name: 'websocket_broadcast_duration_seconds',
      help: 'WebSocket broadcast duration.',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });
    this.websocketDroppedMessages = new Counter({
      name: 'websocket_dropped_messages_total',
      help: 'Dropped WebSocket messages.',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending_events',
      help: 'Pending outbox events.',
      registers: [this.registry],
    });
    this.outboxOldestAge = new Gauge({
      name: 'outbox_oldest_event_age_seconds',
      help: 'Oldest pending outbox event age.',
      registers: [this.registry],
    });
    this.bullmqJobs = new Gauge({
      name: 'bullmq_jobs',
      help: 'BullMQ jobs by state.',
      labelNames: ['queue', 'state'] as const,
      registers: [this.registry],
    });
    this.bullmqJobLag = new Gauge({
      name: 'bullmq_job_lag_seconds',
      help: 'Age of the oldest waiting BullMQ job.',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });
    this.loop.enable();
  }

  observePool(pool: Pool): void {
    this.pool = pool;
  }

  observeActiveHolds(pool: Pool): void {
    this.activeHoldsPool = pool;
  }

  async content(): Promise<string> {
    return this.registry.metrics();
  }
  close(): void {
    this.loop.disable();
  }
}

export async function startMetricsServer(
  metrics: ServiceMetrics,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void metrics
      .content()
      .then((body) => {
        response.writeHead(200, { 'content-type': metrics.registry.contentType });
        response.end(body);
      })
      .catch(() => response.writeHead(503).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
