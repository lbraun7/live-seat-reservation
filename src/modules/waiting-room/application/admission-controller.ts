import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { ServiceMetrics } from '../../../shared/observability/metrics.js';

const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local batch = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local active = redis.call('ZCARD', KEYS[2])
local count = math.min(batch, math.max(0, capacity - active))
local admitted = {}
local inspected = 0
while #admitted < count and inspected < count + 1000 do
  local item = redis.call('ZPOPMIN', KEYS[1], 1)
  if #item == 0 then break end
  inspected = inspected + 1
  if redis.call('EXISTS', ARGV[5] .. item[1]) == 1 then
    redis.call('ZADD', KEYS[2], expires, item[1])
    table.insert(admitted, item[1])
  end
end
return admitted
`;

export interface AdmissionControllerOptions {
  eventId: string;
  intervalMs: number;
  batchSize: number;
  maxActiveAdmissions: number;
  admissionTtlSeconds: number;
  saturationLatencyMs: number;
  maxExpirationBacklog?: number;
}

export class AdmissionController {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly database: Pool,
    private readonly options: AdmissionControllerOptions,
    private readonly metrics?: ServiceMetrics,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async admitOnce(): Promise<string[]> {
    const started = Date.now();
    await this.database.query('SELECT 1');
    const latency = Date.now() - started;
    const poolSaturated = this.database.waitingCount > 0;
    const [waitingJobs, delayedJobs] = await Promise.all([
      this.redis.llen('bull:hold-expiration:wait'),
      this.redis.zcard('bull:hold-expiration:delayed'),
    ]);
    const workersSaturated =
      waitingJobs + delayedJobs > (this.options.maxExpirationBacklog ?? 10_000);
    const adaptiveBatch =
      poolSaturated || workersSaturated || latency >= this.options.saturationLatencyMs
        ? Math.max(1, Math.floor(this.options.batchSize / 4))
        : this.options.batchSize;
    const now = Date.now();
    const expires = now + this.options.admissionTtlSeconds * 1000;
    const admitted = (await this.redis.eval(
      ADMIT_SCRIPT,
      2,
      `waiting-room:event:${this.options.eventId}:queue`,
      `waiting-room:event:${this.options.eventId}:admitted`,
      String(now),
      String(expires),
      String(this.options.maxActiveAdmissions),
      String(adaptiveBatch),
      `waiting-room:event:${this.options.eventId}:session:`,
    )) as string[];
    this.metrics?.admissionRate.inc(admitted.length);
    return admitted;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.cleanupAbandoned();
      await this.admitOnce();
      this.metrics?.waitingRoomSize.set(
        await this.redis.zcard(`waiting-room:event:${this.options.eventId}:queue`),
      );
    } finally {
      this.running = false;
    }
  }

  private async cleanupAbandoned(): Promise<void> {
    const queueKey = `waiting-room:event:${this.options.eventId}:queue`;
    const sessions = await this.redis.zrange(queueKey, 0, 199);
    if (sessions.length === 0) return;
    const exists = await Promise.all(
      sessions.map((id) =>
        this.redis.exists(`waiting-room:event:${this.options.eventId}:session:${id}`),
      ),
    );
    const abandoned = sessions.filter((_, index) => exists[index] === 0);
    if (abandoned.length > 0) await this.redis.zrem(queueKey, ...abandoned);
  }
}
