import { allowAction } from "./rate-limit.js";
import { createAdapter } from "@socket.io/redis-adapter";
import cors from "cors";
import { Server } from "socket.io";
import { z } from "zod";
import { SOCKET_EVENTS, type CommandAck } from "@poker/shared";
import { EngineError } from "@poker/engine";
import { env, isProd, redisEnabled } from "../config.js";
import { logger } from "../logger.js";
import { prisma } from "../db/prisma.js";
import { redisPub, redisSub } from "../redis/client.js";
import { getActiveTableForUser } from "../redis/table-state.js";
import { isAuthError } from "../auth/errors.js";
import { authenticate } from "../auth/middleware.js";
import { onSessionsRevoked } from "../auth/sessions.js";
import { tableManager } from "../game/manager.js";
import { engineTransportGuard, isSecureTransport, type WebServer } from "../transport.js";
import { attachNotifier } from "./notify.js";
import { roomFor } from "./rooms.js";
import type { PokerServer } from "./types.js";
export type { PokerServer } from "./types.js";

const id = z.string().min(1).max(128);
const tablePayload = z.object({ tableId: id }).strict();

/**
 * The table a refused request named, if it named a well-formed id (even in an
 * otherwise invalid payload). SERVER_ERROR carries it so a page ignores a late
 * refusal meant for another table (e.g. the lobby's keep-alive for the table
 * the player left). Acks answer their own request and do not need it.
 */
function namedTable(raw: unknown): { tableId?: string } {
  const tableId = typeof raw === "object" && raw !== null ? (raw as { tableId?: unknown }).tableId : undefined;
  return id.safeParse(tableId).success ? { tableId: tableId as string } : {};
}
/** Every socket of a session joins this room; revocation disconnects it (user:<id> carries private per-user events). */
const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const actionPayload =tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid() });

