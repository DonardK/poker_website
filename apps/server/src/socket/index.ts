import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  SOCKET_EVENTS,
  type ActionIntentPayload,
} from "@poker/shared";
import { EngineError } from "@poker/engine";
import { Server } from "socket.io";
import { env, redisEnabled } from "../config.js";
import { logger } from "../logger.js";
import { prisma } from "../db/prisma.js";
import { redisPub, redisSub } from "../redis/client.js";
import { getActiveTableForUser } from "../redis/table-state.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { tableManager } from "../game/manager.js";
import { allowAction } from "./rate-limit.js";
import { roomFor } from "./rooms.js";
import type { PokerServer } from "./types.js";

export type { PokerServer } from "./types.js";

export function createSocketServer(httpServer: HttpServer): PokerServer {
  const io: PokerServer = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  if (redisEnabled && redisPub && redisSub) {
    io.adapter(createAdapter(redisPub, redisSub));
    logger.info("Socket.io Redis adapter attached");
  }

  tableManager.attach(io);

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("Unauthorized"));
      return;
    }
    try {
      const claims = verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      if (!user || user.kind === "BOT") {
        next(new Error("Unauthorized"));
        return;
      }
      socket.data.userId = user.id;
      socket.data.username = user.username;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const { userId, username } = socket.data;
    logger.info({ userId, socketId: socket.id }, "socket connected");
    tableManager.trackSocket(userId, socket.id);

    const activeTableId = await getActiveTableForUser(userId);
    socket.emit(SOCKET_EVENTS.AUTH_OK, { userId, username, activeTableId });

    if (activeTableId) {
      await socket.join(roomFor(activeTableId));
      const snap = await tableManager.snapshot(activeTableId, userId);
      if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap);
    }

    socket.on(SOCKET_EVENTS.TABLE_JOIN, async ({ tableId }) => {
      try {
        const table = await prisma.table.findUnique({ where: { id: tableId } });
        if (!table || table.status === "CLOSED") {
          socket.emit(SOCKET_EVENTS.SERVER_ERROR, { code: "TABLE_NOT_FOUND", message: "Table not found" });
          return;
        }
        await socket.join(roomFor(tableId));
        const snap = await tableManager.snapshot(tableId, userId);
        if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap);
        await tableManager.tryStart(tableId);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.TABLE_LEAVE, async ({ tableId }) => {
      await socket.leave(roomFor(tableId));
    });

    socket.on(SOCKET_EVENTS.SEAT_CLAIM, async (payload) => {
      try {
        await tableManager.seatClaim(payload.tableId, userId, payload.seatIndex, payload.buyIn);
        await tableManager.tryStart(payload.tableId);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.SIT_OUT, async ({ tableId }) => {
      try {
        await tableManager.sitToggle(tableId, userId, true);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.SIT_IN, async ({ tableId }) => {
      try {
        await tableManager.sitToggle(tableId, userId, false);
        await tableManager.tryStart(tableId);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.STAND_UP, async ({ tableId }) => {
      try {
        await tableManager.standUp(tableId, userId);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.REHYDRATE, async ({ tableId }) => {
      try {
        const target = tableId ?? (await getActiveTableForUser(userId));
        if (!target) return;
        await socket.join(roomFor(target));
        const snap = await tableManager.snapshot(target, userId);
        if (snap) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, snap);
        await tableManager.tryStart(target);
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on(SOCKET_EVENTS.ACTION_INTENT, async (payload: ActionIntentPayload) => {
      if (!allowAction(userId)) {
        socket.emit(SOCKET_EVENTS.SERVER_ERROR, { code: "RATE_LIMITED", message: "Too many actions" });
        return;
      }
      try {
        await tableManager.intent(payload.tableId, userId, {
          action: payload.action,
          amount: payload.amount,
        });
      } catch (err) {
        emitEngineError(socket, err);
      }
    });

    socket.on("disconnect", (reason) => {
      logger.info({ userId, reason }, "socket disconnected");
      tableManager.onDisconnect(userId, socket.id);
    });
  });

  return io;
}

function emitEngineError(
  socket: { emit: (event: typeof SOCKET_EVENTS.SERVER_ERROR, payload: { code: string; message: string }) => void },
  err: unknown,
): void {
  const code = err instanceof EngineError ? err.code : "ERROR";
  const message = err instanceof Error ? err.message : "Unexpected error";
  logger.warn({ err, code }, "socket engine error");
  socket.emit(SOCKET_EVENTS.SERVER_ERROR, { code, message });
}
