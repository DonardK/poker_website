import type { LobbySeatPatch, SessionEndReason } from "@poker/shared";

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

/** RPC methods on TableActor. WP3 fills the bodies; WP1 only freezes the signatures. */
export interface TableActorRpc {
  track(): Promise<void>;
  disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
  keepAlive(userId: string): Promise<void>;
}

/** RPC methods on LobbyActor. `patch` is not a browser frame. */
export interface LobbyActorRpc {
  patch(entry: LobbySeatPatch): Promise<void>;
  disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void>;
}
