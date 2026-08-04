import http from 'k6/http';
import { check } from 'k6';

import { API_URL, EVENT_ID, duration, integer, userId } from './lib/config.js';
import { summary } from './lib/summary.js';

export const options = {
  scenarios: {
    waiting_room_spike: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: integer('PRE_ALLOCATED_VUS', 200),
      maxVUs: integer('MAX_VUS', 2000),
      stages: [
        { target: integer('SPIKE_RATE', 500), duration: duration('RAMP_DURATION', '10s') },
        { target: integer('SPIKE_RATE', 500), duration: duration('DURATION', '30s') },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<750', 'p(99)<1500'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  const response = http.post(`${API_URL}/events/${EVENT_ID}/waiting-room`, null, {
    headers: { 'x-user-id': userId() },
    tags: { operation: 'waiting_room_join' },
  });
  check(response, {
    'join accepted or rate-limited': (result) => [201, 429].includes(result.status),
  });
}

export function handleSummary(data) {
  return summary('waiting-room-spike', data);
}
