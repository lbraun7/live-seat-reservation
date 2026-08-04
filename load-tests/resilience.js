import http from 'k6/http';
import { check } from 'k6';

import {
  API_URL,
  EVENT_ID,
  SECTION_ID,
  duration,
  idempotencyKey,
  integer,
  userId,
} from './lib/config.js';
import { createHold, joinAndAwaitAdmission } from './lib/flow.js';
import { summary } from './lib/summary.js';

export const options = {
  scenarios: {
    resilience_probe: {
      executor: 'constant-arrival-rate',
      rate: integer('RATE', 100),
      timeUnit: '1s',
      duration: duration('DURATION', '2m'),
      preAllocatedVUs: integer('PRE_ALLOCATED_VUS', 100),
      maxVUs: integer('MAX_VUS', 1000),
    },
  },
  thresholds: { http_req_duration: ['p(99)<5000'] },
};

export default function () {
  const user = userId();
  const catalog = http.get(`${API_URL}/events/${EVENT_ID}/seats?sectionId=${SECTION_ID}&limit=10`, {
    tags: { operation: 'resilience_catalog' },
  });
  check(catalog, {
    'catalog has controlled outcome': (r) => [0, 200, 500, 503].includes(r.status),
  });
  if (catalog.status !== 200 || !catalog.json('seats.0.id')) return;
  const token = joinAndAwaitAdmission(user, integer('ADMISSION_TIMEOUT_SECONDS', 30));
  if (!token) return;
  const hold = createHold({
    userId: user,
    seatId: catalog.json('seats.0.id'),
    token,
    key: idempotencyKey('resilience'),
    tags: { scenario_kind: 'resilience' },
  });
  check(hold, {
    'hold has controlled outcome': (r) => [0, 201, 403, 409, 429, 500, 503].includes(r.status),
  });
}

export function handleSummary(data) {
  return summary(__ENV.RESULT_NAME || 'resilience', data);
}
