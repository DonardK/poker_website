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
import { upgradeStoredTableState } from "./legacy.js";

const HAND_BREAK_MS = 3_200;
type Tx = Prisma.TransactionClient;
/** A loaded table; `upgraded`: the legacy-state upgrade changed it, so the stored copy is out of date. */
interface Loaded { table: EngineTable; upgraded: boolean }

export class TableManager {
  io: PokerServer | null = null;
  private armedRevision = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  attach(io: PokerServer): void { this.io = io; this.stopped = false; }
  trackSocket(_userId: string, _socketId: string): void { /* rooms track presence */ }
  onDisconnect(_userId: string, _socketId: string): void {
    // A disconnect never changes hand eligibility. The original turn deadline
    // checks/folds the player, including all-in players who have no turn.
  }
  stop(): void { this.stopped = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  /**
   * COMPLIANCE NOTE (legacy state): every stored state is upgraded on load
   * (see legacy.ts); a legacy in-flight hand is voided with all bets returned.
   * Loading never writes and never pays. Read-only callers (snapshots, timers)
   * see the upgraded state; `mutate` persists it and pays its cash-outs.
   */
  private async load(tx: Tx, tableId: string): Promise<Loaded | null> {
    const row = await tx.table.findUnique({ where: { id: tableId } });
    if (!row || row.status === "CLOSED") return null;
    if (row.stateCiphertext) {
      return upgradeStoredTableState(tableId, decryptState<EngineTable>(row.stateCiphertext, `table:${tableId}`), (voided) => {
        logger.warn({ audit: "LEGACY_HAND_VOIDED", ...voided }, "legacy in-flight hand voided during upgrade; all bets returned");
      });
    }
    // Only brand-new tables may be hydrated from seats. Never redeal a lost hand.
    const lastHand = await tx.hand.findFirst({ where: { tableId }, orderBy: { handNumber: "desc" } });
    if (row.status === "IN_HAND" || lastHand) throw new EngineError("RECOVERY_REQUIRED", "Saved game state is missing; table paused for recovery");
    let table = createTable({ tableId: row.id, name: row.name, maxSeats: row.maxSeats, smallBlind: row.smallBlind, bigBlind: row.bigBlind, timeBankMs: row.timeBankMs });
    const seats = await tx.tableSeat.findMany({ where: { tableId }, include: { user: true }, orderBy: { seatIndex: "asc" } });
    for (const seat of seats) {
      if (!seat.user || seat.status === "EMPTY" || seat.stack <= 0) continue;
      table = sitDown(table, seat.seatIndex, { userId: seat.user.id, username: seat.user.username, avatarHue: seat.user.avatarHue, kind: seat.playerKind, botProfile: seat.botProfile, buyIn: seat.stack, skipBuyInCheck: true });
      if (seat.sittingOut) table = sitOut(table, seat.user.id);
    }
    return { table, upgraded: false };
  }

  async get(tableId: string): Promise<EngineTable | null> { return (await this.load(prisma, tableId))?.table ?? null; }
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
      try {
        const loaded = await this.load(prisma, row.id);
        if (!loaded) continue;
        // Persist a legacy-state upgrade now (a voided hand's seats, stacks and
        // cash-outs) instead of waiting for the table's next change. mutate arms the timers.
        if (loaded.upgraded) await this.mutate(row.id, (current) => current);
        else this.armTimers(loaded.table);
      } catch (err) { logger.error({ err, tableId: row.id }, "table recovery failed; refusing to redeal"); }
    }
  }

  async mutate(tableId: string, fn: (table: EngineTable, tx: Tx) => EngineTable | Promise<EngineTable>, expectedRevision?: number): Promise<EngineTable> {
    const paidUsers = new Set<string>();
    let changed = false;
    const next = await prisma.$transaction(async (tx) => {
      // Row lock survives slow requests and is released only at commit/rollback.
      await tx.$queryRaw`SELECT id FROM public."Table" WHERE id = ${tableId} FOR UPDATE`;
      const loaded = await this.load(tx, tableId);
      if (!loaded) throw new EngineError("TABLE_NOT_FOUND", "Table not found");
      const current = loaded.table;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
      const result = await fn(current, tx);
      // An upgraded legacy state is written even when `fn` changes nothing.
      if (result === current && !loaded.upgraded) return current;
      changed = true;
      result.revision = current.revision + 1;
      // Wallet, seats, encrypted state and history either all commit or none do.
      // COMPLIANCE NOTE (cash-outs): this is the only place cash-outs are paid. They
      // are paid from the result state, which is then stored with none pending in
      // the same transaction, so no later load can pay them again.
      for (const cash of result.cashOuts) {
        await tx.user.updateMany({ where: { id: cash.userId, kind: "HUMAN" }, data: { bankroll: { increment: cash.stack } } });
        paidUsers.add(cash.userId);
      }
      result.cashOuts = [];
      await this.persistSeats(tx, result, loaded.upgraded ? undefined : current);
      // A hand is recorded once, when it settles. The SHOWDOWN timer cleans up one
      // hand and deals the next in a single step, and that hand can settle at once
      // (all-in on the blinds), so compare hand numbers as well as phases.
      if (result.phase === "SHOWDOWN" && (current.phase !== "SHOWDOWN" || current.handNumber !== result.handNumber)) await this.persistHand(tx, result);
      await tx.table.update({ where: { id: tableId }, data: { status: result.status, stateCiphertext: encryptState(result, `table:${tableId}`) } });
      return result;
    }, { maxWait: 10_000, timeout: 20_000 });
    this.armTimers(next);
    // Network delivery is after commit and cannot roll back a successful payment.
    const deliveries = await Promise.allSettled([
      ...(changed ? [this.broadcast(next)] : []),
      // Cash-outs must reach the wallet even after the player returns to the lobby.
      ...[...paidUsers].map((userId) => this.patchBankroll(userId, tableId)),
    ]);
    for (const delivery of deliveries) if (delivery.status === "rejected") logger.warn({ err: delivery.reason }, "broadcast failed; reconnect restores committed state");
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
  async standUp(tableId: string, userId: string): Promise<boolean> {
    const next = await this.mutate(tableId, (table) => table.players.some((p) => p?.userId === userId) ? leaveSeat(table, userId) : table);
    return next.players.some((p) => p?.userId === userId && p.pendingLeave);
  }
  private async patchBankroll(userId: string, cashOutTableId?: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { bankroll: true } });
    if (user) this.io?.to(`user:${userId}`).emit(SOCKET_EVENTS.USER_PATCH, { ...user, ...(cashOutTableId ? { cashOutTableId } : {}) });
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
    await Promise.all((await this.io.in(roomFor(table.tableId)).fetchSockets()).map(async (socket) => {
      try { await authenticate(socket.data.token); } catch { socket.disconnect(true); return; }
      try {
        const state = this.project(table, socket.data.userId);
        if (state) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, state);
      } catch (err) {
        logger.error({ err, tableId: table.tableId, revision: table.revision, viewerUserId: socket.data.userId }, "table state projection failed; nothing was sent to this viewer");
      }
    }));
  }
  private armTimers(table: EngineTable): void {
    if (this.stopped) return;
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
    const timer = setTimeout(() => {
      if (this.timers.get(table.tableId) !== timer) return;
      this.timers.delete(table.tableId);
      void run().catch((err) => {
      if (!(err instanceof EngineError && err.code === "STALE_ACTION")) logger.error({ err, tableId: table.tableId }, "table timer failed");
      this.retryTimer(table.tableId, table.revision);
    }); }, delay);
    timer.unref(); this.timers.set(table.tableId, timer);
  }
  private retryTimer(tableId: string, revision: number): void {
    // A stale callback must never overwrite a newer turn's timer.
    if (this.stopped || this.timers.has(tableId) || (this.armedRevision.get(tableId) ?? revision) > revision) return;
    const retry = setTimeout(() => {
      if (this.timers.get(tableId) !== retry) return;
      this.timers.delete(tableId);
      void this.get(tableId).then((fresh) => { if (fresh) this.armTimers(fresh); }).catch((err) => {
        logger.error({ err, tableId }, "recovery retry failed");
        this.retryTimer(tableId, revision);
      });
    }, 1_000);
    retry.unref(); this.timers.set(tableId, retry);
  }
  private async persistSeats(tx: Tx, table: EngineTable, previous?: EngineTable): Promise<void> {
    for (let seatIndex = 0; seatIndex < table.maxSeats; seatIndex++) {
      const p = table.players[seatIndex];
      const data = seatData(p);
      if (previous && JSON.stringify(data) === JSON.stringify(seatData(previous.players[seatIndex]))) continue;
      await tx.tableSeat.update({ where: { tableId_seatIndex: { tableId: table.tableId, seatIndex } }, data });
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
    // Throws AUDIT_INVALID (rolling everything back) unless the audit record, the
    // committed cards and the replayed outcome all verify (see audit.ts).
    const audit = await handAuditColumns(table);
    await tx.hand.create({ data: {
      tableId: table.tableId, handNumber: table.handNumber, phase: "COMPLETE", dealerSeat: table.dealerSeat, sbSeat: table.sbSeat, bbSeat: table.bbSeat,
      board: table.board, potTotal: table.potTotal, startedAt: new Date(table.startedAt!), endedAt: new Date(table.settledAt!),
      fairnessRoot: audit.auditRecord.merkleRoot,
      handUuid: audit.handUuid, deckCommitment: audit.deckCommitment, finalStateHash: audit.finalStateHash,
      auditRecord: audit.auditRecord as unknown as Prisma.InputJsonValue, auditSealed: audit.auditSealed,
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

function seatData(p: EngineTable["players"][number] | undefined) {
  return p ? {
    userId: p.userId, status: p.sittingOut ? "SIT_OUT" as const : "OCCUPIED" as const,
    playerKind: p.kind, botProfile: p.botProfile, stack: p.stack, sittingOut: p.sittingOut,
  } : { userId: null, status: "EMPTY" as const, playerKind: "HUMAN" as const, botProfile: null, stack: 0, sittingOut: false };
}

function readyToDeal(table: EngineTable): boolean {
  const live = table.players.filter((p) => p && !p.sittingOut && p.stack > 0);
  return live.length >= 2 && live.some((p) => p!.kind === "HUMAN");
}
