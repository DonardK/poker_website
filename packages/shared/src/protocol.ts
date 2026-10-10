/**
 * WebSocket wire types. Normative source: docs/cloudflare/PROTOCOL.md.
 * Payload types that already exist stay in events.ts and are imported here.
 * SOCKET_EVENTS strings are the frame `type` values. Do not rename them.
 */
import type { TableListItem } from "./api.js";
import type {
  ActionIntentPayload,
  AuthOkPayload,
  CommandResult,
  HandHistoryLogEntry,
  PublicTableState,
  RehydratePayload,
  SeatClaimPayload,
  SessionRenewPayload,
  SessionRevokedPayload,
  SitTogglePayload,
  SocketErrorPayload,
  TableIdleNoticePayload,
  TableJoinPayload,
  UserPatchPayload,
} from "./events.js";

export const PROTOCOL_VERSION = 1 as const;

export interface ClientFrame<T = unknown> {
  v: 1;
  /** Correlates ACK. Required for every frame that had a Socket.IO ack. UUID v4. */
  id?: string;
  type: ClientFrameType;
  payload: T;
}

export interface ServerFrame<T = unknown> {
  v: 1;
  /** Present on ACK and on a pushed error that answers a frame id. */
  id?: string;
  type: ServerFrameType;
  payload: T;
}

export const CLIENT_FRAME = {
  TABLE_JOIN: "TABLE_JOIN",
  TABLE_LEAVE: "TABLE_LEAVE",
  SEAT_CLAIM: "SEAT_CLAIM",
  SIT_OUT: "SIT_OUT",
  SIT_IN: "SIT_IN",
  ACTION_INTENT: "ACTION_INTENT",
  REHYDRATE: "REHYDRATE",
  STAND_UP: "STAND_UP",
  TABLE_KEEP_ALIVE: "TABLE_KEEP_ALIVE",
  SESSION_RENEW: "SESSION_RENEW",
  LOBBY_HELLO: "LOBBY_HELLO",
} as const;

export type ClientFrameType = (typeof CLIENT_FRAME)[keyof typeof CLIENT_FRAME];

export const SERVER_FRAME = {
  AUTH_OK: "AUTH_OK",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  HAND_HISTORY_LOG: "HAND_HISTORY_LOG",
  SERVER_ERROR: "SERVER_ERROR",
  USER_PATCH: "USER_PATCH",
  TABLE_IDLE_NOTICE: "TABLE_IDLE_NOTICE",
  SESSION_REVOKED: "SESSION_REVOKED",
  ACK: "ACK",
  LOBBY_SNAPSHOT: "LOBBY_SNAPSHOT",
  LOBBY_PATCH: "LOBBY_PATCH",
} as const;

export type ServerFrameType = (typeof SERVER_FRAME)[keyof typeof SERVER_FRAME];

export interface AckPayload extends Extract<CommandResult, { ok: true }> {
  ok: true;
}
export interface AckFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

/** ACK payload is CommandResult. Named here so the frame map is obvious. */
export type AckBody = CommandResult;

export interface LobbySnapshotPayload {
  tables: TableListItem[];
}

export interface LobbyPatchPayload {
  /** Present when the table should disappear from this user's list. */
  removed?: boolean;
  table?: TableListItem;
}

/**
 * Durable Object RPC argument, not a browser frame. The lobby DO fills
 * `isSeated` per socket and strips `seatedUserIds` before the client frame.
 */
export interface LobbySeatPatch {
  removed: boolean;
  /** TableListItem without isSeated. The lobby DO fills isSeated per socket. */
  table: Omit<TableListItem, "isSeated">;
  seatedUserIds: string[];
}

/** Frame payload types, so a handler can switch on `type` without a second map. */
export interface ClientFrameMap {
  TABLE_JOIN: TableJoinPayload;
  TABLE_LEAVE: TableJoinPayload;
  SEAT_CLAIM: SeatClaimPayload;
  SIT_OUT: SitTogglePayload;
  SIT_IN: SitTogglePayload;
  ACTION_INTENT: ActionIntentPayload;
  REHYDRATE: RehydratePayload;
  STAND_UP: SitTogglePayload;
  TABLE_KEEP_ALIVE: TableJoinPayload;
  SESSION_RENEW: SessionRenewPayload;
  LOBBY_HELLO: Record<string, never>;
}

export interface ServerFrameMap {
  AUTH_OK: AuthOkPayload;
  STATE_SNAPSHOT: PublicTableState;
  HAND_HISTORY_LOG: HandHistoryLogEntry;
  SERVER_ERROR: SocketErrorPayload;
  USER_PATCH: UserPatchPayload;
  TABLE_IDLE_NOTICE: TableIdleNoticePayload;
  SESSION_REVOKED: SessionRevokedPayload;
  ACK: CommandResult;
  LOBBY_SNAPSHOT: LobbySnapshotPayload;
  LOBBY_PATCH: LobbyPatchPayload;
}
