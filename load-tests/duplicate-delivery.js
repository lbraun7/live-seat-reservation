import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

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
    duplicate_commands: {
      executor: 'shared-iterations',
      vus: integer('VUS', 25),
      iterations: integer('ITERATIONS', 100),
      maxDuration: duration('DURATION', '3m'),
    },
  },
  thresholds: { checks: ['rate>0.95'] },
};

export function setup() {
  const response = http.get(
    `${API_URL}/events/${EVENT_ID}/seats?sectionId=${SECTION_ID}&limit=500`,
  );
  if (response.status !== 200) throw new Error('could not load seats');
  return { seats: response.json('seats').map((seat) => seat.id) };
}

export default function (data) {
  const user = userId();
  const key = idempotencyKey('duplicate');
  const token = joinAndAwaitAdmission(user);
  if (!token) return;
  const seatId = data.seats[exec.scenario.iterationInTest % data.seats.length];
  const first = createHold({ userId: user, seatId, token, key });
  const replay = createHold({ userId: user, seatId, token, key });
  check(replay, {
    'duplicate returns identical status': (r) => r.status === first.status,
    'duplicate is marked as replay': (r) => r.headers['Idempotency-Replayed'] === 'true',
    'duplicate returns same hold': (r) => first.status !== 201 || r.json('id') === first.json('id'),
  });
}

export function handleSummary(data) {
  return summary('duplicate-delivery', data);
}
