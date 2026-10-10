/**
 * One browser WebSocket that speaks PROTOCOL.md.
 *
 * `connect` means AUTH_OK, not merely that the TCP socket opened. Callers
 * (the session facade) decide which URL this is; this class does not know
 * about lobby versus table beyond an optional LOBBY_HELLO after auth.
 */
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ClientFrameType,
  type CommandResult,
  type ServerFrame,
} from "@poker/shared";

export type { ClientFrameType };

/** 500ms, 1s, 2s, 4s, 8s, then 15s. Full jitter draws uniformly from 0..step. */
export const BACKOFF_STEPS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

export const PING_INTERVAL_MS = 20_000;

/** How long an open socket may sit without AUTH_OK before it is torn down and retried. */
export const AUTH_TIMEOUT_MS = 10_000;

const COMMAND_ID_EVENTS = new Set(["SIT_OUT", "SIT_IN", "STAND_UP", "TABLE_KEEP_ALIVE"]);

export type Visibility = "visible" | "hidden";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

export type SocketFactory = new (url: string) => SocketLike;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WsConnectionOptions {
  /** Absolute ws/wss URL with no query string and no credential. */
  url: string;
  /** POST target that sets the poker_ws cookie. Same host as `url`. */
  ticketUrl: string;
  getToken: () => string | null;
  setToken?: (token: string) => void;
  refreshSession?: () => Promise<{ accessToken: string }>;
  /** Send LOBBY_HELLO after AUTH_OK. Lobby sockets only. */
  lobbyHello?: boolean;
  authTimeoutMs?: number;
  WebSocket?: SocketFactory;
  fetch?: typeof fetch;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  visibilityState?: () => Visibility | DocumentVisibilityState;
}

interface PendingAck {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: TimerHandle | null;
}

type ConnectionHandlers = {
  connect: Set<() => void>;
  disconnect: Set<(reason: string) => void>;
  connect_error: Set<(error: Error) => void>;
  frame: Set<(frame: ServerFrame) => void>;
};

/**
 * Full jitter: uniform in [0, step], step from {@link BACKOFF_STEPS_MS}.
 * `random()` of 0 waits 0ms; `random()` of 1 waits the whole step.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(0, attempt), BACKOFF_STEPS_MS.length - 1);
  const step = BACKOFF_STEPS_MS[index] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1];
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(unit * step);
}

/** Origin used for POST /api/ws-ticket so the cookie is stored for the upgrade host. */
export function httpOriginFromSocketUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  const proto = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${url.host}`;
}

/** ws/wss origin. Path, query, and hash from the env value are dropped. */
export function wsBaseFromSocketUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  const proto = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return `${proto}//${url.host}`;
}

export function lobbySocketUrl(socketUrl: string): string {
  return `${wsBaseFromSocketUrl(socketUrl)}/ws/lobby`;
}

export function tableSocketUrl(socketUrl: string, tableId: string): string {
  return `${wsBaseFromSocketUrl(socketUrl)}/ws/table/${encodeURIComponent(tableId)}`;
}

/**
 * Sit, stand, and keep-alive need a command id on the edge. The components
 * omit it; a retry of the same payload keeps a caller-supplied id.
 */
export function withCommandId(event: string, payload: unknown): unknown {
  if (!COMMAND_ID_EVENTS.has(event)) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as { commandId?: unknown };
  if (typeof record.commandId === "string" && record.commandId.length > 0) return payload;
  return { ...record, commandId: crypto.randomUUID() };
}

export type RenewInterpretation = "renewed" | "unauthorized" | "stay" | "reconnect";

/** What SESSION_RENEW acks mean for the live sockets. A timeout is not a reply. */
export function interpretRenewReplies(replies: readonly CommandResult[]): RenewInterpretation {
  if (replies.some((reply) => !reply.ok && reply.code === "UNAUTHORIZED")) return "unauthorized";
  if (replies.length > 0 && replies.every((reply) => reply.ok)) return "renewed";
  if (replies.length > 0 && replies.every((reply) => reply.ok || reply.retryable === true)) return "stay";
  return "reconnect";
}

function shouldReconnect(code: number): boolean {
  return code === 1001 || code === 1006 || code === 1011 || code === 1012 || code === 1013 || code === 1014;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.message === "Unauthorized";
}

