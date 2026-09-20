import {
  applyAction,
  applyTimeout,
  completeHand,
  createTable,
  decideBotAction,
  EngineError,
  leaveSeat,
  sitDown,
  sitIn,
  sitOut,
  startHand,
  toPublicTableState,
  type EngineIntent,
  type EngineTable,
} from "@poker/engine";
import { SOCKET_EVENTS, TABLE_LOCK_TTL_MS } from "@poker/shared";
import type { PokerAction, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import { kv, redisKeys, withLock, LockBusyError } from "../redis/client.js";
import { setActiveTableForUser } from "../redis/table-state.js";
import type { PokerServer } from "../socket/types.js";
import { roomFor } from "../socket/rooms.js";

const HAND_BREAK_MS = 3_200;
const DISCONNECT_GRACE_MS = 8_000;

export class TableManager {
  io: PokerServer | null = null;
  private memory = new Map<string, EngineTable>();
  private timers = new Map<string, NodeJS.Timeout>();
  private sockets = new Map<string, Set<string>>();
  private dcTimers = new Map<string, NodeJS.Timeout>();
  private showdownQueued = new Map<string, number>();

  attach(io: PokerServer): void {
    this.io = io;
  }

  trackSocket(userId: string, socketId: string): void {
    const set = this.sockets.get(userId) ?? new Set();
    set.add(socketId);
    this.sockets.set(userId, set);
    const pending = this.dcTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.dcTimers.delete(userId);
    }
  }

  untrackSocket(userId: string, socketId: string): void {
    const set = this.sockets.get(userId);
    set?.delete(socketId);
    if (set && set.size === 0) this.sockets.delete(userId);
  }

  isConnected(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  async snapshot(tableId: string, viewerUserId: string | null) {
    const table = await this.get(tableId);
    if (!table) return null;
    return toPublicTableState(table, viewerUserId);
  }

  async get(tableId: string): Promise<EngineTable | null> {
    const hit = this.memory.get(tableId);
    if (hit) return hit;
    const raw = await kv.get(redisKeys.tableState(tableId));
    if (raw) {
      try {
        const table = JSON.parse(raw) as EngineTable;
        table.cashOuts ??= [];
        for (const player of table.players) {
          if (player) player.pendingLeave ??= false;
        }
        this.memory.set(tableId, table);
        this.resumeAfterLoad(table);
        return table;
      } catch (err) {
        logger.warn({ err, tableId }, "corrupt table state, hydrating from db");
        await kv.del(redisKeys.tableState(tableId));
      }
    }
    return this.hydrateFromDb(tableId);
  }

  async save(table: EngineTable): Promise<void> {
    this.memory.set(table.tableId, table);
    await kv.set(redisKeys.tableState(table.tableId), JSON.stringify(table));
  }

  async mutate(tableId: string, fn: (table: EngineTable) => EngineTable | Promise<EngineTable>): Promise<EngineTable> {
    return withLock(`table:${tableId}`, TABLE_LOCK_TTL_MS, async () => {
      const current = await this.get(tableId);
      if (!current) throw new EngineError("TABLE_NOT_FOUND", "Table not found");
      const next = await fn(current);
      await this.honorCashouts(next);
      next.cashOuts = [];
      await this.save(next);
      await this.broadcast(next);
      this.armTimers(next);
      const settled = next.phase === "SHOWDOWN" || next.phase === "WAITING" || next.phase === "COMPLETE";
      if (settled) {
        void this.persistSeats(next).catch((err) => logger.error(err, "seat persist failed"));
      }
      if (next.phase === "SHOWDOWN") {
        const queuedFor = this.showdownQueued.get(next.tableId);
        if (queuedFor !== next.handNumber) {
          this.showdownQueued.set(next.tableId, next.handNumber);
          void this.persistHand(next).catch((err) => logger.error(err, "hand persist failed"));
          this.queueNextHand(next.tableId);
        }
      }
      return next;
    });
  }

  async hydrateFromDb(tableId: string): Promise<EngineTable | null> {
    const row = await prisma.table.findUnique({
      where: { id: tableId },
      include: { seats: { include: { user: true }, orderBy: { seatIndex: "asc" } } },
    });
    if (!row || row.status === "CLOSED") return null;
    let table = createTable({
      tableId: row.id,
      name: row.name,
      maxSeats: row.maxSeats,
      smallBlind: row.smallBlind,
      bigBlind: row.bigBlind,
      timeBankMs: row.timeBankMs,
    });
    for (const seat of row.seats) {
      if (!seat.user || seat.status === "EMPTY" || seat.stack <= 0) continue;
      table = sitDown(table, seat.seatIndex, {
        userId: seat.user.id,
        username: seat.user.username,
        avatarHue: seat.user.avatarHue,
        kind: seat.playerKind,
        botProfile: seat.botProfile,
        buyIn: seat.stack,
        skipBuyInCheck: true,
      });
      if (seat.sittingOut || seat.status === "SIT_OUT") {
        table = sitOut(table, seat.user.id);
      }
    }
    await this.save(table);
    this.resumeAfterLoad(table);
    return table;
  }

  async tryStart(tableId: string): Promise<void> {
    try {
      await this.mutate(tableId, (table) => {
        if (table.phase !== "WAITING" && table.phase !== "COMPLETE") return table;
        const live = table.players.filter((p) => p && !p.sittingOut && p.stack > 0).length;
        if (live < 2) return table;
        return startHand(table);
      });
    } catch (err) {
      if (err instanceof LockBusyError) return;
      throw err;
    }
  }

  async intent(tableId: string, userId: string, intent: EngineIntent): Promise<void> {
    await this.mutate(tableId, (table) => applyAction(table, userId, intent));
  }

  async timeout(tableId: string): Promise<void> {
    await this.mutate(tableId, (table) => applyTimeout(table));
  }

  async seatClaim(tableId: string, userId: string, seatIndex: number, buyIn: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new EngineError("UNAUTHORIZED", "User missing");
    if (user.bankroll < buyIn) throw new EngineError("BANKROLL", "Not enough bankroll");
    await this.mutate(tableId, (table) =>
      sitDown(table, seatIndex, {
        userId: user.id,
        username: user.username,
        avatarHue: user.avatarHue,
        kind: "HUMAN",
        botProfile: null,
        buyIn,
      }),
    );
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { bankroll: { decrement: buyIn } },
    });
    this.emitToUser(userId, SOCKET_EVENTS.USER_PATCH, { bankroll: updated.bankroll });
    await prisma.tableSeat.update({
      where: { tableId_seatIndex: { tableId, seatIndex } },
      data: { userId, status: "OCCUPIED", playerKind: "HUMAN", stack: buyIn },
    });
    await setActiveTableForUser(userId, tableId);
  }

  onDisconnect(userId: string, socketId: string): void {
    this.untrackSocket(userId, socketId);
    if (this.isConnected(userId)) return;
    const t = setTimeout(() => {
      this.dcTimers.delete(userId);
      void this.sitOutEverywhere(userId);
    }, DISCONNECT_GRACE_MS);
    this.dcTimers.set(userId, t);
  }

  private async sitOutEverywhere(userId: string): Promise<void> {
    for (const table of this.memory.values()) {
      if (!table.players.some((p) => p?.userId === userId)) continue;
      try {
        await this.mutate(table.tableId, (t) => sitOut(t, userId));
      } catch (err) {
        logger.debug({ err }, "sitOut skipped");
      }
    }
  }

  async sitToggle(tableId: string, userId: string, out: boolean): Promise<void> {
    await this.mutate(tableId, (table) => (out ? sitOut(table, userId) : sitIn(table, userId)));
  }

  async standUp(tableId: string, userId: string): Promise<void> {
    await this.mutate(tableId, (table) => leaveSeat(table, userId));
  }

  private async broadcast(table: EngineTable): Promise<void> {
    if (!this.io) return;
    const room = roomFor(table.tableId);
    const sockets = await this.io.in(room).fetchSockets();
    for (const socket of sockets) {
      const view = toPublicTableState(table, socket.data.userId);
      socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, view);
    }
    const last = table.log.at(-1);
    if (last) this.io.to(room).emit(SOCKET_EVENTS.HAND_HISTORY_LOG, last);
  }

  private clearTimer(tableId: string): void {
    const t = this.timers.get(tableId);
    if (t) clearTimeout(t);
    this.timers.delete(tableId);
  }

  private resumeAfterLoad(table: EngineTable): void {
    if (table.phase === "SHOWDOWN") {
      const queuedFor = this.showdownQueued.get(table.tableId);
      if (queuedFor !== table.handNumber) {
        this.showdownQueued.set(table.tableId, table.handNumber);
        this.queueNextHand(table.tableId);
      }
      return;
    }
    this.armTimers(table);
  }

  private armTimers(table: EngineTable): void {
    if (table.phase === "SHOWDOWN") return;
    this.clearTimer(table.tableId);
    if (table.phase === "WAITING" || table.phase === "COMPLETE" || table.toActSeat == null) return;
    const actor = table.players[table.toActSeat];
    if (!actor) return;
    if (actor.kind === "BOT") {
      const { intent, delayMs } = decideBotAction(table);
      const handle = setTimeout(() => {
        void this.intent(table.tableId, actor.userId, intent).catch((err) =>
          logger.warn({ err }, "bot action failed"),
        );
      }, delayMs);
      this.timers.set(table.tableId, handle);
      return;
    }
    const handle = setTimeout(() => {
      void this.timeout(table.tableId).catch((err) => logger.warn({ err }, "timeout failed"));
    }, table.timeBankMs);
    this.timers.set(table.tableId, handle);
  }

  private queueNextHand(tableId: string): void {
    this.clearTimer(tableId);
    const handle = setTimeout(() => {
      void this.mutate(tableId, (table) => {
        let next = completeHand(table);
        const live = next.players.filter((p) => p && !p.sittingOut && p.stack > 0).length;
        if (live >= 2) next = startHand(next);
        return next;
      }).catch((err) => logger.warn({ err }, "next hand failed"));
    }, HAND_BREAK_MS);
    this.timers.set(tableId, handle);
  }

  private async honorCashouts(table: EngineTable): Promise<void> {
    for (const cash of table.cashOuts) {
      const user = await prisma.user.findUnique({ where: { id: cash.userId } });
      if (user?.kind === "HUMAN") {
        const updated = await prisma.user.update({
          where: { id: cash.userId },
          data: { bankroll: { increment: cash.stack } },
        });
        this.emitToUser(cash.userId, SOCKET_EVENTS.USER_PATCH, { bankroll: updated.bankroll });
      }
      await prisma.tableSeat.updateMany({
        where: { tableId: table.tableId, userId: cash.userId },
        data: {
          userId: null,
          status: "EMPTY",
          playerKind: "HUMAN",
          botProfile: null,
          stack: 0,
          sittingOut: false,
        },
      });
      await setActiveTableForUser(cash.userId, null);
    }
  }

  private emitToUser(userId: string, event: typeof SOCKET_EVENTS.USER_PATCH, payload: { bankroll: number }): void {
    if (!this.io) return;
    const ids = this.sockets.get(userId);
    if (!ids) return;
    for (const socketId of ids) this.io.to(socketId).emit(event, payload);
  }

  private async persistSeats(table: EngineTable): Promise<void> {
    const seats = table.players.map((player, seatIndex) => {
      if (!player) {
        return prisma.tableSeat.update({
          where: { tableId_seatIndex: { tableId: table.tableId, seatIndex } },
          data: {
            userId: null,
            status: "EMPTY",
            playerKind: "HUMAN",
            botProfile: null,
            stack: 0,
            sittingOut: false,
          },
        });
      }
      return prisma.tableSeat.update({
        where: { tableId_seatIndex: { tableId: table.tableId, seatIndex } },
        data: {
          userId: player.userId,
          status: player.sittingOut || player.status === "SIT_OUT" ? "SIT_OUT" : "OCCUPIED",
          playerKind: player.kind,
          botProfile: player.botProfile,
          stack: player.stack,
          sittingOut: player.sittingOut,
        },
      });
    });
    await prisma.$transaction([
      ...seats,
      prisma.table.update({
        where: { id: table.tableId },
        data: { status: table.status },
      }),
    ]);
  }

  private async persistHand(table: EngineTable): Promise<void> {
    const exists = await prisma.hand.findUnique({
      where: { tableId_handNumber: { tableId: table.tableId, handNumber: table.handNumber } },
    });
    if (exists) return;
    const dealt = table.players.filter((p) => p && p.committedThisHand > 0);
    const potTotal = table.potTotal;
    await prisma.hand.create({
      data: {
        tableId: table.tableId,
        handNumber: table.handNumber,
        phase: "COMPLETE",
        dealerSeat: table.dealerSeat,
        sbSeat: table.sbSeat,
        bbSeat: table.bbSeat,
        board: table.board,
        potTotal,
        endedAt: new Date(),
        snapshot: JSON.parse(
          JSON.stringify({ winners: table.winners, log: table.log.slice(-80) }),
        ) as Prisma.InputJsonValue,
        players: {
          create: dealt.map((p) => {
            const win = table.winners.find((w) => w.seatIndex === p!.seatIndex);
            return {
              userId: p!.userId,
              seatIndex: p!.seatIndex,
              playerKind: p!.kind,
              botProfile: p!.botProfile,
              holeCards: p!.holeCards ? [...p!.holeCards] : [],
              startingStack: p!.stack - (win?.amount ?? 0) + p!.committedThisHand,
              endingStack: p!.stack,
              net: (win?.amount ?? 0) - p!.committedThisHand,
              showedCards: p!.showedCards,
              won: Boolean(win),
              handRankName: p!.handResult?.name,
              handRankValue: p!.handResult ? BigInt(p!.handResult.rankValue) : null,
            };
          }),
        },
        pots: {
          create: table.pots.map((pot) => ({
            potIndex: pot.potIndex,
            amount: pot.amount,
            eligibleSeats: pot.eligibleSeatIndexes,
            winnerSeats: table.winners.filter((w) => pot.eligibleSeatIndexes.includes(w.seatIndex)).map((w) => w.seatIndex),
            oddChipSeat: null,
          })),
        },
        actions: {
          create: table.log.map((entry, seq) => ({
            seq,
            seatIndex: entry.seatIndex ?? -1,
            street: streetFromText(entry.text),
            action: actionFromText(entry.text),
            amount: amountFromText(entry.text),
          })),
        },
      },
    });

    for (const p of dealt) {
      if (!p || p.kind !== "BOT") continue;
      const win = table.winners.find((w) => w.seatIndex === p.seatIndex);
      await prisma.botStatistic.updateMany({
        where: { userId: p.userId },
        data: {
          handsPlayed: { increment: 1 },
          chipsWon: { increment: (win?.amount ?? 0) - p.committedThisHand },
          showdowns: { increment: p.showedCards ? 1 : 0 },
          showdownsWon: { increment: win && p.showedCards ? 1 : 0 },
        },
      });
    }
  }
}

function streetFromText(text: string): "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN" | "COMPLETE" | "WAITING" {
  if (text.startsWith("Flop")) return "FLOP";
  if (text.startsWith("Turn")) return "TURN";
  if (text.startsWith("River")) return "RIVER";
  if (text.includes("wins")) return "SHOWDOWN";
  return "PREFLOP";
}

function actionFromText(text: string): PokerAction {
  if (text.includes("folds")) return "FOLD";
  if (text.includes("checks")) return "CHECK";
  if (text.includes("calls")) return "CALL";
  if (text.includes("bets")) return "BET";
  if (text.includes("raises")) return "RAISE";
  if (text.includes("all-in")) return "ALL_IN";
  if (text.includes("small blind")) return "POST_SB";
  if (text.includes("big blind")) return "POST_BB";
  return "CHECK";
}

function amountFromText(text: string): number {
  const m = /\$(\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

export const tableManager = new TableManager();
