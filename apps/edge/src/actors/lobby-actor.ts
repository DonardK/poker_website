import { DurableObject } from "cloudflare:workers";
import type { AuthOkPayload, LobbySeatPatch, SessionEndReason, SessionRevokedPayload, TableIdleNoticePayload, UserPatchPayload } from "@poker/shared";
import { prismaRuntime } from "../db/client";
import type { PrismaClient } from "../generated/prisma/client";
import type { Env } from "../env";

void prismaRuntime;
import { readEdgeConfig } from "../env";
import type { SessionDelivery } from "../session/contract";
import { ensureTables } from "./sql";
import { connectionId, readAttachment, writeAttachment, type LobbyAttachment } from "../lobby/attachment";
import { loadSession, readCookie, verifyAccessToken, verifyWsTicket } from "../lobby/auth";
import { withPrisma } from "../lobby/db";
import { MESSAGES, MAX_FRAME_BYTES, frameByteLength, parseClientFrame, refuse, sendFrame } from "../lobby/frames";
import { idleNoticeFor, parseIdleNotice, parseUserPatch, rememberDeadline, type StoredIdleNotice } from "../lobby/idle";
import { keepAliveFailure, relayKeepAlive, userIsSeated } from "../lobby/keep-alive";
import { toLobbyPatch } from "../lobby/patch";
import { lobbyPorts } from "../lobby/ports";
import { allowFrame, clearFrameRate } from "../lobby/rate";
import { activeTableId, loadLobbyTables } from "../lobby/tables";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS frame_rate (
    conn_id TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    n INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idle_notice (
    user_id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    closing_at INTEGER NOT NULL
  )`,
] as const;

/**
 * The single lobby object (`getByName("lobby")`). WebSocket Hibernation API.
 * Postgres is the list authority. This object does not store table ciphertext.
 *
 * USER_PATCH and TABLE_IDLE_NOTICE arrive through `deliver` (UserSessions owns
 * who to notify). SESSION_REVOKED is `disconnectSession`. AUTH_OK is sent here
 * on a successful upgrade.
 */
export class LobbyActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      ensureTables(this.ctx.storage.sql, SCHEMA);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return text(426, "Expected WebSocket");
    }
    const token = readCookie(request.headers.get("Cookie"), "poker_ws");
    if (!token) return text(401, "Unauthorized");
    let secret: string;
    try {
      secret = readEdgeConfig(this.env).wsTicketSecret;
    } catch (err) {
      log("lobby_config_invalid", err);
      return unavailable();
    }
    const ticket = await verifyWsTicket(token, secret);
    if (!ticket) return text(401, "Unauthorized");

    let verdict: Awaited<ReturnType<typeof loadSession>>;
    try {
      verdict = await withPrisma(this.env, (prisma) => loadSession(prisma, ticket.sub, ticket.sid));
    } catch {
      return unavailable();
    }
    if (verdict.ok === false && verdict.action === "unavailable") return unavailable();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return unavailable();
    const username = verdict.ok ? verdict.identity.username : ticket.username;
    const attachment: LobbyAttachment = {
      userId: ticket.sub,
      sessionId: ticket.sid,
      username,
      connectedAt: Date.now(),
    };

    if (!verdict.ok) {
      this.ctx.acceptWebSocket(server);
      writeAttachment(server, attachment);
      sendFrame(server, "SESSION_REVOKED", { reason: verdict.reason } satisfies SessionRevokedPayload);
      server.close(4001, "session");
      return upgrade(client);
    }

    this.ctx.acceptWebSocket(server, [`user:${attachment.userId}`, `session:${attachment.sessionId}`]);
    writeAttachment(server, attachment);
    await this.registerConnection(attachment);
    try {
      const auth = await withPrisma(this.env, (prisma) => this.authOk(prisma, attachment));
      sendFrame(server, "AUTH_OK", auth);
    } catch (err) {
      log("lobby_auth_ok_failed", err);
      server.close(1011, "error");
    }
    return upgrade(client);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      ws.close(1008, "policy");
      return;
    }
    if (typeof message !== "string") {
      ws.close(1003, "binary");
      return;
    }
    if (message === "ping") return;
    if (frameByteLength(message) > MAX_FRAME_BYTES) {
      allowFrame(this.ctx.storage.sql, connectionId(attachment), Date.now());
      ws.close(1009, "too-large");
      return;
    }
    if (!allowFrame(this.ctx.storage.sql, connectionId(attachment), Date.now())) {
      const parsed = parseClientFrame(message);
      const id = "id" in parsed ? parsed.id : undefined;
      refuse(ws, id, "RATE_LIMITED", MESSAGES.rate, { retryable: true, tableId: "tableId" in parsed ? parsed.tableId : undefined });
      return;
    }
    try {
      await this.dispatch(ws, attachment, parseClientFrame(message));
    } catch (err) {
      log("lobby_message_failed", err);
      ws.close(1011, "error");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment) {
      clearFrameRate(this.ctx.storage.sql, connectionId(attachment));
      await this.unregisterConnection(attachment);
    }
    try {
      ws.close(code, reason);
    } catch {
      /* The runtime may already have completed the close handshake. */
    }
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log("lobby_socket_error", error);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  /** TableActor calls this after a committed occupancy, status, or blind change. */
  async patch(entry: LobbySeatPatch): Promise<void> {
    if (!isPatch(entry)) {
      log("lobby_patch_invalid");
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (!attachment) continue;
      sendFrame(ws, "LOBBY_PATCH", toLobbyPatch(entry, attachment.userId));
    }
  }

  /**
   * UserSessions.revoke calls this. Sends SESSION_REVOKED and closes 4001.
   * The session id lives on the attachment: hibernation tags cannot be
   * retagged after SESSION_RENEW, so a stale `session:` tag is not authoritative.
   */
  async disconnectSession(sessionId: string, reason: SessionEndReason): Promise<void> {
    const payload: SessionRevokedPayload = { reason };
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws)?.sessionId !== sessionId) continue;
      sendFrame(ws, "SESSION_REVOKED", payload);
      try {
        ws.close(4001, "session");
      } catch {
        /* already closed */
      }
    }
  }

  /** UserSessions.notify forwards USER_PATCH and TABLE_IDLE_NOTICE here. */
  async deliver(input: SessionDelivery): Promise<void> {
    if (!input || (input.event !== "USER_PATCH" && input.event !== "TABLE_IDLE_NOTICE")) return;
    if (typeof input.userId !== "string" || input.userId.length < 1) return;
    let payload: UserPatchPayload | TableIdleNoticePayload | null = null;
    if (input.event === "USER_PATCH") payload = parseUserPatch(input.payload);
    else {
      const notice = parseIdleNotice(input.payload);
      if (notice) {
        this.storeIdle(input.userId, notice);
        payload = notice;
      }
    }
    if (!payload) {
      log("lobby_deliver_invalid");
      return;
    }
    const tagged = this.ctx.getWebSockets(`user:${input.userId}`);
    const sockets = tagged.length > 0 ? tagged : this.ctx.getWebSockets().filter((ws) => readAttachment(ws)?.userId === input.userId);
    for (const ws of sockets) {
      const attachment = readAttachment(ws);
      if (!attachment || attachment.userId !== input.userId) continue;
      if (input.sessionId && attachment.sessionId !== input.sessionId) continue;
      if (input.event === "USER_PATCH") sendFrame(ws, "USER_PATCH", payload as UserPatchPayload);
      else sendFrame(ws, "TABLE_IDLE_NOTICE", payload as TableIdleNoticePayload);
    }
  }

  private async dispatch(ws: WebSocket, attachment: LobbyAttachment, frame: ReturnType<typeof parseClientFrame>): Promise<void> {
    if (frame.kind === "bad_version") {
      refuse(ws, frame.id, "BAD_VERSION", MESSAGES.version);
      return;
    }
    if (frame.kind === "invalid") {
      refuse(ws, frame.id, "INVALID_REQUEST", MESSAGES.invalid, { tableId: frame.tableId });
      return;
    }
    if (frame.kind === "unknown") {
      refuse(ws, frame.id, "UNKNOWN_TYPE", MESSAGES.unknown);
      return;
    }
    if (frame.kind === "hello") {
      try {
        const tables = await withPrisma(this.env, (prisma) => loadLobbyTables(prisma, attachment.userId));
        sendFrame(ws, "LOBBY_SNAPSHOT", { tables });
      } catch (err) {
        log("lobby_snapshot_failed", err);
        refuse(ws, undefined, "SERVICE_UNAVAILABLE", MESSAGES.unavailable, { retryable: true });
      }
      return;
    }
    if (frame.kind === "keep_alive") {
      await this.keepAlive(ws, attachment, frame.id, frame.tableId, frame.commandId);
      return;
    }
    await this.renew(ws, attachment, frame.id, frame.token);
  }

  private async keepAlive(ws: WebSocket, attachment: LobbyAttachment, id: string, tableId: string, commandId: string): Promise<void> {
    const verdict = await withPrisma(this.env, (prisma) => loadSession(prisma, attachment.userId, attachment.sessionId));
    if (verdict.ok === false && verdict.action === "unavailable") {
      refuse(ws, id, "SERVICE_UNAVAILABLE", MESSAGES.unavailable, { retryable: true, tableId });
      return;
    }
    if (!verdict.ok) {
      this.endSession(ws, id, verdict.reason, tableId);
      return;
    }
    let seated = false;
    try {
      seated = await withPrisma(this.env, (prisma) => userIsSeated(prisma, attachment.userId, tableId));
    } catch (err) {
      log("lobby_seat_lookup_failed", err);
      refuse(ws, id, "SERVICE_UNAVAILABLE", MESSAGES.unavailable, { retryable: true, tableId });
      return;
    }
    try {
      const result = await relayKeepAlive(seated, attachment.userId, commandId, lobbyPorts.tableKeepAlive(this.env, tableId));
      if (!result.ok) {
        refuse(ws, id, result.code, result.message, { tableId });
        return;
      }
      sendFrame(ws, "ACK", result.duplicate ? { ok: true, duplicate: true } : { ok: true }, id);
    } catch (err) {
      const failure = keepAliveFailure(err);
      if (failure.code === "SERVICE_UNAVAILABLE") log("lobby_keep_alive_failed");
      refuse(ws, id, failure.code, failure.message, { retryable: failure.retryable, tableId });
    }
  }

  private async renew(ws: WebSocket, attachment: LobbyAttachment, id: string, token: string): Promise<void> {
    let secret: string;
    try {
      secret = readEdgeConfig(this.env).jwtAccessSecret;
    } catch (err) {
      log("lobby_config_invalid", err);
      refuse(ws, id, "SERVICE_UNAVAILABLE", MESSAGES.unavailable, { retryable: true });
      return;
    }
    const claims = await verifyAccessToken(token, secret);
    if (!claims) {
      refuse(ws, id, "UNAUTHORIZED", MESSAGES.unauthorized);
      ws.close(4002, "unauthorized");
      return;
    }
    if (claims.sub !== attachment.userId) {
      console.log(JSON.stringify({ security: "SESSION_RENEW_USER_MISMATCH", userId: attachment.userId, tokenUserId: claims.sub }));
      refuse(ws, id, "UNAUTHORIZED", MESSAGES.unauthorized);
      ws.close(4002, "unauthorized");
      return;
    }
    const verdict = await withPrisma(this.env, (prisma) => loadSession(prisma, claims.sub, claims.sid));
    if (verdict.ok === false && verdict.action === "unavailable") {
      refuse(ws, id, "SERVICE_UNAVAILABLE", MESSAGES.unavailable, { retryable: true });
      return;
    }
    if (!verdict.ok) {
      this.endSession(ws, id, verdict.reason);
      return;
    }
    const previous = attachment.sessionId;
    const next: LobbyAttachment = { ...attachment, sessionId: verdict.identity.sessionId, username: verdict.identity.username };
    writeAttachment(ws, next);
    if (previous !== next.sessionId) {
      await this.unregisterConnection(attachment);
      await this.registerConnection(next);
    }
    sendFrame(ws, "ACK", { ok: true }, id);
  }

  private endSession(ws: WebSocket, id: string | undefined, reason: SessionEndReason, tableId?: string): void {
    sendFrame(ws, "SESSION_REVOKED", { reason });
    refuse(ws, id, "UNAUTHORIZED", MESSAGES.unauthorized, { tableId });
    ws.close(4001, "session");
  }

  private async authOk(prisma: PrismaClient, attachment: LobbyAttachment): Promise<AuthOkPayload> {
    const tableId = await activeTableId(prisma, attachment.userId);
    const live = tableId ? await this.liveIdle(tableId, attachment.userId) : null;
    if (live) this.storeIdle(attachment.userId, live);
    return {
      userId: attachment.userId,
      username: attachment.username,
      activeTableId: tableId,
      idleNotice: idleNoticeFor(this.readIdle(attachment.userId), tableId, Date.now()),
    };
  }

  /** TableActor is the engine authority. A miss falls back to the last delivered notice. */
  private async liveIdle(tableId: string, userId: string): Promise<TableIdleNoticePayload | null> {
    try {
      return await lobbyPorts.tableIdle(this.env, tableId).currentIdleNotice(userId);
    } catch (err) {
      log("lobby_idle_notice_unavailable", err);
      return null;
    }
  }

  private storeIdle(userId: string, notice: TableIdleNoticePayload): void {
    const deadline = rememberDeadline(notice, Date.now());
    if (!deadline) {
      this.ctx.storage.sql.exec("DELETE FROM idle_notice WHERE user_id = ?", userId);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO idle_notice (user_id, table_id, table_name, closing_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET table_id = excluded.table_id, table_name = excluded.table_name, closing_at = excluded.closing_at`,
      userId,
      deadline.tableId,
      deadline.tableName,
      deadline.closingAt,
    );
  }

  private readIdle(userId: string): StoredIdleNotice | undefined {
    const row = this.ctx.storage.sql
      .exec("SELECT table_id, table_name, closing_at FROM idle_notice WHERE user_id = ?", userId)
      .toArray()[0];
    if (!row) return undefined;
    return {
      table_id: String(row.table_id),
      table_name: String(row.table_name),
      closing_at: Number(row.closing_at),
    };
  }

  private async registerConnection(attachment: LobbyAttachment): Promise<void> {
    try {
      await lobbyPorts.userSessions(this.env, attachment.userId).register({
        sessionId: attachment.sessionId,
        target: "lobby",
        connId: connectionId(attachment),
      });
    } catch {
      log("lobby_register_unavailable");
    }
  }

  private async unregisterConnection(attachment: LobbyAttachment): Promise<void> {
    try {
      await lobbyPorts.userSessions(this.env, attachment.userId).unregister({ connId: connectionId(attachment) });
    } catch {
      log("lobby_unregister_unavailable");
    }
  }
}