function isCommandResult(value: unknown): value is CommandResult {
  if (!value || typeof value !== "object") return false;
  const ok = (value as { ok?: unknown }).ok;
  return ok === true || ok === false;
}

function decodeServerFrame(data: unknown): ServerFrame | "ping" | "pong" | null {
  if (typeof data !== "string") return null;
  if (data === "ping" || data === "pong") return data;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Partial<ServerFrame>;
  if (frame.v !== PROTOCOL_VERSION || typeof frame.type !== "string") return null;
  return {
    v: PROTOCOL_VERSION,
    ...(typeof frame.id === "string" ? { id: frame.id } : {}),
    type: frame.type,
    payload: frame.payload,
  };
}

export class WsConnection {
  /** True only after AUTH_OK on the current socket. */
  connected = false;
  /** False after a manual disconnect or a close that must not retry by itself. */
  active = false;
  /** 4001, 4002, or 1008: the session on this socket is over. */
  fatalClose = false;

  private ws: SocketLike | null = null;
  private generation = 0;
  private attempt = 0;
  private opening: Promise<void> | null = null;
  private manualStop = false;
  private forceReconnect = false;
  private closedNotice = false;
  private visible = true;
  private queue: string[] = [];
  private readonly pending = new Map<string, PendingAck>();
  private reconnectTimer: TimerHandle | null = null;
  private authTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private removeVisibility: (() => void) | null = null;
  private readonly listeners: ConnectionHandlers = {
    connect: new Set(),
    disconnect: new Set(),
    connect_error: new Set(),
    frame: new Set(),
  };

  constructor(private readonly options: WsConnectionOptions) {
    const initial = this.readVisibility();
    this.visible = initial !== "hidden";
    if (typeof document !== "undefined" && !options.visibilityState) {
      const onChange = () => this.noteVisibility(this.readVisibility() === "hidden" ? "hidden" : "visible");
      document.addEventListener("visibilitychange", onChange);
      this.removeVisibility = () => document.removeEventListener("visibilitychange", onChange);
    }
  }

  on(event: "connect", handler: () => void): void;
  on(event: "disconnect", handler: (reason: string) => void): void;
  on(event: "connect_error", handler: (error: Error) => void): void;
  on(event: "frame", handler: (frame: ServerFrame) => void): void;
  on(event: keyof ConnectionHandlers, handler: (...args: never[]) => void): void {
    this.listeners[event].add(handler as never);
  }

  /** Open, or no-op when a socket is already up or in flight. Resets a manual stop. */
  connect(): void {
    this.manualStop = false;
    this.fatalClose = false;
    this.closedNotice = false;
    this.active = true;
    this.clearReconnectTimer();
    if (this.connected || this.ws || this.opening) return;
    this.generation += 1;
    void this.open(this.generation);
  }

  /**
   * Client close (code 1000, reason bye). Does not reconnect.
   * Listeners stay attached so a later connect() is the same session socket.
   */
  disconnect(): void {
    const started = this.active || this.connected || this.ws !== null || this.opening !== null;
    this.manualStop = true;
    this.active = false;
    this.generation += 1;
    this.forceReconnect = false;
    this.clearReconnectTimer();
    this.clearAuthTimer();
    this.clearPing();
    this.connected = false;
    this.queue = [];
    this.rejectAll(new Error("socket has been disconnected"));
    const ws = this.ws;
    this.ws = null;
    this.opening = null;
    if (started) this.emitDisconnect("io client disconnect");
    this.closeQuiet(ws, 1000, "bye");
  }

  /** Drop document listeners and close. Used when the table socket is discarded. */
  destroy(): void {
    this.removeVisibility?.();
    this.removeVisibility = null;
    this.disconnect();
  }

  /**
   * Tab became visible or hidden. A hidden tab does not ping. A visible tab
   * whose socket is down reconnects immediately and the next failure starts
   * again at 500ms.
   */
  noteVisibility(state: Visibility): void {
    this.visible = state !== "hidden";
    if (!this.visible) {
      this.clearPing();
      return;
    }
    this.armPing();
    if (this.active && !this.manualStop && !this.connected && !this.ws && !this.opening) {
      this.clearReconnectTimer();
      this.attempt = 0;
      void this.open(this.generation);
    }
  }

  /** Fire-and-forget frame. Queued until AUTH_OK when a connect is in progress. */
  send(type: ClientFrameType, payload: unknown): void {
    this.transmit({ v: PROTOCOL_VERSION, type, payload });
  }

