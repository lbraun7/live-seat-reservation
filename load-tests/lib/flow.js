import http from 'k6/http';
import { check, sleep } from 'k6';

import { API_URL, EVENT_ID } from './config.js';

export function joinAndAwaitAdmission(userId, timeoutSeconds = 90) {
  const headers = { 'x-user-id': userId };
  const joined = http.post(`${API_URL}/events/${EVENT_ID}/waiting-room`, null, { headers });
  if (!check(joined, { 'waiting-room join accepted': (response) => response.status === 201 })) {
    return null;
  }

  const sessionId = joined.json('sessionId');
  if (!sessionId) return null;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    sleep(0.5);
    const heartbeat = http.post(
      `${API_URL}/events/${EVENT_ID}/waiting-room/${sessionId}/heartbeat`,
      null,
      { headers },
    );
    if (heartbeat.status === 200 && heartbeat.json('token')) return heartbeat.json('token');
    if (heartbeat.status === 404 || heartbeat.status === 403) return null;
  }
  return null;
}

export function createHold({ userId, seatId, token, key, tags = {} }) {
  return http.post(`${API_URL}/events/${EVENT_ID}/holds`, JSON.stringify({ seatId }), {
    headers: {
      'content-type': 'application/json',
      'x-user-id': userId,
      'x-admission-token': token,
      'idempotency-key': key,
    },
    tags: { operation: 'create_hold', ...tags },
  });
}

export function thresholds({ conflictScenario = false } = {}) {
  return {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: [conflictScenario ? 'rate<0.99' : 'rate<0.05'],
    checks: ['rate>0.90'],
  };
}
