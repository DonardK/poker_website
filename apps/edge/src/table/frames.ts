import {
  CLIENT_FRAME,
  PROTOCOL_VERSION,
  type ClientFrameType,
} from "@poker/shared";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TURN_ID = /^\d{1,12}:\d{1,12}$/;
const TABLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIONS = new Set(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]);
const FRAME_MAX = 8_192;

const CLIENT_TYPES = new Set<string>(Object.values(CLIENT_FRAME));
const MUTATING = new Set<ClientFrameType>([
  "SEAT_CLAIM", "SIT_OUT", "SIT_IN", "STAND_UP", "ACTION_INTENT", "TABLE_KEEP_ALIVE",
]);
const NEEDS_ACK = new Set<ClientFrameType>([
  "SEAT_CLAIM", "SIT_OUT", "SIT_IN", "STAND_UP", "ACTION_INTENT", "TABLE_KEEP_ALIVE", "SESSION_RENEW",
]);

export interface SocketAttachment {
  userId: string;
  sessionId: string;
  username: string;
  connectedAt: number;
}

export interface ClientMessage {
  id?: string;
  type: ClientFrameType;
  payload: Record<string, unknown>;
}

export interface FrameFailure {
  code: string;
  message: string;
  retryable?: boolean;
  id?: string;
  tableId?: string;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function readAttachment(ws: WebSocket): SocketAttachment | null {
  const value = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
  if (!value || typeof value.userId !== "string" || typeof value.sessionId !== "string" || typeof value.username !== "string" || typeof value.connectedAt !== "number") {
    return null;
  }
  return { userId: value.userId, sessionId: value.sessionId, username: value.username, connectedAt: value.connectedAt };
}

export function fanKey(att: SocketAttachment): string {
  return `fan:${att.sessionId}:${att.connectedAt}`;
}

export function connId(att: SocketAttachment): string {
  return `${att.userId}:${att.sessionId}:${att.connectedAt}`;
}

export function sendFrame(ws: WebSocket, type: string, payload: unknown, id?: string): void {
  const frame: Record<string, unknown> = { v: PROTOCOL_VERSION, type, payload };
  if (id) frame.id = id;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* The socket is already gone. Delivery failure does not roll back. */
  }
}

export function sendFailure(ws: WebSocket, failure: FrameFailure): void {
  const payload: Record<string, unknown> = { code: failure.code, message: failure.message };
  if (failure.tableId) payload.tableId = failure.tableId;
  if (failure.retryable) payload.retryable = true;
  sendFrame(ws, "SERVER_ERROR", payload, failure.id);
  if (failure.id) {
    const ack: Record<string, unknown> = { ok: false, code: failure.code, message: failure.message };
    if (failure.retryable) ack.retryable = true;
    sendFrame(ws, "ACK", ack, failure.id);
  }
}

export function isMutating(type: ClientFrameType): boolean {
  return MUTATING.has(type);
}

function invalid(message = "Request could not be completed", id?: string, tableId?: string): FrameFailure {
  return { code: "INVALID_REQUEST", message, ...(id ? { id } : {}), ...(tableId ? { tableId } : {}) };
}

