import { afterEach, describe, expect, it } from 'vitest';

import { ServiceMetrics } from '../../src/shared/observability/metrics.js';

describe('service metrics', () => {
  const created: ServiceMetrics[] = [];

  afterEach(() => {
    for (const metrics of created) metrics.close();
    created.length = 0;
  });

  it('exports domain and runtime metrics with a service label', async () => {
    const metrics = new ServiceMetrics('test-service');
    created.push(metrics);
    metrics.holdAttempts.inc({ result: 'success' });
    metrics.websocketDroppedMessages.inc({ reason: 'slow_client' });

    const body = await metrics.content();

    expect(body).toContain('hold_attempts_total{result="success",service="test-service"} 1');
    expect(body).toContain(
      'websocket_dropped_messages_total{reason="slow_client",service="test-service"} 1',
    );
    expect(body).toContain('event_loop_lag_seconds');
    expect(body).toContain('nodejs_process_cpu_user_seconds_total');
  });
});
