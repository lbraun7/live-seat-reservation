import { createServer, type Server as HttpServer } from 'node:http';

import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { OUTBOX_CHANNEL, type DomainEvent } from '../../outbox/domain/outbox.js';
import {
  classifyVersion,
  isSlowClient,
  toSeatRealtimeEvent,
  type SeatRealtimeEvent,
} from '../domain/realtime.js';
import type { WaitingRoom } from '../../waiting-room/domain/waiting-room.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RealtimeGatewayOptions {
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  maxMessageBytes: number;
  maxMessagesPerMinute: number;
  maxBufferedBytes: number;
  drainTimeoutMs: number;
}

interface ClientState {
  userId: string;
  alive: boolean;
  subscriptions: Map<string, number>;
  windowStartedAt: number;
  messagesInWindow: number;
  waitingSessions: Map<string, string>;
}

export class RealtimeGateway {
  private readonly server: HttpServer;
  private readonly websocketServer: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeat?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly subscriber: Redis,
    private readonly options: RealtimeGatewayOptions,
    private readonly waitingRoom?: WaitingRoom,
  ) {
    this.server = createServer((request, response) => {
      if (request.url === '/health/live') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
        return;
      }
      if (request.url === '/health/ready') {
        const ready = !this.draining && this.subscriber.status === 'ready';
        response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
        return;
      }
      response.writeHead(404).end();
    });
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.configure();
  }

  async start(): Promise<void> {
    if (this.subscriber.status === 'wait') await this.subscriber.connect();
    await this.subscriber.subscribe(OUTBOX_CHANNEL);
    this.subscriber.on('message', this.onRedisMessage);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => this.checkHeartbeats(), this.options.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  address(): { port: number } | null {
    const address = this.server.address();
    return address && typeof address === 'object' ? { port: address.port } : null;
  }

  async close(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.server.close();
    for (const client of this.clients.keys()) {
      this.send(client, { type: 'server.draining' });
      client.close(1012, 'server restarting');
    }
    await Promise.race([
      new Promise<void>((resolve) => this.websocketServer.close(() => resolve())),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, this.options.drainTimeoutMs);
        timeout.unref();
      }),
    ]);
    for (const client of this.clients.keys()) client.terminate();
    this.subscriber.off('message', this.onRedisMessage);
    await this.subscriber.unsubscribe(OUTBOX_CHANNEL).catch(() => undefined);
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
  }

  private configure(): void {
    this.server.on('upgrade', (request, socket, head) => {
      if (this.draining || request.url !== '/ws') {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const userId = request.headers['x-user-id'];
      if (typeof userId !== 'string' || !UUID.test(userId)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (client) => {
        (client as WebSocket & { authenticatedUserId?: string }).authenticatedUserId = userId;
        this.websocketServer.emit('connection', client, request);
      });
    });
    this.websocketServer.on('connection', (client) => {
      const state: ClientState = {
        userId: (client as WebSocket & { authenticatedUserId?: string }).authenticatedUserId ?? '',
        alive: true,
        subscriptions: new Map(),
        windowStartedAt: Date.now(),
        messagesInWindow: 0,
        waitingSessions: new Map(),
      };
      this.clients.set(client, state);
      client.on('pong', () => {
        state.alive = true;
      });
      client.on('message', (data, binary) => this.handleClientMessage(client, state, data, binary));
      client.on('close', () => this.clients.delete(client));
      client.on('error', () => this.clients.delete(client));
      this.send(client, { type: 'connected' });
    });
  }

  private handleClientMessage(
    client: WebSocket,
    state: ClientState,
    data: Buffer | ArrayBuffer | Buffer[],
    binary: boolean,
  ): void {
    if (binary) {
      client.close(1003, 'text messages only');
      return;
    }
    const now = Date.now();
    if (now - state.windowStartedAt >= 60_000) {
      state.windowStartedAt = now;
      state.messagesInWindow = 0;
    }
    state.messagesInWindow += 1;
    if (state.messagesInWindow > this.options.maxMessagesPerMinute) {
      client.close(1008, 'message rate exceeded');
      return;
    }
    try {
      const message: unknown = JSON.parse(messageText(data));
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'waiting-room.subscribe' &&
        'eventId' in message &&
        typeof message.eventId === 'string' &&
        UUID.test(message.eventId) &&
        'sessionId' in message &&
        typeof message.sessionId === 'string' &&
        UUID.test(message.sessionId) &&
        this.waitingRoom
      ) {
        state.waitingSessions.set(message.eventId, message.sessionId);
        void this.pushWaitingRoomUpdate(client, state, message.eventId, message.sessionId);
        return;
      }
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'subscribe' ||
        !('eventId' in message) ||
        typeof message.eventId !== 'string' ||
        !UUID.test(message.eventId) ||
        !('lastVersion' in message) ||
        typeof message.lastVersion !== 'number' ||
        !Number.isSafeInteger(message.lastVersion) ||
        message.lastVersion < 1
      ) {
        this.send(client, { type: 'error', code: 'INVALID_MESSAGE' });
        return;
      }
      state.subscriptions.set(message.eventId, message.lastVersion);
      this.send(client, {
        type: 'subscribed',
        eventId: message.eventId,
        version: message.lastVersion,
      });
    } catch {
      this.send(client, { type: 'error', code: 'INVALID_JSON' });
    }
  }

  private readonly onRedisMessage = (channel: string, raw: string): void => {
    if (channel !== OUTBOX_CHANNEL || Buffer.byteLength(raw) > this.options.maxMessageBytes * 4)
      return;
    try {
      const event = toSeatRealtimeEvent(JSON.parse(raw) as DomainEvent);
      if (event) this.broadcast(event);
    } catch {
      // Invalid broker messages are ignored; the snapshot remains authoritative.
    }
  };

  private broadcast(event: SeatRealtimeEvent): void {
    for (const [client, state] of this.clients) {
      const version = state.subscriptions.get(event.eventId);
      if (version === undefined) continue;
      const decision = classifyVersion(version, event.version);
      if (decision === 'DUPLICATE') continue;
      if (decision === 'GAP') {
        state.subscriptions.delete(event.eventId);
        this.send(client, {
          type: 'resync.required',
          eventId: event.eventId,
          expectedVersion: version + 1,
          receivedVersion: event.version,
          snapshotUrl: `/events/${event.eventId}/seats`,
        });
        continue;
      }
      if (this.send(client, event)) state.subscriptions.set(event.eventId, event.version);
    }
  }

  private send(client: WebSocket, message: object): boolean {
    if (
      client.readyState !== WebSocket.OPEN ||
      isSlowClient(client.bufferedAmount, this.options.maxBufferedBytes)
    ) {
      if (client.readyState === WebSocket.OPEN) client.close(1013, 'client too slow');
      return false;
    }
    client.send(JSON.stringify(message));
    return true;
  }

  private checkHeartbeats(): void {
    for (const [client, state] of this.clients) {
      if (!state.alive) {
        client.terminate();
        this.clients.delete(client);
        continue;
      }
      state.alive = false;
      client.ping();
      for (const [eventId, sessionId] of state.waitingSessions) {
        void this.pushWaitingRoomUpdate(client, state, eventId, sessionId);
      }
    }
  }

  private async pushWaitingRoomUpdate(
    client: WebSocket,
    state: ClientState,
    eventId: string,
    sessionId: string,
  ): Promise<void> {
    if (!this.waitingRoom) return;
    try {
      const update = await this.waitingRoom.heartbeat({
        eventId,
        sessionId,
        userId: state.userId,
        ip: 'websocket',
      });
      this.send(client, {
        type: 'token' in update ? 'waiting-room.admitted' : 'waiting-room.position',
        ...update,
      });
      if ('token' in update) state.waitingSessions.delete(eventId);
    } catch (error) {
      state.waitingSessions.delete(eventId);
      this.send(client, {
        type: 'waiting-room.error',
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : 'WAITING_ROOM_UNAVAILABLE',
      });
    }
  }
}

function messageText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
