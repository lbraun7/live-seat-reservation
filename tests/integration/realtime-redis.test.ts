import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { RealtimeGateway } from '../../src/modules/realtime/application/realtime-gateway.js';
import { OUTBOX_CHANNEL, type DomainEvent } from '../../src/modules/outbox/domain/outbox.js';

const redisUrl = process.env.TEST_REDIS_URL;
const suiteRedisUrl = redisUrl ?? '';
const describeWithRedis = redisUrl ? describe : describe.skip;
const eventId = randomUUID();
const seatId = randomUUID();
const userId = randomUUID();

describeWithRedis('realtime gateways through Redis', () => {
  const publisher = new Redis(suiteRedisUrl, { maxRetriesPerRequest: 1 });
  const gateways = [createGateway(), createGateway()];
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    await Promise.all(gateways.map((gateway) => gateway.start()));
  });

  afterAll(async () => {
    for (const client of clients) client.terminate();
    await Promise.all(gateways.map((gateway) => gateway.close()));
    await publisher.quit();
  });

  it('broadcasts across instances, deduplicates, and requests HTTP resync on a gap', async () => {
    const firstGateway = gateways[0];
    const secondGateway = gateways[1];
    if (!firstGateway || !secondGateway) throw new Error('gateway fixtures are missing');
    const first = await connect(firstGateway);
    const second = await connect(secondGateway);
    clients.push(first, second);
    await Promise.all([subscribe(first, 1), subscribe(second, 1)]);

    const update = event(2);
    const received = [nextMessage(first), nextMessage(second)];
    await publisher.publish(OUTBOX_CHANNEL, JSON.stringify(update));
    expect(await Promise.all(received)).toEqual([
      expect.objectContaining({ type: 'seat.updated', eventId, seatId, version: 2 }),
      expect.objectContaining({ type: 'seat.updated', eventId, seatId, version: 2 }),
    ]);

    await publisher.publish(OUTBOX_CHANNEL, JSON.stringify(update));
    await expect(noMessage(first)).resolves.toBe(true);

    const resync = nextMessage(first);
    await publisher.publish(OUTBOX_CHANNEL, JSON.stringify(event(4)));
    await expect(resync).resolves.toEqual(
      expect.objectContaining({
        type: 'resync.required',
        eventId,
        expectedVersion: 3,
        receivedVersion: 4,
      }),
    );
  });

  it('survives a reconnect burst and keeps accepting clients', async () => {
    const burst = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const gateway = gateways[0];
        if (!gateway) throw new Error('gateway fixture is missing');
        const client = await connect(gateway);
        client.close();
        return client;
      }),
    );
    clients.push(...burst);
    const gateway = gateways[0];
    if (!gateway) throw new Error('gateway fixture is missing');
    const finalClient = await connect(gateway);
    clients.push(finalClient);
    expect(finalClient.readyState).toBe(WebSocket.OPEN);
  });

  function createGateway(): RealtimeGateway {
    return new RealtimeGateway(
      new Redis(suiteRedisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }),
      {
        host: '127.0.0.1',
        port: 0,
        heartbeatIntervalMs: 1000,
        maxMessageBytes: 4096,
        maxMessagesPerMinute: 120,
        maxBufferedBytes: 1_048_576,
        drainTimeoutMs: 1000,
      },
    );
  }

  async function connect(gateway: RealtimeGateway): Promise<WebSocket> {
    const port = gateway.address()?.port;
    if (!port) throw new Error('gateway is not listening');
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
      headers: { 'x-user-id': userId },
    });
    await nextMessage(client);
    return client;
  }

  async function subscribe(client: WebSocket, lastVersion: number): Promise<void> {
    const subscribed = nextMessage(client);
    client.send(JSON.stringify({ type: 'subscribe', eventId, lastVersion }));
    await subscribed;
  }

  function event(version: number): DomainEvent {
    return {
      eventId: randomUUID(),
      eventType: 'hold.created',
      aggregateType: 'hold',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      eventIdRef: eventId,
      seatId,
      version,
      payload: { seatStatus: version === 2 ? 'HELD' : 'AVAILABLE' },
    };
  }
});

function nextMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for websocket message')),
      2000,
    );
    client.once('message', (data) => {
      clearTimeout(timeout);
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');
      resolve(JSON.parse(text) as Record<string, unknown>);
    });
  });
}

function noMessage(client: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const onMessage = (): void => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      client.off('message', onMessage);
      resolve(true);
    }, 100);
    client.once('message', onMessage);
  });
}