function namedTable(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("tableId" in payload)) return undefined;
  const tableId = (payload as { tableId?: unknown }).tableId;
  return typeof tableId === "string" && TABLE_ID.test(tableId) ? tableId : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(payload: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(payload);
  if (present.length !== keys.length) return false;
  return keys.every((key) => present.includes(key));
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Validate one text frame. `tableId` is this Durable Object's name; a payload
 * that names a different table is rejected.
 */
export function parseClientFrame(data: string, tableId: string): { ok: true; message: ClientMessage } | { ok: false; failure: FrameFailure } {
  if (data.length > FRAME_MAX) return { ok: false, failure: { code: "INVALID_REQUEST", message: "Request could not be completed" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return { ok: false, failure: invalid() };
  }
  if (!isObject(parsed)) return { ok: false, failure: invalid() };
  const id = parsed.id;
  const frameId = id === undefined ? undefined : uuid(id) ? id : null;
  if (frameId === null) return { ok: false, failure: invalid(undefined, undefined, namedTable(parsed.payload)) };
  if (parsed.v !== PROTOCOL_VERSION) {
    return { ok: false, failure: { code: "BAD_VERSION", message: "Unsupported protocol version", ...(frameId ? { id: frameId } : {}), ...(namedTable(parsed.payload) ? { tableId: namedTable(parsed.payload) } : {}) } };
  }
  if (typeof parsed.type !== "string" || !CLIENT_TYPES.has(parsed.type) || parsed.type === "LOBBY_HELLO") {
    return { ok: false, failure: { code: "UNKNOWN_TYPE", message: "Unknown message type", ...(frameId ? { id: frameId } : {}), ...(namedTable(parsed.payload) ? { tableId: namedTable(parsed.payload) } : {}) } };
  }
  const type = parsed.type as ClientFrameType;
  if (!isObject(parsed.payload)) return { ok: false, failure: invalid(undefined, frameId) };
  const payload = parsed.payload;
  const payloadTable = namedTable(payload);
  if (NEEDS_ACK.has(type) && !frameId) return { ok: false, failure: invalid(undefined, undefined, payloadTable) };
  const failure = validatePayload(type, payload, tableId, frameId, payloadTable);
  if (failure) return { ok: false, failure };
  return { ok: true, message: { ...(frameId ? { id: frameId } : {}), type, payload } };
}

function validatePayload(type: ClientFrameType, payload: Record<string, unknown>, tableId: string, frameId: string | undefined, payloadTable: string | undefined): FrameFailure | null {
  const bad = () => invalid(undefined, frameId, payloadTable);
  if (type === "TABLE_JOIN" || type === "TABLE_LEAVE" || type === "TABLE_KEEP_ALIVE") {
    const keys = type === "TABLE_KEEP_ALIVE" ? ["tableId", "commandId"] : ["tableId"];
    if (!exactKeys(payload, keys) || payload.tableId !== tableId) return bad();
    if (type === "TABLE_KEEP_ALIVE" && !uuid(payload.commandId)) return bad();
    return null;
  }
  if (type === "REHYDRATE") {
    const keys = Object.keys(payload);
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "tableId")) return bad();
    if (payload.tableId !== undefined && payload.tableId !== tableId) return bad();
    return null;
  }
  if (type === "SESSION_RENEW") {
    if (!exactKeys(payload, ["token"]) || typeof payload.token !== "string" || payload.token.length < 1 || payload.token.length > 4096) return bad();
    return null;
  }
  if (type === "SEAT_CLAIM") {
    if (!exactKeys(payload, ["tableId", "seatIndex", "buyIn", "commandId"])) return bad();
    if (payload.tableId !== tableId || !uuid(payload.commandId)) return bad();
    if (typeof payload.seatIndex !== "number" || !Number.isInteger(payload.seatIndex) || payload.seatIndex < 0 || payload.seatIndex > 8) return bad();
    if (typeof payload.buyIn !== "number" || !Number.isInteger(payload.buyIn) || payload.buyIn <= 0 || payload.buyIn > 40_000_000) return bad();
    return null;
  }
  if (type === "SIT_OUT" || type === "SIT_IN" || type === "STAND_UP") {
    if (!exactKeys(payload, ["tableId", "commandId"]) || payload.tableId !== tableId || !uuid(payload.commandId)) return bad();
    return null;
  }
  if (type === "ACTION_INTENT") {
    if (!optionalActionKeys(payload) || payload.tableId !== tableId || !uuid(payload.clientActionId)) return bad();
    if (typeof payload.revision !== "number" || !Number.isInteger(payload.revision) || payload.revision < 0) return bad();
    if (typeof payload.action !== "string" || !ACTIONS.has(payload.action)) return bad();
    if (payload.amount !== undefined && (typeof payload.amount !== "number" || !Number.isInteger(payload.amount) || payload.amount <= 0 || payload.amount > 2_000_000_000)) return bad();
    if (payload.turnId !== undefined && (typeof payload.turnId !== "string" || !TURN_ID.test(payload.turnId))) return bad();
    return null;
  }
  return bad();
}

function optionalActionKeys(payload: Record<string, unknown>): boolean {
  const allowed = new Set(["tableId", "revision", "action", "amount", "clientActionId", "turnId"]);
  const keys = Object.keys(payload);
  if (!keys.includes("tableId") || !keys.includes("revision") || !keys.includes("action") || !keys.includes("clientActionId")) return false;
  return keys.every((key) => allowed.has(key));
}

export function frameByteLength(message: string | ArrayBuffer): number {
  return typeof message === "string" ? message.length : message.byteLength;
}
