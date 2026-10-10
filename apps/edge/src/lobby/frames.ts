import { z } from "zod";
import type { ServerFrame, ServerFrameMap, ServerFrameType } from "@poker/shared";

export const MAX_FRAME_BYTES = 8192;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MESSAGES = {
  invalid: "Request could not be completed",
  unauthorized: "Please sign in again",
  unavailable: "Temporarily unavailable, please retry",
  rate: "Too many requests",
  unknown: "Unknown frame type",
  version: "Unsupported protocol version",
} as const;

const uuid = z.string().regex(UUID_V4);
const tableIdSchema = z.string().min(1).max(128);
const lobbyHello = z.object({}).strict();
const keepAlivePayload = z.object({ tableId: tableIdSchema, commandId: uuid }).strict();
const renewPayload = z.object({ token: z.string().min(1).max(4096) }).strict();

export type ParsedFrame =
  | { kind: "bad_version"; id?: string }
  | { kind: "invalid"; id?: string; tableId?: string }
  | { kind: "unknown"; id?: string }
  | { kind: "hello" }
  | { kind: "keep_alive"; id: string; tableId: string; commandId: string }
  | { kind: "renew"; id: string; token: string };

export function frameByteLength(message: string | ArrayBuffer): number {
  if (typeof message === "string") return new TextEncoder().encode(message).byteLength;
  return message.byteLength;
}

export function parseClientFrame(message: string): ParsedFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "invalid" };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "v" && key !== "id" && key !== "type" && key !== "payload") return { kind: "invalid" };
  }
  const id = optionalId(record.id);
  if (record.id !== undefined && !id) return { kind: "invalid", tableId: namedTableId(record.payload) };
  if (record.v !== 1) return { kind: "bad_version", id };
  if (typeof record.type !== "string") return { kind: "invalid", id, tableId: namedTableId(record.payload) };
  const tableId = namedTableId(record.payload);
  if (record.type === "LOBBY_HELLO") {
    return lobbyHello.safeParse(record.payload).success ? { kind: "hello" } : { kind: "invalid", id, tableId };
  }
  if (record.type === "TABLE_KEEP_ALIVE") {
    const parsed = keepAlivePayload.safeParse(record.payload);
    if (!parsed.success || !id) return { kind: "invalid", id, tableId: parsed.success ? parsed.data.tableId : tableId };
    return { kind: "keep_alive", id, tableId: parsed.data.tableId, commandId: parsed.data.commandId };
  }
  if (record.type === "SESSION_RENEW") {
    const parsed = renewPayload.safeParse(record.payload);
    if (!parsed.success || !id) return { kind: "invalid", id, tableId };
    return { kind: "renew", id, token: parsed.data.token };
  }
  return { kind: "unknown", id };
}

export function namedTableId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("tableId" in payload)) return undefined;
  const parsed = tableIdSchema.safeParse((payload as { tableId?: unknown }).tableId);
  return parsed.success ? parsed.data : undefined;
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function sendFrame<T extends ServerFrameType>(ws: WebSocket, type: T, payload: ServerFrameMap[T], id?: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame: ServerFrame<ServerFrameMap[T]> = id ? { v: 1, id, type, payload } : { v: 1, type, payload };
  ws.send(JSON.stringify(frame));
}

export function refuse(
  ws: WebSocket,
  id: string | undefined,
  code: string,
  message: string,
  extra?: { tableId?: string; retryable?: boolean },
): void {
  const error = {
    code,
    message,
    ...(extra?.tableId ? { tableId: extra.tableId } : {}),
    ...(extra?.retryable ? { retryable: true as const } : {}),
  };
  sendFrame(ws, "SERVER_ERROR", error, id);
  if (id) {
    sendFrame(ws, "ACK", {
      ok: false,
      code,
      message,
      ...(extra?.retryable ? { retryable: true } : {}),
    }, id);
  }
}
