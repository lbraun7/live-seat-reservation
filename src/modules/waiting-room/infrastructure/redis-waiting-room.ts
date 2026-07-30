import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AdmissionTokenSigner } from '../application/admission-token.js';
import type {
  Admission,
  ConsumeAdmissionCommand,
  HeartbeatCommand,
  JoinWaitingRoomCommand,
  WaitingRoom,
  WaitingSession,
} from '../domain/waiting-room.js';
import { WaitingRoomError } from '../domain/waiting-room.js';

const CONSUME_SCRIPT = `
local admitted = redis.call('ZSCORE', KEYS[1], ARGV[1])
if admitted and tonumber(admitted) <= tonumber(ARGV[4]) then
  redis.call('ZREM', KEYS[1], ARGV[1])
  admitted = false
end
local consumed = redis.call('GET', KEYS[2])
if consumed == ARGV[3] then return 2 end
if consumed then return -1 end
if not admitted then return 0 end
if redis.call('SET', KEYS[2], ARGV[3], 'NX', 'EX', ARGV[2]) == false then return -1 end
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

export interface RedisWaitingRoomOptions {
  sessionTtlSeconds: number;
  admissionTtlSeconds: number;
  rateLimitWindowSeconds: number;
  rateLimitPerUser: number;
  rateLimitPerSession: number;
  rateLimitPerIp: number;
}

export class RedisWaitingRoom implements WaitingRoom {
  constructor(
    private readonly redis: Redis,
    private readonly signer: AdmissionTokenSigner,
    private readonly options: RedisWaitingRoomOptions,
  ) {}

  async join(command: JoinWaitingRoomCommand): Promise<WaitingSession> {
    await this.rateLimit(`join:user:${command.userId}`, this.options.rateLimitPerUser);
    await this.rateLimit(`join:ip:${command.ip}`, this.options.rateLimitPerIp);
    const sessionId = randomUUID();
    const joinedAt = Date.now();
    const meta = JSON.stringify({ userId: command.userId, joinedAt });
    const multi = this.redis.multi();
    multi.set(
      this.sessionKey(command.eventId, sessionId),
      meta,
      'EX',
      this.options.sessionTtlSeconds,
    );
    multi.zadd(this.queueKey(command.eventId), joinedAt, sessionId);
    await multi.exec();
    return this.waitingSession(command.eventId, sessionId, command.userId, joinedAt);
  }

  async heartbeat(command: HeartbeatCommand): Promise<WaitingSession | Admission> {
    await this.rateLimit(
      `heartbeat:session:${command.sessionId}`,
      this.options.rateLimitPerSession,
    );
    return this.load(command.eventId, command.sessionId, command.userId, true);
  }

  position(
    eventId: string,
    sessionId: string,
    userId: string,
  ): Promise<WaitingSession | Admission> {
    return this.load(eventId, sessionId, userId, false);
  }

  async consumeAdmission(command: ConsumeAdmissionCommand): Promise<void> {
    await this.rateLimit(`hold:user:${command.userId}`, this.options.rateLimitPerUser);
    await this.rateLimit(`hold:ip:${command.ip}`, this.options.rateLimitPerIp);
    let claims;
    try {
      claims = this.signer.verify(command.token);
    } catch {
      throw new WaitingRoomError(
        'ADMISSION_TOKEN_INVALID',
        'Admission token is invalid or expired',
        403,
      );
    }
    if (claims.eventId !== command.eventId || claims.userId !== command.userId) {
      throw new WaitingRoomError(
        'ADMISSION_TOKEN_MISMATCH',
        'Admission token does not belong to this user and event',
        403,
      );
    }
    const ttl = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
    const result = Number(
      await this.redis.eval(
        CONSUME_SCRIPT,
        2,
        this.admittedKey(command.eventId),
        `waiting-room:consumed:${claims.jti}`,
        claims.sessionId,
        String(ttl),
        command.idempotencyKey,
        String(Date.now()),
      ),
    );
    if (result === -1) {
      throw new WaitingRoomError(
        'ADMISSION_TOKEN_CONSUMED',
        'Admission token was already consumed',
        409,
      );
    }
    if (result !== 1 && result !== 2) {
      throw new WaitingRoomError('ADMISSION_NOT_ACTIVE', 'Admission is no longer active', 403);
    }
  }

  private async load(
    eventId: string,
    sessionId: string,
    userId: string,
    refresh: boolean,
  ): Promise<WaitingSession | Admission> {
    const raw = await this.redis.get(this.sessionKey(eventId, sessionId));
    if (!raw) {
      await this.redis.zrem(this.queueKey(eventId), sessionId);
      throw new WaitingRoomError('WAITING_SESSION_NOT_FOUND', 'Waiting session expired', 404);
    }
    const meta = JSON.parse(raw) as { userId: string; joinedAt: number };
    if (meta.userId !== userId) {
      throw new WaitingRoomError('WAITING_SESSION_FORBIDDEN', 'Waiting session is forbidden', 403);
    }
    if (refresh) {
      await this.redis.expire(this.sessionKey(eventId, sessionId), this.options.sessionTtlSeconds);
    }
    const admitted = await this.redis.zscore(this.admittedKey(eventId), sessionId);
    if (admitted && Number(admitted) > Date.now()) {
      const issued = this.signer.issue({ eventId, userId, sessionId });
      return {
        token: issued.token,
        expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
      };
    }
    if (admitted) await this.redis.zrem(this.admittedKey(eventId), sessionId);
    return this.waitingSession(eventId, sessionId, userId, meta.joinedAt);
  }

  private async waitingSession(
    eventId: string,
    sessionId: string,
    userId: string,
    joinedAt: number,
  ): Promise<WaitingSession> {
    const rank = await this.redis.zrank(this.queueKey(eventId), sessionId);
    return {
      sessionId,
      eventId,
      userId,
      joinedAt: new Date(joinedAt).toISOString(),
      position: rank === null ? 0 : rank + 1,
    };
  }

  private async rateLimit(key: string, limit: number): Promise<void> {
    const redisKey = `waiting-room:rate:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, this.options.rateLimitWindowSeconds);
    if (count > limit) {
      throw new WaitingRoomError('RATE_LIMITED', 'Rate limit exceeded', 429);
    }
  }

  private queueKey(eventId: string): string {
    return `waiting-room:event:${eventId}:queue`;
  }
  private admittedKey(eventId: string): string {
    return `waiting-room:event:${eventId}:admitted`;
  }
  private sessionKey(eventId: string, sessionId: string): string {
    return `waiting-room:event:${eventId}:session:${sessionId}`;
  }
}
