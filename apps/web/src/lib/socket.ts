"use client";

import {
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type CommandResult,
  type ServerToClientEvents,
} from "@poker/shared";
import { ApiError, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/stores/session";
import { socketOrigin } from "@/lib/public-origin";
import {
  WsConnection,
  httpOriginFromSocketUrl,
  interpretRenewReplies,
  lobbySocketUrl,
  tableSocketUrl,
  withCommandId,
  type ClientFrameType,
} from "@/lib/ws-client";

function socketBase(): string {
  return socketOrigin() || "http://127.0.0.1:3000";
}

/**
 * Frames that used a Socket.IO ack. They go out with an id and wait for ACK.
 * TABLE_JOIN, TABLE_LEAVE, REHYDRATE, and LOBBY_HELLO do not.
 */
const ACK_EVENTS = new Set<string>([
  SOCKET_EVENTS.SEAT_CLAIM,
  SOCKET_EVENTS.SIT_OUT,
  SOCKET_EVENTS.SIT_IN,
  SOCKET_EVENTS.ACTION_INTENT,
  SOCKET_EVENTS.STAND_UP,
  SOCKET_EVENTS.TABLE_KEEP_ALIVE,
  SOCKET_EVENTS.SESSION_RENEW,
]);

const TABLE_EVENTS = new Set<string>([
  SOCKET_EVENTS.TABLE_JOIN,
  SOCKET_EVENTS.TABLE_LEAVE,
  SOCKET_EVENTS.SEAT_CLAIM,
  SOCKET_EVENTS.SIT_OUT,
  SOCKET_EVENTS.SIT_IN,
  SOCKET_EVENTS.ACTION_INTENT,
  SOCKET_EVENTS.REHYDRATE,
  SOCKET_EVENTS.STAND_UP,
]);

export interface PokerSocket {
  /** Lobby socket authenticated. Table commands still wait for the table socket. */
  readonly connected: boolean;
  /** Lobby socket will keep trying. False after disconnect() or a fatal auth close. */
  readonly active: boolean;
  connect(): void;
  disconnect(): void;
  removeAllListeners(): void;
  on(event: "connect", listener: () => void): void;
  on(event: "connect_error", listener: (err: Error) => void): void;
  on(event: "disconnect", listener: (reason: string) => void): void;
  on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void;
  off(event: "connect", listener: () => void): void;
  off(event: "connect_error", listener: (err: Error) => void): void;
  off(event: "disconnect", listener: (reason: string) => void): void;
  off<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void;
  emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): void;
  timeout(ms: number): {
    emitWithAck<E extends keyof ClientToServerEvents>(
      event: E,
      payload: Parameters<ClientToServerEvents[E]>[0],
    ): Promise<CommandResult>;
  };
}

let socket: SessionSocket | null = null;
/** The user the sockets were opened for. Another user never shares them. */
let boundUserId: string | null = null;
/** Newest access token. Ticket fetches and later reconnects read this, never the URL. */
let socketToken: string | null = null;

async function refreshAccessToken(): Promise<{ accessToken: string }> {
  try {
    const data = await refreshSession();
    socketToken = data.accessToken;
    const state = useAuthStore.getState();
    if (!state.user || state.user.id === data.user.id) state.setSession(data.user, data.accessToken);
    return { accessToken: data.accessToken };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw new Error("Unauthorized");
    throw error;
  }
}

function connectionOptions(url: string, lobbyHello: boolean) {
  return {
    url,
    ticketUrl: `${httpOriginFromSocketUrl(url)}/api/ws-ticket`,
    getToken: () => socketToken,
    setToken: (token: string) => { socketToken = token; },
    refreshSession: refreshAccessToken,
    lobbyHello,
  };
}

/**
 * One object the hooks already share. Under it: a lobby socket for the app
 * shell and, once a table is joined, a table socket. `connect` / `connected` /
 * `active` follow the lobby socket, because that is the session. A table
 * transport drop is still announced so the table page can show reconnecting;
 * the table socket re-joins itself and does not emit another `connect` (that
 * would mark a live table as connecting again).
 */