export type LobbyDelivery = SessionDelivery;

function isPatch(entry: LobbySeatPatch): boolean {
  if (!entry || typeof entry !== "object" || typeof entry.removed !== "boolean" || !entry.table) return false;
  if (!Array.isArray(entry.seatedUserIds) || entry.seatedUserIds.length > 9) return false;
  if (!entry.seatedUserIds.every((id) => typeof id === "string")) return false;
  const table = entry.table;
  const statusOk = table.status === "WAITING" || table.status === "IN_HAND" || table.status === "PAUSED" || table.status === "CLOSED";
  const numbers = [table.maxSeats, table.occupiedSeats, table.smallBlind, table.bigBlind, table.minBuyIn, table.maxBuyIn, table.botCount];
  return typeof table.id === "string" && table.id.length > 0 && table.id.length <= 128
    && typeof table.name === "string"
    && statusOk
    && numbers.every((value) => typeof value === "number" && Number.isFinite(value));
}

function upgrade(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function unavailable(): Response {
  return new Response(JSON.stringify({ error: "Service temporarily unavailable, please retry", retryable: true }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "2" },
  });
}

/** Log the failure class only. Prisma messages can contain a connection string. */
function log(event: string, err?: unknown): void {
  const name = err instanceof Error ? err.name : undefined;
  console.log(JSON.stringify(name ? { event, name } : { event }));
}
