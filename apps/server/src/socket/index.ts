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
import { authenticate } from "../auth/middleware.js";
import { tableManager } from "../game/manager.js";
import { engineTransportGuard, isSecureTransport, type WebServer } from "../transport.js";
import { roomFor } from "./rooms.js";
import type { PokerServer } from "./types.js";
export type { PokerServer } from "./types.js";

const id = z.string().min(1).max(128);
const tablePayload = z.object({ tableId: id }).strict();
const actionPayload = tablePayload.extend({ revision: z.number().int().nonnegative(), action: z.enum(["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"]), amount: z.number().int().positive().max(2_000_000_000).optional(), clientActionId: z.string().uuid() });

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
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || token.length > 4096) return next(new Error("Unauthorized"));
    try {
      const { claims, user } = await authenticate(token);
      socket.data = { userId: user.id, username: user.username, sessionId: claims.sid, token };
      next();
    } catch { next(new Error("Unauthorized")); }
  });
  io.on("connection", (socket) => {
    const { userId, username } = socket.data;
    void socket.join(`user:${userId}`);
    let windowStart = Date.now(); let count = 0;
    socket.use(async (packet, next) => {
      const reject = (code: string, message: string) => {
        socket.emit(SOCKET_EVENTS.SERVER_ERROR, { code, message });
        const ack = packet.at(-1);
        if (typeof ack === "function") ack({ ok: false, code, message });
      };
      if (Date.now() - windowStart >= 2_000) { windowStart = Date.now(); count = 0; }
      if (++count > 20 || !allowAction(userId)) { reject("RATE_LIMITED", "Too many requests"); return; }
      try { await authenticate(socket.data.token); next(); }
      catch { reject("UNAUTHORIZED", "Please sign in again"); socket.disconnect(true); }
    });
    const failure = (err: unknown, ack?: CommandAck) => {
      logger.warn({ err }, "socket request rejected");
      const error = { code: err instanceof EngineError ? err.code : "INVALID_REQUEST", message: err instanceof EngineError ? err.message : "Request could not be completed" };
      socket.emit(SOCKET_EVENTS.SERVER_ERROR, error);
      if (typeof ack === "function") ack({ ok: false, ...error });
    };
    const checkTable = async (tableId: string) => {
      const row = await prisma.table.findUnique({ where: { id: tableId }, select: { status: true, isPrivate: true, hostId: true } });
      if (!row || row.status === "CLOSED" || (row.isPrivate && row.hostId !== userId && !await prisma.tableSeat.findFirst({ where: { tableId, userId }, select: { id: true } }))) throw new EngineError("TABLE_NOT_FOUND", "Table not found");
    };
    const join = async (tableId: string) => {
      await checkTable(tableId);
      for (const room of socket.rooms) if (room.startsWith("table:") && room !== roomFor(tableId)) await socket.leave(room);
      await socket.join(roomFor(tableId));
      const snap = await tableManager.snapshot(tableId, userId);
      if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap);
      if (snap && (snap.phase === "WAITING" || snap.phase === "COMPLETE")) await tableManager.tryStart(tableId);
    };
    void getActiveTableForUser(userId).then(async (activeTableId) => {
      socket.emit(SOCKET_EVENTS.AUTH_OK, { userId, username, activeTableId });
    }).catch(failure);
    socket.on(SOCKET_EVENTS.TABLE_JOIN, (raw) => { void (async () => { await join(tablePayload.parse(raw).tableId); })().catch(failure); });
    socket.on(SOCKET_EVENTS.TABLE_LEAVE, (raw) => { void (async () => { await socket.leave(roomFor(tablePayload.parse(raw).tableId)); })().catch(failure); });
    socket.on(SOCKET_EVENTS.REHYDRATE, (raw) => { void (async () => {
      const p = z.object({ tableId: id.optional() }).parse(raw);
      const target = p.tableId ?? await getActiveTableForUser(userId); if (target) await join(target);
    })().catch(failure); });
    socket.on(SOCKET_EVENTS.SEAT_CLAIM, (raw) => { void (async () => {
      const p = tablePayload.extend({ seatIndex: z.number().int().min(0).max(8), buyIn: z.number().int().positive().max(40_000_000) }).parse(raw);
      await checkTable(p.tableId);
      await tableManager.seatClaim(p.tableId, userId, p.seatIndex, p.buyIn);
      await tableManager.tryStart(p.tableId);
    })().catch(failure); });
    socket.on(SOCKET_EVENTS.STAND_UP, (raw, ack) => { void (async () => {
      const p = tablePayload.parse(raw); await checkTable(p.tableId);
      const pendingLeave = await tableManager.standUp(p.tableId, userId);
      if (typeof ack === "function") ack({ ok: true, pendingLeave });
    })().catch((err) => failure(err, ack)); });
    for (const event of [SOCKET_EVENTS.SIT_OUT, SOCKET_EVENTS.SIT_IN] as const) {
      socket.on(event, (raw) => { void (async () => {
        const p = tablePayload.parse(raw); await checkTable(p.tableId);
        await tableManager.sitToggle(p.tableId, userId, event === SOCKET_EVENTS.SIT_OUT);
        if (event === SOCKET_EVENTS.SIT_IN) await tableManager.tryStart(p.tableId);
      })().catch(failure); });
    }
    socket.on(SOCKET_EVENTS.ACTION_INTENT, (raw, ack) => { void (async () => {
      const p = actionPayload.parse(raw);
      await checkTable(p.tableId);
      await tableManager.intent(p.tableId, userId, { action: p.action, amount: p.amount }, p.revision);
      if (typeof ack === "function") ack({ ok: true });
    })().catch(async (err) => {
      failure(err, ack);
      if (err instanceof EngineError && err.code === "STALE_ACTION") {
        const p = actionPayload.safeParse(raw);
        if (p.success) { const snap = await tableManager.snapshot(p.data.tableId, userId); if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap); }
      }
    }).catch(failure); });
  });
  return io;
}
