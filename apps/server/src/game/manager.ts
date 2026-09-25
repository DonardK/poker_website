import { authenticate } from "../auth/middleware.js";
import {
  applyAction, applyTimeout, completeHand, createTable, decideBotAction, EngineError,
  leaveSeat, sitDown, sitIn, sitOut, startHand,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
import { SOCKET_EVENTS, type PublicTableState } from "@poker/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import { guardedTableState } from "../socket/mask.js";
import type { PokerServer } from "../socket/types.js";
import { roomFor } from "../socket/rooms.js";
import { handAuditColumns, handContext } from "./audit.js";
import { decryptState, encryptState } from "./encryption.js";

const HAND_BREAK_MS = 3_200;
type Tx = Prisma.TransactionClient;

export class TableManager {
  io: PokerServer | null = null;
  private armedRevision = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();

  attach(io: PokerServer): void { this.io = io; }
  trackSocket(_userId: string, _socketId: string): void { /* rooms track presence */ }
  onDisconnect(_userId: string, _socketId: string): void {
    // A disconnect never changes hand eligibility. The original turn deadline
    // checks/folds the player, including all-in players who have no turn.
  }
  stop(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  private async load(tx: Tx, tableId: string): Promise<EngineTable | null> {
    const row = await tx.table.findUnique({ where: { id: tableId }, include: { seats: { include: { user: true }, orderBy: { seatIndex: "asc" } } } });
    if (!row || row.status === "CLOSED") return null;
    if (row.stateCiphertext) {
      const state = decryptState<EngineTable & { pendingShuffle?: unknown }>(row.stateCiphertext, `table:${tableId}`);
      // Pre-upgrade state may carry the removed player-entropy shuffle round; it is never used again.
      delete state.pendingShuffle;
      return state;
    }
    // Only brand-new tables may be hydrated from seats. Never redeal a lost hand.
    const lastHand = await tx.hand.findFirst({ where: { tableId }, orderBy: { handNumber: "desc" } });
    if (row.status === "IN_HAND" || lastHand) throw new EngineError("RECOVERY_REQUIRED", "Saved game state is missing; table paused for recovery");
    let table = createTable({ tableId: row.id, name: row.name, maxSeats: row.maxSeats, smallBlind: row.smallBlind, bigBlind: row.bigBlind, timeBankMs: row.timeBankMs });
    for (const seat of row.seats) {
      if (!seat.user || seat.status === "EMPTY" || seat.stack <= 0) continue;
      table = sitDown(table, seat.seatIndex, { userId: seat.user.id, username: seat.user.username, avatarHue: seat.user.avatarHue, kind: seat.playerKind, botProfile: seat.botProfile, buyIn: seat.stack, skipBuyInCheck: true });
      if (seat.sittingOut) table = sitOut(table, seat.user.id);
    }
    return table;
  }

  async get(tableId: string): Promise<EngineTable | null> { return this.load(prisma, tableId); }
  /** Guarded snapshot for one viewer; null means nothing may be emitted. */
  async snapshot(tableId: string, viewerUserId: string | null): Promise<PublicTableState | null> {
    const table = await this.get(tableId);
    if (!table) return null;
    this.armTimers(table);
    return this.project(table, viewerUserId);
  }
  async hydrateFromDb(tableId: string): Promise<EngineTable | null> { return this.get(tableId); }

  async recover(): Promise<void> {
    const rows = await prisma.table.findMany({ where: { status: { in: ["WAITING", "IN_HAND"] } }, select: { id: true } });
    for (const row of rows) {
      try { const table = await this.get(row.id); if (table) this.armTimers(table); }
      catch (err) { logger.error({ err, tableId: row.id }, "table recovery failed; refusing to redeal"); }
    }
  }

  async mutate(tableId: string, fn: (table: EngineTable, tx: Tx) => EngineTable | Promise<EngineTable>, expectedRevision?: number): Promise<EngineTable> {
    const next = await prisma.$transaction(async (tx) => {
      // Row lock survives slow requests and is released only at commit/rollback.
      await tx.$queryRaw`SELECT id FROM public."Table" WHERE id = ${tableId} FOR UPDATE`;
      const current = await this.load(tx, tableId);
      if (!current) throw new EngineError("TABLE_NOT_FOUND", "Table not found");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
      const result = await fn(current, tx);
      if (result === current) return current;
      result.revision = current.revision + 1;
      // Wallet, seats, encrypted state and history either all commit or none do.
      for (const cash of result.cashOuts) {
        await tx.user.updateMany({ where: { id: cash.userId, kind: "HUMAN" }, data: { bankroll: { increment: cash.stack } } });
      }
      result.cashOuts = [];
      await this.persistSeats(tx, result);
      // A hand is recorded once, when it settles. The SHOWDOWN timer cleans up one
      // hand and deals the next in a single step, and that hand can settle at once
      // (all-in on the blinds), so compare hand numbers as well as phases.
      if (result.phase === "SHOWDOWN" && (current.phase !== "SHOWDOWN" || current.handNumber !== result.handNumber)) await this.persistHand(tx, result);
      await tx.table.update({ where: { id: tableId }, data: { status: result.status, stateCiphertext: encryptState(result, `table:${tableId}`) } });
      return result;
    }, { maxWait: 10_000, timeout: 20_000 });
    this.armTimers(next);
    // Network delivery is after commit and cannot roll back a successful payment.
    try { await this.broadcast(next); } catch (err) { logger.warn({ err }, "broadcast failed; reconnect restores committed state"); }
    return next;
  }

  async tryStart(tableId: string): Promise<void> {
    await this.mutate(tableId, (table) => {
      if (table.phase !== "WAITING" && table.phase !== "COMPLETE") return table;
      if (!readyToDeal(table)) return table;
      // Shuffle (OS CSPRNG), commit and open the audit, then post blinds and deal.
      return startHand(table);
    });
  }
  async intent(tableId: string, userId: string, intent: EngineIntent, revision: number): Promise<void> {
    await this.mutate(tableId, (table) => {
      if (table.turnStartedAt != null && Date.now() >= table.turnStartedAt + table.timeBankMs) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
      return applyAction(table, userId, intent);
    }, revision);
  }
  async seatClaim(tableId: string, userId: string, seatIndex: number, buyIn: number): Promise<void> {
    await this.mutate(tableId, async (table, tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.kind !== "HUMAN") throw new EngineError("UNAUTHORIZED", "User missing");
      const next = sitDown(table, seatIndex, { userId, username: user.username, avatarHue: user.avatarHue, kind: "HUMAN", botProfile: null, buyIn });
      const paid = await tx.user.updateMany({ where: { id: userId, bankroll: { gte: buyIn } }, data: { bankroll: { decrement: buyIn } } });
      if (!paid.count) throw new EngineError("BANKROLL", "Not enough bankroll");
      const occupied = await tx.tableSeat.findFirst({ where: { userId } });
      if (occupied) throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
      return next;
    });
    await this.patchBankroll(userId);
  }
  async sitToggle(tableId: string, userId: string, out: boolean): Promise<void> {
    await this.mutate(tableId, (table) => out ? sitOut(table, userId) : sitIn(table, userId));
  }
  async standUp(tableId: string, userId: string): Promise<void> {
    await this.mutate(tableId, (table) => leaveSeat(table, userId));
    await this.patchBankroll(userId);
  }
  private async patchBankroll(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { bankroll: true } });
    if (user) this.io?.to(`user:${userId}`).emit(SOCKET_EVENTS.USER_PATCH, user);
  }
  /**
   * COMPLIANCE (state isolation): each socket receives its own projection for
   * its authenticated user only, through the engine leak guard. A refused
   * projection is logged as a security event and nothing is sent (fail closed).
   */
  private project(table: EngineTable, viewerUserId: string | null): PublicTableState | null {
    return guardedTableState(table, viewerUserId, (event) => {
      logger.error({ security: "LEAK_BLOCKED", ...event }, "SECURITY EVENT: leak guard refused a table-state emission; nothing was sent to this viewer");
    });
  }
  private async broadcast(table: EngineTable): Promise<void> {
    if (!this.io) return;
    for (const socket of await this.io.in(roomFor(table.tableId)).fetchSockets()) {
      try { await authenticate(socket.data.token); } catch { socket.disconnect(true); continue; }
      try {
        const state = this.project(table, socket.data.userId);
        if (state) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, state);
      } catch (err) {
        logger.error({ err, tableId: table.tableId, revision: table.revision, viewerUserId: socket.data.userId }, "table state projection failed; nothing was sent to this viewer");
      }
      await this.patchBankroll(socket.data.userId);
    }
  }
  private armTimers(table: EngineTable): void {
    const armed = this.armedRevision.get(table.tableId);
    if (armed !== undefined && (armed > table.revision || (armed === table.revision && this.timers.has(table.tableId)))) return;
    this.armedRevision.set(table.tableId, table.revision);
    const old = this.timers.get(table.tableId);
    if (old) clearTimeout(old);
    this.timers.delete(table.tableId);
    let delay: number;
    let run: () => Promise<unknown>;
    if (table.phase === "SHOWDOWN") {
      delay = Math.max(0, (table.settledAt ?? Date.now()) + HAND_BREAK_MS - Date.now());
      run = () => this.mutate(table.tableId, (current) => {
        // Hand Clean-up purges the settled hand's secrets before the next shuffle.
        let next = completeHand(current);
        if (readyToDeal(next)) next = startHand(next);
        return next;
      }, table.revision);
    } else if (table.phase === "WAITING" || table.phase === "COMPLETE") {
      if (!readyToDeal(table)) return;
      delay = 100;
      run = () => this.tryStart(table.tableId);
    } else {
      if (table.toActSeat == null) return;
      const actor = table.players[table.toActSeat]!;
      const remaining = Math.max(0, (table.turnStartedAt ?? Date.now()) + table.timeBankMs - Date.now());
      if (actor.kind === "BOT" && remaining > 0) {
        const decision = decideBotAction(table);
        delay = Math.max(0, Math.min(remaining, table.turnStartedAt! + decision.delayMs - Date.now()));
        run = () => this.mutate(table.tableId, (current) => Date.now() >= current.turnStartedAt! + current.timeBankMs ? applyTimeout(current) : applyAction(current, actor.userId, decision.intent), table.revision);
      } else {
        delay = remaining;
        run = () => this.mutate(table.tableId, (current) => applyTimeout(current), table.revision);
      }
    }
    const timer = setTimeout(() => { this.timers.delete(table.tableId); void run().catch(async (err) => {
      if (!(err instanceof EngineError && err.code === "STALE_ACTION")) logger.error({ err, tableId: table.tableId }, "table timer failed");
      const retry = setTimeout(() => { this.timers.delete(table.tableId); void this.get(table.tableId).then((fresh) => { if (fresh) this.armTimers(fresh); }).catch((e) => logger.error(e, "recovery retry failed")); }, 1_000);
      retry.unref(); this.timers.set(table.tableId, retry);
    }); }, delay);
    timer.unref(); this.timers.set(table.tableId, timer);
  }
  private async persistSeats(tx: Tx, table: EngineTable): Promise<void> {
    for (let seatIndex = 0; seatIndex < table.maxSeats; seatIndex++) {
      const p = table.players[seatIndex];
      await tx.tableSeat.update({ where: { tableId_seatIndex: { tableId: table.tableId, seatIndex } }, data: p ? {
        userId: p.userId, status: p.sittingOut ? "SIT_OUT" : "OCCUPIED", playerKind: p.kind, botProfile: p.botProfile, stack: p.stack, sittingOut: p.sittingOut,
      } : { userId: null, status: "EMPTY", playerKind: "HUMAN", botProfile: null, stack: 0, sittingOut: false } });
    }
  }
  /**
   * COMPLIANCE (audit trail): the hand, its players, pots, actions and its
   * verified audit columns are written in the same transaction as the settled
   * table state, so a hand is never recorded without its audit (or the
   * reverse). Hand rows are append-only to the runtime database role.
   */
  private async persistHand(tx: Tx, table: EngineTable): Promise<void> {
    const dealt = table.players.filter((p) => p?.holeCards);
    const context = handContext(table.tableId, table.handNumber);
    // Throws AUDIT_INVALID (rolling everything back) if the sealed record does not verify.
    const audit = await handAuditColumns(table);
    if (!audit) {
      const detail = { tableId: table.tableId, handNumber: table.handNumber, hasAudit: Boolean(table.audit), hasFairness: Boolean(table.fairness) };
      if (table.audit) logger.error(detail, "hand has an audit record but no deck commitment; persisting without audit columns");
      else logger.warn(detail, "legacy in-flight hand predates the compliance audit trail; persisting without audit columns");
    }
    await tx.hand.create({ data: {
      tableId: table.tableId, handNumber: table.handNumber, phase: "COMPLETE", dealerSeat: table.dealerSeat, sbSeat: table.sbSeat, bbSeat: table.bbSeat,
      board: table.board, potTotal: table.potTotal, startedAt: new Date(table.startedAt!), endedAt: new Date(table.settledAt!),
      ...(audit ? {
        fairnessRoot: audit.auditRecord.merkleRoot,
        handUuid: audit.handUuid, deckCommitment: audit.deckCommitment, finalStateHash: audit.finalStateHash,
        auditRecord: audit.auditRecord as unknown as Prisma.InputJsonValue, auditSealed: audit.auditSealed,
      } : {
        // Legacy hand: keep its pre-upgrade commitment evidence exactly as before.
        fairnessRoot: table.fairness?.root ?? null, fairnessAudit: table.fairness ? encryptState(table.fairness, context) : null,
      }),
      snapshot: JSON.parse(JSON.stringify({ winners: table.winners, refunds: table.refunds, log: table.log })) as Prisma.InputJsonValue,
      players: { create: dealt.map((p) => {
        const win = table.winners.find((w) => w.seatIndex === p!.seatIndex)?.amount ?? 0;
        const refund = table.refunds.find((r) => r.seatIndex === p!.seatIndex)?.amount ?? 0;
        return { userId: p!.userId, seatIndex: p!.seatIndex, playerKind: p!.kind, botProfile: p!.botProfile,
          holeCards: [], encryptedHoleCards: encryptState(p!.holeCards, `${context}:seat:${p!.seatIndex}`),
          startingStack: p!.stack - win - refund + p!.committedThisHand, endingStack: p!.stack, net: win + refund - p!.committedThisHand,
          showedCards: p!.showedCards, won: win > 0, handRankName: p!.handResult?.name, handRankValue: p!.handResult ? BigInt(p!.handResult.rankValue) : null };
      }) },
      pots: { create: table.awards.map((p) => ({ potIndex: p.potIndex, amount: p.amount, eligibleSeats: [...p.eligibleSeatIndexes], winnerSeats: [...p.winnerSeatIndexes], oddChipSeat: p.oddChipSeatIndex })) },
      actions: { create: table.actions.map((a) => ({ seq: a.seq, seatIndex: a.seatIndex, street: a.street, action: a.action, amount: a.amount, toAmount: a.toAmount, createdAt: new Date(a.at) })) },
    } });
    for (const p of dealt) {
      if (p?.kind !== "BOT") continue;
      const won = table.winners.find((w) => w.seatIndex === p.seatIndex)?.amount ?? 0;
      const refund = table.refunds.find((r) => r.seatIndex === p.seatIndex)?.amount ?? 0;
      await tx.botStatistic.updateMany({ where: { userId: p.userId }, data: { handsPlayed: { increment: 1 }, chipsWon: { increment: won + refund - p.committedThisHand }, showdowns: { increment: p.showedCards ? 1 : 0 }, showdownsWon: { increment: won > 0 && p.showedCards ? 1 : 0 } } });
    }
  }
}
export const tableManager = new TableManager();

function readyToDeal(table: EngineTable): boolean {
  const live = table.players.filter((p) => p && !p.sittingOut && p.stack > 0);
  return live.length >= 2 && live.some((p) => p!.kind === "HUMAN");
}
