export const API_URL = __ENV.API_URL || 'http://api:3000';
export const WS_URL = __ENV.WS_URL || 'ws://websocket-gateway:3001/ws';
export const EVENT_ID = __ENV.EVENT_ID || '10000000-0000-4000-8000-000000000001';
export const SECTION_ID = __ENV.SECTION_ID || '20000000-0000-4000-8000-000000000001';

export function duration(name, fallback) {
  return __ENV[name] || fallback;
}

export function integer(name, fallback) {
  const value = Number.parseInt(__ENV[name] || String(fallback), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function userId(salt = 0) {
  const value = BigInt(__VU) * 1000000n + BigInt(__ITER) + BigInt(salt);
  return `40000000-0000-4000-8000-${value.toString(16).padStart(12, '0').slice(-12)}`;
}

export function idempotencyKey(prefix) {
  return `${prefix}-${__VU}-${__ITER}`;
}