class SessionSocket implements PokerSocket {
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  private readonly lobby: WsConnection;
  private table: WsConnection | null = null;
  private tableId: string | null = null;
  /** Set by TABLE_JOIN, cleared by TABLE_LEAVE. The table socket re-sends join after AUTH_OK. */
  private joinedTableId: string | null = null;
  private coalescedServerDisconnect = false;
  private coalescedFatalError = false;

  constructor() {
    this.lobby = new WsConnection(connectionOptions(lobbySocketUrl(socketBase()), true));
    this.bindLobby(this.lobby);
  }

  get connected(): boolean {
    return this.lobby.connected;
  }

  get active(): boolean {
    return this.lobby.active;
  }

  /** 4001 / 4002 / 1008 on either socket. SESSION_RENEW must not open a new one. */
  get sessionOver(): boolean {
    return this.lobby.fatalClose || (this.table?.fatalClose ?? false);
  }

  connect(): void {
    this.lobby.connect();
    if (this.joinedTableId) this.ensureTable(this.joinedTableId);
  }

  disconnect(): void {
    this.lobby.disconnect();
    this.table?.disconnect();
  }

  destroy(): void {
    const table = this.table;
    this.table = null;
    this.tableId = null;
    this.joinedTableId = null;
    table?.destroy();
    this.lobby.destroy();
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  on(event: "connect", listener: () => void): void;
  on(event: "connect_error", listener: (err: Error) => void): void;
  on(event: "disconnect", listener: (reason: string) => void): void;
  on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void;
  on(event: string, listener: (...args: never[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: "connect", listener: () => void): void;
  off(event: "connect_error", listener: (err: Error) => void): void;
  off(event: "disconnect", listener: (reason: string) => void): void;
  off<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void;
  off(event: string, listener: (...args: never[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): void {
    const payload = args[0];
    const ack = args[1] as ((result: CommandResult) => void) | undefined;
    if (event === SOCKET_EVENTS.TABLE_LEAVE) {
      this.leaveTable(tableIdOf(payload));
      return;
    }
    // The table socket sends TABLE_JOIN itself when AUTH_OK arrives. Sending
    // it here as well would queue a second join on the first connection.
    if (event === SOCKET_EVENTS.TABLE_JOIN) {
      const tableId = tableIdOf(payload);
      if (!tableId) return;
      this.ensureTable(tableId);
      if (this.table?.connected) this.table.send(SOCKET_EVENTS.TABLE_JOIN, { tableId });
      return;
    }
    const stamped = withCommandId(event, payload);
    const target = this.targetFor(event, stamped);
    if (ack || ACK_EVENTS.has(event)) {
      const pending = target.request(event as ClientFrameType, stamped);
      if (ack) pending.then(ack, () => undefined);
      else pending.catch(() => undefined);
      return;
    }
    target.send(event as ClientFrameType, stamped);
  }

  timeout(ms: number): {
    emitWithAck<E extends keyof ClientToServerEvents>(
      event: E,
      payload: Parameters<ClientToServerEvents[E]>[0],
    ): Promise<CommandResult>;
  } {
    return {
      emitWithAck: (event, payload) => this.emitWithAck(String(event), payload, ms),
    };
  }

  private async emitWithAck(event: string, payload: unknown, ms: number): Promise<CommandResult> {
    const stamped = withCommandId(event, payload);
    if (event === SOCKET_EVENTS.SESSION_RENEW) return this.renewAll(stamped, ms);
    const target = this.targetFor(event, stamped);
    return target.request(event as ClientFrameType, stamped, ms);
  }

  /** Every authenticated socket. Parallel so a missing ack costs one timeout, not two. */
  private async renewAll(payload: unknown, ms: number): Promise<CommandResult> {
    const targets = [this.lobby, this.table].filter((conn): conn is WsConnection => Boolean(conn?.connected));
    if (targets.length === 0) return Promise.reject(new Error("socket has been disconnected"));
    const replies = await Promise.all(targets.map((conn) => conn.request(SOCKET_EVENTS.SESSION_RENEW, payload, ms)));
    const outcome = interpretRenewReplies(replies);
    if (outcome === "unauthorized") {
      const refused = replies.find((reply) => !reply.ok && reply.code === "UNAUTHORIZED");
      return refused ?? { ok: false, code: "UNAUTHORIZED", message: "Please sign in again" };
    }
    if (outcome === "renewed") return { ok: true };
    if (outcome === "stay") {
      const retryable = replies.find((reply) => !reply.ok && reply.retryable);
      return retryable ?? { ok: false, code: "SERVICE_UNAVAILABLE", message: "Request could not be completed", retryable: true };
    }
    const failed = replies.find((reply) => !reply.ok);
    return failed ?? { ok: false, code: "SERVICE_UNAVAILABLE", message: "Request could not be completed" };
  }

  private targetFor(event: string, payload: unknown): WsConnection {
    const tableId = tableIdOf(payload);
    if (event === SOCKET_EVENTS.TABLE_KEEP_ALIVE) {
      if (tableId && this.table && this.tableId === tableId && (this.table.connected || this.table.active)) return this.table;
      return this.lobby;
    }
    if (event === SOCKET_EVENTS.TABLE_JOIN && tableId) {
      this.ensureTable(tableId);
      return this.table ?? this.lobby;
    }
    if (TABLE_EVENTS.has(event)) {
      const id = tableId ?? this.joinedTableId;
      if (id) this.ensureTable(id);
      return this.table ?? this.lobby;
    }
    return this.lobby;
  }

  private ensureTable(tableId: string): void {
    this.joinedTableId = tableId;
    if (this.table && this.tableId === tableId) {
      if (!this.table.connected && !this.table.active) this.table.connect();
      return;
    }
    this.dropTable();
    this.tableId = tableId;
    const table = new WsConnection(connectionOptions(tableSocketUrl(socketBase(), tableId), false));
    this.table = table;
    this.bindTable(table);
    table.connect();
  }

  /** TABLE_LEAVE and unmount. The lobby socket stays up. */
  private leaveTable(tableId: string | null): void {
    if (tableId && this.joinedTableId === tableId) this.joinedTableId = null;
    if (!this.table || (tableId && this.tableId !== tableId)) return;
    if (this.table.connected && tableId) this.table.send(SOCKET_EVENTS.TABLE_LEAVE, { tableId });
    this.dropTable();
  }

  private dropTable(): void {
    const table = this.table;
    this.table = null;
    this.tableId = null;
    table?.destroy();
  }

  private bindLobby(conn: WsConnection): void {
    conn.on("connect", () => {
      this.coalescedServerDisconnect = false;
      this.coalescedFatalError = false;
      this.emitApp("connect");
    });
    conn.on("disconnect", (reason) => this.onTransportDisconnect(conn, reason));
    conn.on("connect_error", (error) => this.onTransportError(conn, error));
    conn.on("frame", (frame) => this.onFrame(frame.type, frame.payload));
  }

  private bindTable(conn: WsConnection): void {
    conn.on("connect", () => {
      // Re-join after AUTH_OK. The hook already emitted TABLE_JOIN, which only
      // opened this socket; sending here covers that first join and a later drop.
      if (this.table !== conn || !this.joinedTableId) return;
      conn.send(SOCKET_EVENTS.TABLE_JOIN, { tableId: this.joinedTableId });
    });
    conn.on("disconnect", (reason) => this.onTransportDisconnect(conn, reason));
    conn.on("connect_error", (error) => this.onTransportError(conn, error));
    conn.on("frame", (frame) => this.onFrame(frame.type, frame.payload));
  }

  private onFrame(type: string, payload: unknown): void {
    if (type === "ACK") return;
    this.emitApp(type, payload);
  }

  private onTransportDisconnect(conn: WsConnection, reason: string): void {
    // A table socket closed by TABLE_LEAVE is already detached.
    if (conn !== this.lobby && conn !== this.table) return;
    if (reason === "io server disconnect") {
      if (this.coalescedServerDisconnect) return;
      this.coalescedServerDisconnect = true;
    }
    this.emitApp("disconnect", reason);
  }

  private onTransportError(conn: WsConnection, error: Error): void {
    if (conn !== this.lobby && conn !== this.table) return;
    const fatal = error.message === "Unauthorized" && !this.lobby.active;
    if (fatal) {
      if (this.coalescedFatalError) return;
      this.coalescedFatalError = true;
    }
    this.emitApp("connect_error", error);
  }

  private emitApp(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as (...passed: unknown[]) => void)(...args);
  }
}

function tableIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const tableId = (payload as { tableId?: unknown }).tableId;
  return typeof tableId === "string" && tableId.length > 0 ? tableId : null;
}

/**
 * The session's sockets. One pair serves a user for the whole session: a
 * token refresh does not replace them (that would drop the table, every
 * listener, and the snapshot on screen). The new token is handed to each
 * live connection with SESSION_RENEW and used by every later reconnect.
 * Only a different user, or sign-out, gets a new pair.
 *
 * Callers pass the token they rendered with, which may be stale after an
 * await; the store's current token wins, so a stale caller can never put an
 * older token back on the socket.
 */
export function getSocket(accessToken: string): PokerSocket {
  const state = useAuthStore.getState();
  const token = state.accessToken ?? accessToken;
  const userId = state.user?.id ?? null;
  if (socket && boundUserId === userId) {
    socketToken = token;
    return socket;
  }
  disconnectSocket();
  boundUserId = userId;
  socketToken = token;
  socket = new SessionSocket();
  socket.connect();
  return socket;
}

/** The session's socket if one exists, without creating one. */
export function currentSocket(): PokerSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (!socket) {
    boundUserId = null;
    socketToken = null;
    return;
  }
  const closing = socket;
  socket = null;
  boundUserId = null;
  socketToken = null;
  closing.removeAllListeners();
  closing.destroy();
}

/** How long a server has to acknowledge SESSION_RENEW before we assume it predates it. */
const RENEW_TIMEOUT_MS = 5_000;

/**
 * - "renewed": every live connection accepted `token`; nothing else changes.
 * - "unauthorized": the server refused the token: the session is over.
 * - "reconnected": no usable answer, so the same sockets reconnect with the new token.
 * - "idle": nothing to do (no socket, already reconnecting, or a retryable refusal that left the sockets up).
 */
export type RenewOutcome = "renewed" | "unauthorized" | "reconnected" | "idle";

/** Hand a refreshed access token to the live sockets without replacing them. */
export async function renewSocketSession(token: string): Promise<RenewOutcome> {
  const target = socket;
  if (!target) return "idle";
  socketToken = token;
  if (!target.connected) return "idle";
  try {
    const reply = await target.timeout(RENEW_TIMEOUT_MS).emitWithAck(SOCKET_EVENTS.SESSION_RENEW, { token });
    if (reply.ok) return "renewed";
    if (reply.code === "UNAUTHORIZED") return "unauthorized";
    if (reply.retryable === true) return "idle";
  } catch {
    /* no ack in time, or the connection dropped */
  }
  if (socket !== target) return "idle";
  if (target.sessionOver) return "unauthorized";
  // Already reconnecting by itself (dropped while waiting): that reconnect presents the new token.
  if (!target.connected && target.active) return "idle";
  target.disconnect();
  target.connect();
  return "reconnected";
}

/**
 * Reconnect the same sockets after the server closed them, which does not
 * retry on its own. Listeners stay attached, so the table re-joins on "connect".
 */
export function resumeSocket(): void {
  if (socket && !socket.connected && !socket.active) socket.connect();
}
