export interface WaitingSession {
  sessionId: string;
  eventId: string;
  userId: string;
  joinedAt: string;
  position: number;
}

export interface Admission {
  token: string;
  expiresAt: string;
}

export interface JoinWaitingRoomCommand {
  eventId: string;
  userId: string;
  ip: string;
}

export interface HeartbeatCommand extends JoinWaitingRoomCommand {
  sessionId: string;
}

export interface ConsumeAdmissionCommand {
  token: string;
  eventId: string;
  userId: string;
  ip: string;
  idempotencyKey: string;
}

export interface WaitingRoom {
  join(command: JoinWaitingRoomCommand): Promise<WaitingSession>;
  heartbeat(command: HeartbeatCommand): Promise<WaitingSession | Admission>;
  position(eventId: string, sessionId: string, userId: string): Promise<WaitingSession | Admission>;
  consumeAdmission(command: ConsumeAdmissionCommand): Promise<void>;
}

export class WaitingRoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