  /**
   * Frame with a fresh id. Resolves on ACK, rejects on timeout or if the
   * socket dies first. SERVER_ERROR is delivered to frame listeners and does
   * not settle this promise.
   */
  request(type: ClientFrameType, payload: unknown, timeoutMs?: number): Promise<CommandResult> {
    if (!this.connected && !this.active && !this.ws && !this.opening) {
      return Promise.reject(new Error("socket has been disconnected"));
    }
    const id = crypto.randomUUID();
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = timeoutMs === undefined ? null : this.scheduleTimeout(() => {
        this.pending.delete(id);
        reject(new Error("operation has timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transmit({ v: PROTOCOL_VERSION, id, type, payload });
    });
  }

  private async open(gen: number): Promise<void> {
    if (this.opening) return this.opening;
    let run: Promise<void>;
    run = this.openInner(gen).finally(() => {
      if (this.opening === run) this.opening = null;
    });
    this.opening = run;
    return run;
  }

  private async openInner(gen: number): Promise<void> {
    try {
      await this.ensureTicket();
    } catch (error) {
      if (gen !== this.generation) return;
      this.handleConnectFailure(error);
      return;
    }
    if (gen !== this.generation || !this.active || this.manualStop) return;
    const Factory = this.options.WebSocket ?? (globalThis.WebSocket as unknown as SocketFactory | undefined);
    if (!Factory) {
      this.handleConnectFailure(new Error("WebSocket connection failed"));
      return;
    }
    let ws: SocketLike;
    try {
      ws = new Factory(this.options.url);
    } catch (error) {
      if (gen !== this.generation) return;
      this.handleConnectFailure(error);
      return;
    }
    if (gen !== this.generation || !this.active || this.manualStop) {
      this.closeQuiet(ws, 1000, "bye");
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation || this.ws !== ws) return;
      this.armAuthTimer(ws);
    };
    ws.onmessage = (event) => {
      if (gen !== this.generation || this.ws !== ws) return;
      this.onMessage(event.data);
    };
    ws.onerror = () => {
      /* The close handler decides whether to retry. */
    };
    ws.onclose = (event) => {
      if (gen !== this.generation) return;
      if (this.ws === ws) this.ws = null;
      const code = typeof event.code === "number" && event.code !== 0 ? event.code : 1006;
      this.onSocketClose(code === 1005 ? 1006 : code);
    };
  }

  private async ensureTicket(): Promise<void> {
    let token = this.options.getToken();
    if (!token) token = await this.refreshToken();
    let status = await this.postTicket(token);
    if (status === 401) {
      token = await this.refreshToken();
      status = await this.postTicket(token);
    }
    if (status === 401) throw new Error("Unauthorized");
    if (status < 200 || status >= 300) throw new Error("WebSocket ticket failed");
  }

  private async refreshToken(): Promise<string> {
    if (!this.options.refreshSession) throw new Error("Unauthorized");
    const data = await this.options.refreshSession();
    if (!data?.accessToken) throw new Error("Unauthorized");
    this.options.setToken?.(data.accessToken);
    return data.accessToken;
  }

  private async postTicket(token: string): Promise<number> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(this.options.ticketUrl, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    await response.text().catch(() => "");
    return response.status;
  }

  private handleConnectFailure(error: unknown): void {
    if (!this.active || this.manualStop) return;
    if (isUnauthorized(error)) {
      this.active = false;
      this.fatalClose = true;
      this.emitConnectError(new Error("Unauthorized"));
      return;
    }
    this.emitConnectError(error instanceof Error ? error : new Error("WebSocket connection failed"));
    this.scheduleReconnect();
  }

  private armAuthTimer(ws: SocketLike): void {
    this.clearAuthTimer();
    const limit = this.options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.authTimer = this.scheduleTimeout(() => {
      this.authTimer = null;
      if (this.connected || this.ws !== ws) return;
      this.forceReconnect = true;
      this.closeQuiet(ws, 1000, "bye");
    }, limit);
  }

  private onMessage(data: unknown): void {
    const decoded = decodeServerFrame(data);
    if (decoded === null || decoded === "ping" || decoded === "pong") return;
    if (decoded.type === "ACK") {
      this.settleAck(decoded);
      return;
    }
    if (decoded.type === "AUTH_OK") this.onAuthOk();
    for (const handler of [...this.listeners.frame]) handler(decoded);
  }

  private onAuthOk(): void {
    const first = !this.connected;
    this.clearAuthTimer();
    this.connected = true;
    this.attempt = 0;
    this.fatalClose = false;
    this.closedNotice = false;
    this.flush();
    if (this.options.lobbyHello) this.send("LOBBY_HELLO", {});
    this.armPing();
    // A second AUTH_OK (a server re-confirming) must not look like a new
    // connection: the table hook joins, and resets its status, on "connect".
    if (!first) return;
    for (const handler of [...this.listeners.connect]) handler();
  }

  private settleAck(frame: ServerFrame): void {
    if (!frame.id) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer !== null) this.clearTimer(pending.timer);
    if (isCommandResult(frame.payload)) pending.resolve(frame.payload);
    else pending.reject(new Error("socket has been disconnected"));
  }

