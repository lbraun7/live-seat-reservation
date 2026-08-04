import ws from 'k6/ws';
import { check } from 'k6';

import { EVENT_ID, WS_URL, duration, integer, userId } from './lib/config.js';
import { summary } from './lib/summary.js';

export const options = {
  scenarios: {
    slow_clients: {
      executor: 'constant-vus',
      vus: integer('VUS', 500),
      duration: duration('DURATION', '2m'),
    },
  },
  thresholds: { checks: ['rate>0.95'], ws_connecting: ['p(95)<1000'] },
};

export default function () {
  const response = ws.connect(WS_URL, { headers: { 'x-user-id': userId() } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', eventId: EVENT_ID, lastVersion: 1 }));
      // Intentionally does not register a message handler. The peer drains slowly while
      // the gateway applies its bounded-buffer/backpressure policy.
    });
    socket.setTimeout(() => socket.close(), integer('CONNECTION_MS', 30000));
  });
  check(response, {
    'slow client connected or shed': (result) => result && [101, 503].includes(result.status),
  });
}

export function handleSummary(data) {
  return summary('websocket-slow-clients', data);
}
