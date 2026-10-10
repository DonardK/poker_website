import { DurableObject } from "cloudflare:workers";
import type { CommandResult, SessionEndReason, TableIdleNoticePayload } from "@poker/shared";
import { prismaRuntime } from "../db/client";
import type { Env } from "../env";

void prismaRuntime;
import type { SessionDelivery } from "../session/contract";
import { ensureTables } from "./sql";
import { readAttachment, sendFrame } from "../table/frames";
import type { Effects, TableRuntime } from "../table/host";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
] as const;

/**
 * One SQLite-backed object per poker table. Sockets hibernate. Postgres
 * (via the host module) is the authority for chips, seats, and hand history.
 */
export class TableActor extends DurableObject<Env> {
  private gateDepth = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureTables(this.ctx.storage.sql, TABLES);
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private runtime(): TableRuntime {
    return {
      ctx: this.ctx,
      env: this.env,
      tableId: this.ctx.id.name ?? "",
      gate: (fn) => this.gate(fn),
    };
  }

  private async gate<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.gateDepth > 0) return fn();
    this.gateDepth += 1;
    try {
      return await this.ctx.blockConcurrencyWhile(async () => fn());
    } finally {
      this.gateDepth -= 1;
    }
  }

  private async finish(effects: Effects): Promise<void> {
    const { flushEffects } = await import("../table/host");
    await flushEffects(this.env, effects);
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.id.name) return new Response("Not found", { status: 404 });
    const { acceptSocket } = await import("../table/host");
    return acceptSocket(this.runtime(), request);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { onSocketMessage } = await import("../table/host");
    try {
      const effects = await this.gate(() => onSocketMessage(this.runtime(), ws, message));
      await this.finish(effects);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", message: "table socket failed", name: err instanceof Error ? err.name : "error" }));
      try { ws.close(1011, "error"); } catch { /* already closed */ }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const { onSocketClose } = await import("../table/host");
    const effects = onSocketClose(this.runtime(), ws);
    await this.finish(effects);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
  }

  override async alarm(): Promise<void> {
    const { onAlarm } = await import("../table/host");
    try {
      const effects = await this.gate(() => onAlarm(this.runtime()));
      await this.finish(effects);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", message: "table alarm failed", name: err instanceof Error ? err.name : "error" }));
      try { await this.ctx.storage.setAlarm(Date.now() + 2_000); } catch { /* storage unavailable */ }
    }
  }

  async track(): Promise<void> {
    const { track } = await import("../table/host");
    const effects = await this.gate(() => track(this.runtime()));
    await this.finish(effects);
  }

  async disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void> {
    const payload = { reason };
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws)?.sessionId !== sessionId) continue;
      sendFrame(ws, "SESSION_REVOKED", payload);
      try { ws.close(4001, "session"); } catch { /* already closed */ }
    }
  }

  async deliver(input: SessionDelivery): Promise<void> {
    if (input.event !== "USER_PATCH" && input.event !== "TABLE_IDLE_NOTICE") return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (!attachment || attachment.userId !== input.userId) continue;
      if (input.sessionId && attachment.sessionId !== input.sessionId) continue;
      sendFrame(ws, input.event, input.payload);
    }
  }

  async keepAlive(userId: string, commandId?: string): Promise<Extract<CommandResult, { ok: true }>> {
    const { keepAlive } = await import("../table/host");
    const packed = await this.gate(() => keepAlive(this.runtime(), userId, commandId));
    await this.finish(packed.effects);
    if (!packed.result.ok) {
      const error = new Error(packed.result.code);
      (error as Error & { code: string }).code = packed.result.code;
      throw error;
    }
    return packed.result;
  }

  async currentIdleNotice(userId: string): Promise<TableIdleNoticePayload | null> {
    const { currentIdleNotice } = await import("../table/host");
    return this.gate(() => currentIdleNotice(this.runtime(), userId));
  }

  /** Test-only. Not an HTTP route. `throw-after-postgres` and `leak`. */
  async armTestFault(fault: string): Promise<void> {
    const { armTestFault } = await import("../table/host");
    armTestFault(this.runtime(), fault);
  }

  /** Test-only fixture writer. Not an HTTP route. */
  async testPrepare(input: {
    tableId: string;
    tableName: string;
    smallBlind: number;
    bigBlind: number;
    maxSeats: number;
    minBuyIn: number;
    maxBuyIn: number;
    timeBankMs: number;
    players: { username: string; bankroll: number }[];
  }): Promise<{ players: { userId: string; sessionId: string; username: string; ticket: string }[] }> {
    const { prepareFixture } = await import("../table/host");
    return this.gate(() => prepareFixture(this.runtime(), input));
  }

  /** Test-only read of command rows and bankrolls. Does not return ciphertext. */
  async testFacts(userIds: string[]): Promise<{
    commands: { id: string; kind: string; appliedRevision: number }[];
    bankrolls: Record<string, number>;
    handCount: number;
    status: string | null;
    revision: string | null;
    enginePrefix: string | null;
  }> {
    const { tableFacts } = await import("../table/host");
    return tableFacts(this.runtime(), userIds);
  }
}

export function acceptAndClose(ctx: DurableObjectState, request: Request): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.close(1011, "error");
  return new Response(null, { status: 101, webSocket: client });
}