  private onSocketClose(code: number): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.clearAuthTimer();
    this.clearPing();
    this.queue = [];
    this.rejectAll(new Error("socket has been disconnected"));
    if (!this.active || this.manualStop) return;
    const retry = this.forceReconnect || shouldReconnect(code);
    this.forceReconnect = false;
    if (!retry) {
      this.active = false;
      if (code === 4001 || code === 4002 || code === 1008) this.fatalClose = true;
      if (!wasConnected && (code === 4001 || code === 4002 || code === 1008)) {
        this.emitConnectError(new Error("Unauthorized"));
        return;
      }
      this.emitDisconnect("io server disconnect");
      return;
    }
    if (!wasConnected) this.emitConnectError(new Error("WebSocket connection failed"));
    this.emitDisconnect(wasConnected ? "transport close" : "transport close");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.active || this.manualStop) return;
    this.clearReconnectTimer();
    const delay = backoffDelayMs(this.attempt, this.options.random ?? Math.random);
    const gen = this.generation;
    this.attempt += 1;
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.generation || !this.active || this.manualStop) return;
      void this.open(gen);
    }, delay);
  }

  private transmit(frame: ClientFrame): void {
    const text = JSON.stringify(frame);
    if (this.connected && this.ws && this.ws.readyState === 1) this.ws.send(text);
    else this.queue.push(text);
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const queued = this.queue;
    this.queue = [];
    for (const text of queued) this.ws.send(text);
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      if (item.timer !== null) this.clearTimer(item.timer);
      item.reject(error);
    }
  }

  private armPing(): void {
    if (!this.visible || !this.connected || this.pingTimer !== null) return;
    this.pingTimer = this.scheduleInterval(() => {
      if (!this.visible || !this.connected || !this.ws || this.ws.readyState !== 1) return;
      try { this.ws.send("ping"); } catch { /* closing */ }
    }, PING_INTERVAL_MS);
  }

  private emitConnectError(error: Error): void {
    for (const handler of [...this.listeners.connect_error]) handler(error);
  }

  private emitDisconnect(reason: string): void {
    if (this.closedNotice) return;
    this.closedNotice = true;
    for (const handler of [...this.listeners.disconnect]) handler(reason);
  }

  private readVisibility(): Visibility | DocumentVisibilityState {
    if (this.options.visibilityState) return this.options.visibilityState();
    if (typeof document === "undefined") return "visible";
    return document.visibilityState;
  }

  private scheduleTimeout(fn: () => void, ms: number): TimerHandle {
    const schedule = this.options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    return schedule(fn, ms);
  }

  private scheduleInterval(fn: () => void, ms: number): TimerHandle {
    const schedule = this.options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
    return schedule(fn, ms);
  }

  private clearTimer(handle: TimerHandle): void {
    const clear = this.options.clearTimeout ?? ((id) => clearTimeout(id));
    clear(handle);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearAuthTimer(): void {
    if (this.authTimer === null) return;
    this.clearTimer(this.authTimer);
    this.authTimer = null;
  }

  private clearPing(): void {
    if (this.pingTimer === null) return;
    const clear = this.options.clearInterval ?? ((id) => clearInterval(id));
    clear(this.pingTimer);
    this.pingTimer = null;
  }

  private closeQuiet(ws: SocketLike | null, code: number, reason: string): void {
    if (!ws || ws.readyState >= 2) return;
    try { ws.close(code, reason); } catch { /* already closing */ }
  }
}
