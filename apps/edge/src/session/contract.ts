import type { CommandResult, LobbySeatPatch, SessionEndReason, TableIdleNoticePayload } from "@poker/shared";

/** UserSessions.register. `target` is "table:<id>" or "lobby". */
export interface RegisterConnection {
  sessionId: string;
  target: string;
  connId: string;
}

export interface UnregisterConnection {
  connId: string;
}

export interface RevokeSession {
  sessionId: string;
  reason: SessionEndReason;
}

/** Omit sessionId to notify every connection stored for this user. */
export interface NotifySession {
  sessionId?: string;
  event: "USER_PATCH" | "TABLE_IDLE_NOTICE";
  payload: unknown;
}

/** RPC methods on the UserSessions Durable Object. Plain structured-clone values only. */
export interface UserSessionsRpc {
  register(input: RegisterConnection): Promise<void>;
  unregister(input: UnregisterConnection): Promise<void>;
  revoke(input: RevokeSession): Promise<void>;
  notify(input: NotifySession): Promise<void>;
}

/**
 * Fan-out payload for USER_PATCH and TABLE_IDLE_NOTICE. Same shape LobbyActor.deliver
 * already accepts. `userId` is the UserSessions object name.
 */
export interface SessionDelivery {
  userId: string;
  sessionId?: string;
  event: "USER_PATCH" | "TABLE_IDLE_NOTICE";
  payload: unknown;
}

/** RPC methods on TableActor. WP3 fills the bodies; WP1 only freezes the signatures. */
export interface TableActorRpc {
  track(): Promise<void>;
  disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
  /**
   * Lobby forwards TABLE_KEEP_ALIVE as (userId, commandId). Success is
   * `{ ok: true, duplicate? }`. A definitive refusal rejects the RPC with
   * `error.code` set (WP4 maps NOT_SEATED). `commandId` may be omitted by
   * an older caller; a state-changing keep then uses a server id.
   */
  keepAlive(userId: string, commandId?: string): Promise<Extract<CommandResult, { ok: true }>>;
  deliver(input: SessionDelivery): Promise<void>;
  /** Read-only idle warning for this user. Null when no warning is counting down. */
  currentIdleNotice(userId: string): Promise<TableIdleNoticePayload | null>;
}

/** RPC methods on LobbyActor. `patch` is not a browser frame. */
export interface LobbyActorRpc {
  patch(entry: LobbySeatPatch): Promise<void>;
  disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
  deliver(input: SessionDelivery): Promise<void>;
}
