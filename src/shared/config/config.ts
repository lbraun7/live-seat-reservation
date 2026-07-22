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
  };

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
