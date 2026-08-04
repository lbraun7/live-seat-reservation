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
import { createHold, joinAndAwaitAdmission, thresholds } from './lib/flow.js';
import { summary } from './lib/summary.js';

export const options = {
  scenarios: {
    distinct_seats: {
      executor: 'constant-arrival-rate',
      rate: integer('RATE', 50),
      timeUnit: '1s',
      duration: duration('DURATION', '1m'),
      preAllocatedVUs: integer('PRE_ALLOCATED_VUS', 100),
      maxVUs: integer('MAX_VUS', 1000),
    },
  },
  thresholds: thresholds(),
};

export function setup() {
  const sectionIds = [SECTION_ID, ...(__ENV.SECTION_IDS || '').split(',').filter(Boolean)];
  const seats = [];
  for (const sectionId of [...new Set(sectionIds)]) {
    let cursor = null;
    do {
      const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const response = http.get(
        `${API_URL}/events/${EVENT_ID}/seats?sectionId=${sectionId}&limit=500${query}`,
      );
      if (response.status !== 200) throw new Error(`seat snapshot failed: ${response.status}`);
      seats.push(...response.json('seats').filter((seat) => seat.status === 'AVAILABLE'));
      cursor = response.json('page.nextCursor');
    } while (cursor);
  }
  if (seats.length === 0) throw new Error('no available seats; reset the test data');
  return { seatIds: seats.map((seat) => seat.id) };
}

export default function (data) {
  const user = userId();
  const token = joinAndAwaitAdmission(user);
  check(token, { admitted: (value) => Boolean(value) });
  if (!token) return;
  const index = exec.scenario.iterationInTest;
  if (index >= data.seatIds.length) return;
  const response = createHold({
    userId: user,
    seatId: data.seatIds[index],
    token,
    key: idempotencyKey('distinct'),
    tags: { scenario_kind: 'distinct' },
  });
  check(response, { 'hold created': (result) => result.status === 201 });
}

export function handleSummary(data) {
  return summary('distinct-seats', data);
}
