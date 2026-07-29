import 'dotenv/config';

const environments = ['development', 'test', 'production'] as const;
const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

type Environment = (typeof environments)[number];
type LogLevel = (typeof logLevels)[number];

export interface AppConfig {
  nodeEnv: Environment;
  host: string;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  redisUrl: string;
  databaseConnectionTimeoutMs: number;
  redisConnectionTimeoutMs: number;
  shutdownTimeoutMs: number;
  holdExpirationJobAttempts: number;
  holdExpirationBackoffMs: number;
  holdReconcilerIntervalMs: number;
  holdReconcilerBatchSize: number;
  outboxRelayIntervalMs: number;
  outboxRelayBatchSize: number;
  outboxRetentionDays: number;
  outboxMetricsPort: number;
  websocketPort: number;
  websocketHeartbeatIntervalMs: number;
  websocketMaxMessageBytes: number;
  websocketMaxMessagesPerMinute: number;
  websocketMaxBufferedBytes: number;
}

type EnvironmentVariables = Record<string, string | undefined>;

function required(env: EnvironmentVariables, name: string, errors: string[]): string {
  const value = env[name]?.trim();
  if (!value) {
    errors.push(`${name} is required`);
    return '';
  }
  return value;
}

function integer(
  env: EnvironmentVariables,
  name: string,
  fallback: number,
  errors: string[],
  bounds: { min: number; max: number },
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    errors.push(
      `${name} must be an integer between ${String(bounds.min)} and ${String(bounds.max)}`,
    );
  }
  return value;
}

function url(value: string, name: string, protocols: string[], errors: string[]): string {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    errors.push(`${name} must be a valid ${protocols.join(' or ')} URL`);
  }
  return value;
}

export function loadConfig(env: EnvironmentVariables = process.env): AppConfig {
  const errors: string[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  const logLevel = env.LOG_LEVEL ?? 'info';
  const databaseUrl = required(env, 'DATABASE_URL', errors);
  const redisUrl = required(env, 'REDIS_URL', errors);

  if (!environments.includes(nodeEnv as Environment)) {
    errors.push(`NODE_ENV must be one of: ${environments.join(', ')}`);
  }
  if (!logLevels.includes(logLevel as LogLevel)) {
    errors.push(`LOG_LEVEL must be one of: ${logLevels.join(', ')}`);
  }

  const config: AppConfig = {
    nodeEnv: nodeEnv as Environment,
    host: env.HOST ?? '0.0.0.0',
    port: integer(env, 'PORT', 3000, errors, { min: 1, max: 65_535 }),
    logLevel: logLevel as LogLevel,
    databaseUrl: url(databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:'], errors),
    redisUrl: url(redisUrl, 'REDIS_URL', ['redis:', 'rediss:'], errors),
    databaseConnectionTimeoutMs: integer(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 2000, errors, {
      min: 100,
      max: 60_000,
    }),
    redisConnectionTimeoutMs: integer(env, 'REDIS_CONNECTION_TIMEOUT_MS', 2000, errors, {
      min: 100,
      max: 60_000,
    }),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, errors, {
      min: 1000,
      max: 60_000,
    }),
    holdExpirationJobAttempts: integer(env, 'HOLD_EXPIRATION_JOB_ATTEMPTS', 5, errors, {
      min: 1,
      max: 20,
    }),
    holdExpirationBackoffMs: integer(env, 'HOLD_EXPIRATION_BACKOFF_MS', 1000, errors, {
      min: 100,
      max: 60_000,
    }),
    holdReconcilerIntervalMs: integer(env, 'HOLD_RECONCILER_INTERVAL_MS', 5000, errors, {
      min: 100,
      max: 3_600_000,
    }),
    holdReconcilerBatchSize: integer(env, 'HOLD_RECONCILER_BATCH_SIZE', 100, errors, {
      min: 1,
      max: 10_000,
    }),
    outboxRelayIntervalMs: integer(env, 'OUTBOX_RELAY_INTERVAL_MS', 500, errors, {
      min: 50,
      max: 60_000,
    }),
    outboxRelayBatchSize: integer(env, 'OUTBOX_RELAY_BATCH_SIZE', 100, errors, {
      min: 1,
      max: 10_000,
    }),
    outboxRetentionDays: integer(env, 'OUTBOX_RETENTION_DAYS', 7, errors, {
      min: 1,
      max: 3650,
    }),
    outboxMetricsPort: integer(env, 'OUTBOX_METRICS_PORT', 9464, errors, {
      min: 1,
      max: 65_535,
    }),
    websocketPort: integer(env, 'WEBSOCKET_PORT', 3001, errors, { min: 1, max: 65_535 }),
    websocketHeartbeatIntervalMs: integer(env, 'WEBSOCKET_HEARTBEAT_INTERVAL_MS', 30_000, errors, {
      min: 1000,
      max: 300_000,
    }),
    websocketMaxMessageBytes: integer(env, 'WEBSOCKET_MAX_MESSAGE_BYTES', 4096, errors, {
      min: 128,
      max: 1_048_576,
    }),
    websocketMaxMessagesPerMinute: integer(env, 'WEBSOCKET_MAX_MESSAGES_PER_MINUTE', 120, errors, {
      min: 1,
      max: 100_000,
    }),
    websocketMaxBufferedBytes: integer(env, 'WEBSOCKET_MAX_BUFFERED_BYTES', 1_048_576, errors, {
      min: 1024,
      max: 67_108_864,
    }),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
