import ws from 'k6/ws';
import { check } from 'k6';

import { EVENT_ID, WS_URL, duration, integer, userId } from './lib/config.js';
import { summary } from './lib/summary.js';

export const options = {
  scenarios: {
    reconnect_storm: {
      executor: 'constant-arrival-rate',
      rate: integer('RATE', 200),
      timeUnit: '1s',
      duration: duration('DURATION', '1m'),
      preAllocatedVUs: integer('PRE_ALLOCATED_VUS', 250),
      maxVUs: integer('MAX_VUS', 2000),
    },
  },
  thresholds: { checks: ['rate>0.95'], ws_connecting: ['p(95)<1000'] },
};

export default function () {
  const response = ws.connect(WS_URL, { headers: { 'x-user-id': userId() } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', eventId: EVENT_ID, lastVersion: 1 }));
      socket.setTimeout(() => socket.close(), integer('CONNECTION_MS', 1000));
    });
    socket.setTimeout(() => socket.close(), integer('CONNECTION_MS', 1000) + 2000);
  });
  check(response, { 'websocket upgraded': (result) => result && result.status === 101 });
}

export function handleSummary(data) {
  return summary('websocket-storm', data);
}