export function createSocketServer(httpServer: WebServer): PokerServer {
  const io: PokerServer = new Server(httpServer, {
    maxHttpBufferSize: 8192,
    // The web app bundles socket.io-client. Not serving the client file keeps
    // every response on the Socket.io path behind the engine.io middlewares.
    serveClient: false,
    // The origin check applies in every environment. In production the
    // transport guard below has already refused any handshake without TLS;
    // this second check covers handshakes only.
    allowRequest: (req, callback) => {
      const originOk = !req.headers.origin || req.headers.origin === env.CLIENT_ORIGIN;
      const transportOk = !isProd || isSecureTransport(req, env.TRUST_PROXY_HOPS);
      if (!transportOk) logger.warn({ security: "INSECURE_TRANSPORT", remoteAddress: req.socket.remoteAddress }, "refused Socket.io handshake without TLS");
      callback(null, originOk && transportOk);
    },
  });
  // COMPLIANCE (TLS): hole cards are pushed over this connection. `allowRequest`
  // sees only handshakes, so in production the guard runs as the first engine.io
  // middleware, which engine.io applies to EVERY request on the Socket.io path:
  // the handshake, each long-polling GET/POST of an open session (sid) and each
  // WebSocket upgrade (see engineTransportGuard in transport.ts). CORS is
  // registered after it, so a plaintext CORS preflight is refused as well.
  if (isProd) {
    io.engine.use(engineTransportGuard(env.TRUST_PROXY_HOPS, (req) => {
      logger.warn({ security: "INSECURE_TRANSPORT", method: req.method, path: req.url?.split("?")[0]?.slice(0, 100), remoteAddress: (req.socket as { remoteAddress?: string } | null)?.remoteAddress },
        "refused engine.io request without TLS");
    }));
  }
  io.engine.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  if (redisEnabled && redisPub && redisSub) io.adapter(createAdapter(redisPub, redisSub));
  tableManager.attach(io);
  attachNotifier(io);
  // Revocation (logout, logout-all, a revoked device, refresh-token reuse):
  // every socket of each revoked session is told why and disconnected at once.
  // Rooms go through the adapter, so this reaches sockets on every server
  // process when the Redis adapter is in use.
  const stopRevocations = onSessionsRevoked((sessionIds, reason) => {
    for (const sessionId of sessionIds) {
      const room = sessionRoom(sessionId);
      io.to(room).emit(SOCKET_EVENTS.SESSION_REVOKED, { reason });
      io.in(room).disconnectSockets(true);
    }
  });
  httpServer.once("close", stopRevocations);
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || token.length > 4096) return next(new Error("Unauthorized"));
    try {
      const { claims, user } = await authenticate(token);
      socket.data = { userId: user.id, username: user.username, sessionId: claims.sid, token };
      next();
    } catch (err) {
      if (isAuthError(err)) { next(new Error("Unauthorized")); return; }
      // The check could not run (database unavailable): the client keeps its
      // session and retries the connection; it must not sign the player out.
      logger.warn({ err }, "socket authentication unavailable; handshake refused as retryable");
      const refusal: Error & { data?: { code: string; retryable: true } } = new Error("Service temporarily unavailable");
      refusal.data = { code: "SERVICE_UNAVAILABLE", retryable: true };
      next(refusal);
    }
  });
  io.on("connection", (socket) => {
    const { userId, username } = socket.data;
    void socket.join([`user:${userId}`, sessionRoom(socket.data.sessionId)]);
    let windowStart = Date.now(); let count = 0;
    /**
     * Every packet re-validates the session (cached, see auth/sessions.ts):
     * - credential problem: SESSION_REVOKED (when the session itself is over;
     *   an expired access token is not, the client just refreshes), the
     *   refusal, then disconnect;
     * - the check failed (database unavailable): only this packet is refused,
     *   SERVICE_UNAVAILABLE with retryable: true; the socket stays connected.
     * SESSION_RENEW is verified by its own handler against the NEW token: the
     * old access token may have just expired, which is when clients renew.
     */
    socket.use(async (packet, next) => {
      const reject = (code: string, message: string, retryable?: true) => {
        const extra = retryable ? { retryable } : {};
        socket.emit(SOCKET_EVENTS.SERVER_ERROR, { code, message, ...extra, ...namedTable(packet[1]) });
        const ack = packet.at(-1);
        if (typeof ack === "function") ack({ ok: false, code, message, ...extra });
      };
      if (Date.now() - windowStart >= 2_000) { windowStart = Date.now(); count = 0; }
      if (++count > 20 || !allowAction(userId)) { reject("RATE_LIMITED", "Too many requests"); return; }
      if (packet[0] === SOCKET_EVENTS.SESSION_RENEW) { next(); return; }
      try {
        await authenticate(socket.data.token);
      } catch (err) {
        if (isAuthError(err)) {
          if (err.reason) socket.emit(SOCKET_EVENTS.SESSION_REVOKED, { reason: err.reason });
          reject("UNAUTHORIZED", "Please sign in again");
          socket.disconnect(true);
          return;
        }
        logger.warn({ err, userId }, "session check unavailable; refused one socket request as retryable");
        reject("SERVICE_UNAVAILABLE", "Temporarily unavailable, please retry", true);
        return;
      }
      next();
    });
    /**
     * Swap this socket's access token after an HTTP refresh, in place (no
     * reconnect, no table reset). The new token must verify (else the socket
     * is closed) and name the SAME user (else refused and closed: a socket
     * never changes owner). The socket moves to the new session's room, so a
     * later revocation of either session reaches the right sockets.
     */
    socket.on(SOCKET_EVENTS.SESSION_RENEW, (raw, ack) => { void (async () => {
      const { token } = z.object({ token: z.string().min(1).max(4096) }).strict().parse(raw);
      const answer = (result: Parameters<CommandAck>[0]) => { if (typeof ack === "function") ack(result); };
      let renewed: Awaited<ReturnType<typeof authenticate>>;
      try {
        renewed = await authenticate(token);
      } catch (err) {
        if (isAuthError(err)) { answer({ ok: false, code: "UNAUTHORIZED", message: "Please sign in again" }); socket.disconnect(true); return; }
        logger.warn({ err, userId }, "session renewal unavailable; refused as retryable");
        answer({ ok: false, code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable, please retry", retryable: true });
        return;
      }
      if (renewed.user.id !== socket.data.userId) {
        logger.warn({ security: "SESSION_RENEW_USER_MISMATCH", userId: socket.data.userId, tokenUserId: renewed.user.id }, "SECURITY EVENT: a socket tried to renew with another user's token; disconnected");
        answer({ ok: false, code: "UNAUTHORIZED", message: "Please sign in again" });
        socket.disconnect(true);
        return;
      }
      const previous = socket.data.sessionId;
      socket.data.token = token;
      socket.data.sessionId = renewed.claims.sid;
      if (previous !== renewed.claims.sid) {
        await socket.join(sessionRoom(renewed.claims.sid));
        await socket.leave(sessionRoom(previous));
      }
      answer({ ok: true });
    })().catch((err) => failure(err, ack, raw)); });
    /** Refuse a request: SERVER_ERROR (scoped to the table `raw` named, if any) and the ack, if one was asked for. */
    const failure = (err: unknown, ack?: CommandAck, raw?: unknown) => {
      logger.warn({ err }, "socket request rejected");
      const error = { code: err instanceof EngineError ? err.code : "INVALID_REQUEST", message: err instanceof EngineError ? err.message : "Request could not be completed" };
      socket.emit(SOCKET_EVENTS.SERVER_ERROR, { ...error, ...namedTable(raw) });
      if (typeof ack === "function") ack({ ok: false, ...error });
    };
    const checkTable = async (tableId: string) => {
      const row = await prisma.table.findUnique({ where: { id: tableId }, select: { status: true, isPrivate: true, hostId: true } });
      if (!row || (row.isPrivate && row.hostId !== userId && !await prisma.tableSeat.findFirst({ where: { tableId, userId }, select: { id: true } }))) throw new EngineError("TABLE_NOT_FOUND", "Table not found");
      // Checked after membership, so an outsider cannot learn that a private table existed.
      if (row.status === "CLOSED") throw new EngineError("TABLE_CLOSED", "This table has closed");
    };
    const join = async (tableId: string) => {
      await checkTable(tableId);
      for (const room of socket.rooms) if (room.startsWith("table:") && room !== roomFor(tableId)) await socket.leave(room);
      await socket.join(roomFor(tableId));
      const snap = await tableManager.snapshot(tableId, userId);
      if (!snap) {
        // Closed between the check and the join, after its room was emptied:
        // this socket would wait for a state that never comes. Leave the room
        // and say why (the check now finds the CLOSED row). An open table
        // passes the check: the leak guard refused this viewer's projection
        // (a logged security event), and nothing is sent, as for a broadcast.
        try { await checkTable(tableId); } catch (err) { await socket.leave(roomFor(tableId)); throw err; }
        return;
      }
      socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap);
      if (snap.phase === "WAITING" || snap.phase === "COMPLETE") await tableManager.tryStart(tableId);
    };
    // With the seated table's active idle warning, if any, so a reconnecting or
    // reloading player never misses it (read-only lookup, no table snapshot).
    void getActiveTableForUser(userId).then(async (activeTableId) => {
      const idleNotice = activeTableId ? await tableManager.currentIdleNotice(activeTableId, userId) : null;
      socket.emit(SOCKET_EVENTS.AUTH_OK, { userId, username, activeTableId, idleNotice });
    }).catch((err) => failure(err));
    socket.on(SOCKET_EVENTS.TABLE_JOIN, (raw) => { void (async () => { await join(tablePayload.parse(raw).tableId); })().catch((err) => failure(err, undefined, raw)); });
    socket.on(SOCKET_EVENTS.TABLE_LEAVE, (raw) => { void (async () => { await socket.leave(roomFor(tablePayload.parse(raw).tableId)); })().catch((err) => failure(err, undefined, raw)); });
    socket.on(SOCKET_EVENTS.REHYDRATE, (raw) => { void (async () => {
      const p = z.object({ tableId: id.optional() }).parse(raw);
      const target = p.tableId ?? await getActiveTableForUser(userId); if (target) await join(target);
    })().catch((err) => failure(err, undefined, raw)); });
    socket.on(SOCKET_EVENTS.SEAT_CLAIM, (raw) => { void (async () => {
      const p = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000) }).parse(raw);
      await checkTable(p.tableId);
      await tableManager.seatClaim(p.tableId, userId, p.seatIndex, p.buyIn);
      await tableManager.tryStart(p.tableId);
    })().catch((err) => failure(err, undefined, raw)); });
    socket.on(SOCKET_EVENTS.STAND_UP, (raw, ack) => { void (async () => {
      const p = tablePayload.parse(raw); await checkTable(p.tableId);
      const pendingLeave = await tableManager.standUp(p.tableId, userId);
      if (typeof ack === "function") ack({ ok: true, pendingLeave });
    })().catch((err) => failure(err, ack, raw)); });
    socket.on(SOCKET_EVENTS.TABLE_KEEP_ALIVE, (raw, ack) => { void (async () => {
      const p = tablePayload.parse(raw); await checkTable(p.tableId);
      await tableManager.keepAlive(p.tableId, userId);
      if (typeof ack === "function") ack({ ok: true });
    })().catch((err) => failure(err, ack, raw)); });
    for (const event of [SOCKET_EVENTS.SIT_OUT, SOCKET_EVENTS.SIT_IN] as const) {
      socket.on(event, (raw) => { void (async () => {
        const p = tablePayload.parse(raw); await checkTable(p.tableId);
        await tableManager.sitToggle(p.tableId, userId, event === SOCKET_EVENTS.SIT_OUT);
        if (event === SOCKET_EVENTS.SIT_IN) await tableManager.tryStart(p.tableId);
      })().catch((err) => failure(err, undefined, raw)); });
    }
    socket.on(SOCKET_EVENTS.ACTION_INTENT, (raw, ack) => { void (async () => {
      const p = actionPayload.parse(raw);
      await checkTable(p.tableId);
      await tableManager.intent(p.tableId, userId, { action: p.action, amount: p.amount }, p.revision);
      if (typeof ack === "function") ack({ ok: true });
    })().catch(async (err) => {
      failure(err, ack, raw);
      if (err instanceof EngineError && err.code === "STALE_ACTION") {
        const p = actionPayload.safeParse(raw);
        if (p.success) { const snap = await tableManager.snapshot(p.data.tableId, userId); if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap); }
      }
    }).catch((err) => failure(err, undefined, raw)); });
  });
  return io;
}
