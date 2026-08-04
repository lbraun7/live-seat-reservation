import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

import {
  API_URL,
  EVENT_ID,
  SECTION_ID,
  duration,
  idempotencyKey,
  integer,
  userId,
} from './lib/config.js';
import { createHold, joinAndAwaitAdmission, thresholds } from './lib/flow.js';
import { summary } from './lib/summary.js';

const expectedConflicts = new Counter('expected_hold_conflicts');
const unexpectedResults = new Counter('unexpected_hold_results');

export const options = {
  scenarios: {
    same_seat: {
      executor: 'constant-vus',
      vus: integer('VUS', 500),
      duration: duration('DURATION', '1m'),
    },
  },
  thresholds: {
    ...thresholds({ conflictScenario: true }),
    unexpected_hold_results: ['count==0'],
  },
};

export function setup() {
  const response = http.get(`${API_URL}/events/${EVENT_ID}/seats?sectionId=${SECTION_ID}&limit=1`);
  if (response.status !== 200 || !response.json('seats.0.id')) {
    throw new Error('could not select the contested seat');
  }
  return { seatId: response.json('seats.0.id') };
}

export default function (data) {
  const user = userId();
  const token = joinAndAwaitAdmission(user);
  if (!token) return;
  const response = createHold({
    userId: user,
    seatId: data.seatId,
    token,
    key: idempotencyKey('contention'),
    tags: { scenario_kind: 'contention' },
  });
  if (response.status === 409) expectedConflicts.add(1);
  else if (response.status !== 201) unexpectedResults.add(1);
  check(response, {
    'created or expected conflict': (result) => [201, 409].includes(result.status),
  });
}

export function handleSummary(data) {
  return summary('same-seat', data);
}
