import { admitSocket, notifyUser } from "../socket/notify.js";
import {
  applyAction, applyTimeout, beginIdleWarning, clearIdleWarning, closeIfEmpty, closeTable, completeHand, createTable, decideBotAction, EngineError,
  idleSince, keepTableOpen, leaveSeat, rebaseTurnClock, recordActivity, sitDown, sitIn, sitOut, startHand, turnDeadline, turnIdOf,
  type EngineIntent, type EngineTable,
} from "@poker/engine";
import { gameConfig } from "../config.js";
import {
  SOCKET_EVENTS, TABLE_IDLE_TIMEOUT_MS, TABLE_IDLE_WARNING_MS,
  type PublicTableState, type TableCloseReason, type TableIdleNoticePayload,
} from "@poker/shared";
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
  /**
   * Idle clock (see EngineTable.lastActivityAt): one advisory timer per table,
   * apart from the game timer, deduplicated by revision and deadline. It only
   * asks `mutate` to look again; the decision is taken on fresh state there.
   */
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private idleArmed = new Map<string, { revision: number; deadline: number | null }>();
  /**
   * When this process resumed timing tables: set by recover() (the boot
   * path); 0 if it never ran. Server downtime is not the players' inactivity,
   * so no idle clock runs from before it: after any restart every table gets
   * a full idle timeout before a warning can appear, and a warning that was
   * counting down when the server stopped is dropped (staleWarning).
   */
  private resumedAt = 0;
  private stopped = false;

  attach(io: PokerServer): void { this.io = io; this.stopped = false; }
  trackSocket(_userId: string, _socketId: string): void { /* rooms track presence */ }
  onDisconnect(_userId: string, _socketId: string): void {
    // A disconnect never changes hand eligibility. The original turn deadline
    // checks/folds the player, including all-in players who have no turn.
    // Nor is it activity: the idle clock keeps running.
  }
  stop(): void {
    this.stopped = true;
    for (const timer of [...this.timers.values(), ...this.idleTimers.values()]) clearTimeout(timer);
    this.timers.clear(); this.idleTimers.clear();
  }

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
      // A state from before the idle clock starts it at the row's last change, not now.
      return upgradeStoredTableState(tableId, decryptState<EngineTable>(row.stateCiphertext, `table:${tableId}`), (voided) => {
        logger.warn({ audit: "LEGACY_HAND_VOIDED", ...voided }, "legacy in-flight hand voided during upgrade; all bets returned");
      }, { fallbackActivityAt: epochMs(row.updatedAt) });
    }
    // Only brand-new tables may be hydrated from seats. Never redeal a lost hand.
    const lastHand = await tx.hand.findFirst({ where: { tableId }, orderBy: { handNumber: "desc" } });
    if (row.status === "IN_HAND" || lastHand) throw new EngineError("RECOVERY_REQUIRED", "Saved game state is missing; table paused for recovery");
    // Creation is activity: the idle clock of a table nobody has opened runs
    // from its creation, and so do the clocks of the players seated with it.
    const createdAt = epochMs(row.createdAt);
    // A new table gets the personal time bank configured now (TIME_BANK_* in
    // config.ts, published in the House Rules); it is stored in the table's
    // state, so a later configuration change never alters a running table.
    let table = createTable({ tableId: row.id, name: row.name, maxSeats: row.maxSeats, smallBlind: row.smallBlind, bigBlind: row.bigBlind, timeBankMs: row.timeBankMs, createdAt, extraTimeBank: gameConfig.extraTimeBank });
    const seats = await tx.tableSeat.findMany({ where: { tableId }, include: { user: true }, orderBy: { seatIndex: "asc" } });
    for (const seat of seats) {
      if (!seat.user || seat.status === "EMPTY" || seat.stack <= 0) continue;
      table = sitDown(table, seat.seatIndex, { userId: seat.user.id, username: seat.user.username, avatarHue: seat.user.avatarHue, kind: seat.playerKind, botProfile: seat.botProfile, buyIn: seat.stack, skipBuyInCheck: true }, createdAt);
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
  /**
   * Start timing a table created outside `mutate` (the lobby's create route),
   * so its idle clock runs even if nobody ever opens it.
   */
  async track(tableId: string): Promise<void> {
    const table = await this.get(tableId);
    if (table) this.armTimers(table);
  }

  async recover(): Promise<void> {
    // The boot path: nothing could act while the server was down (see resumedAt).
    this.resumedAt = Date.now();
    const rows = await prisma.table.findMany({ where: { status: { in: ["WAITING", "IN_HAND"] } }, select: { id: true } });
    for (const row of rows) {
      try {
        const loaded = await this.load(prisma, row.id);
        if (!loaded) continue;
        // Persist a legacy-state upgrade now (a voided hand's seats, stacks and
        // cash-outs) instead of waiting for the table's next change, close a
        // table that was left empty (mutate applies the empty-table rule), and
        // drop a warning that was counting down when the server stopped, so
        // dealing resumes and the table is timed afresh. mutate arms the timers.
        // The player to act could not act while the server was down: their turn
        // restarts with a fresh base clock and no time bank charged (F10; the
        // House Rules promise it). rebaseTurnClock changes nothing when no
        // betting round is waiting on anyone.
        const resumed = rebaseTurnClock(loaded.table, Date.now(), "SERVER_RESUME") !== loaded.table;
        if (loaded.upgraded || resumed || this.staleWarning(loaded.table) || closeIfEmpty(loaded.table) !== loaded.table) {
          await this.mutate(row.id, (current) => rebaseTurnClock(this.staleWarning(current) ? clearIdleWarning(current) : current, Date.now(), "SERVER_RESUME"));
        } else this.armTimers(loaded.table);
      } catch (err) { logger.error({ err, tableId: row.id }, "table recovery failed; refusing to redeal"); }
    }
  }

  /**
   * COMPLIANCE NOTE (table closure): the empty-table rule (closeIfEmpty) is
   * applied to every result inside the transaction, so a table closes in the
   * same commit as the leave or Hand Clean-up that emptied it: the players'
   * cash-outs, their released seats, the CLOSED status and `closedAt` commit
   * together or not at all. A CLOSED row is never loaded again (every later
   * mutation, timer and join is refused, with TABLE_CLOSED), so nothing at a
   * closed table can be paid twice.
   */
  async mutate(tableId: string, fn: (table: EngineTable, tx: Tx) => EngineTable | Promise<EngineTable>, expectedRevision?: number): Promise<EngineTable> {
    const paidUsers = new Set<string>();
    let changed = false;
    // The state this mutation started from, read under the row lock, so the
    // idle notices compare two committed states and never a stale copy.
    let before: EngineTable | null = null;
    const next = await prisma.$transaction(async (tx) => {
      // Row lock survives slow requests and is released only at commit/rollback.
      await tx.$queryRaw`SELECT id FROM public."Table" WHERE id = ${tableId} FOR UPDATE`;
      const loaded = await this.load(tx, tableId);
      // A command that raced the closure learns that the table closed, not that it never existed.
      if (!loaded) throw await this.unavailable(tx, tableId);
      const current = loaded.table;
      before = current;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
      // No one seated and no hand running: the table closes in this commit (so
      // `mutate(id, (t) => t)` closes a table that was left empty).
      const result = closeIfEmpty(await fn(current, tx));
      // An upgraded legacy state is written even when `fn` changes nothing.
      if (result === current && !loaded.upgraded) return current;
      changed = true;
      result.revision = current.revision + 1;
      // Wallet, seats, encrypted state and history either all commit or none do.
      // COMPLIANCE NOTE (cash-outs): this is the only place cash-outs are paid. They
      // are paid from the result state, which is then stored with none pending in
      // the same transaction, so no later load can pay them again.
      for (const cash of result.cashOuts) {
        const paid = await tx.user.updateMany({ where: { id: cash.userId, kind: "HUMAN" }, data: { bankroll: { increment: cash.stack } } });
        // A human's credit must land exactly once, or the whole commit is undone
        // and the seat keeps its chips (F09). Only a bot's cash-out credits
        // nothing, by design.
        if (paid.count !== 1) {
          const owner = await tx.user.findUnique({ where: { id: cash.userId }, select: { kind: true } });
          if (!owner || owner.kind === "HUMAN") throw new EngineError("CASHOUT_FAILED", "A cash-out could not be credited; nothing was changed");
        }
        paidUsers.add(cash.userId);
      }
      result.cashOuts = [];
      await this.persistSeats(tx, result, loaded.upgraded ? undefined : current);
      // A hand is recorded once, when it settles. A deal (tryStart) can settle at
      // once (all-in on the blinds), so compare hand numbers as well as phases.
      if (result.phase === "SHOWDOWN" && (current.phase !== "SHOWDOWN" || current.handNumber !== result.handNumber)) await this.persistHand(tx, result);
      await tx.table.update({ where: { id: tableId }, data: {
        status: result.status, stateCiphertext: encryptState(result, `table:${tableId}`),
        ...(result.status === "CLOSED" ? { closedAt: new Date() } : {}),
      } });
      return result;
    }, { maxWait: 10_000, timeout: 20_000 });
    const closed = next.status === "CLOSED";
    // A closed table has nothing left to time.
    if (closed) this.dispose(tableId); else this.armTimers(next);
    // The lobby tells players whose chips came back because the table closed for inactivity.
    const closedReason: TableCloseReason | undefined = next.closeReason === "IDLE" ? "IDLE" : undefined;
    // Network delivery is after commit and cannot roll back a successful payment.
    const deliveries = await Promise.allSettled([
      ...(changed && before ? [this.idleNotices(before, next)] : []),
      ...(changed ? [closed ? this.closeRoom(next) : this.broadcast(next)] : []),
      // Cash-outs must reach the wallet even after the player returns to the lobby.
      ...[...paidUsers].map((userId) => this.patchBankroll(userId, tableId, closedReason)),
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
  /**
   * Apply a player's action. With `turnId` (the PublicTableState.turnId the
   * client chose it for), the action is stale only when that turn is over:
   * unrelated changes (someone sitting out, joining or leaving) bump the
   * revision but are not a new decision for the actor (CR-008). Without it,
   * any change since `revision` makes the action stale, as before.
   */
  async intent(tableId: string, userId: string, intent: EngineIntent, revision: number, turnId?: string): Promise<void> {
    await this.mutate(tableId, (table) => {
      if (turnId !== undefined && turnIdOf(table) !== turnId) throw new EngineError("STALE_ACTION", "The table changed; use the latest action buttons");
      const deadline = turnDeadline(table);
      if (deadline != null && Date.now() >= deadline) throw new EngineError("TURN_EXPIRED", "Your turn has expired");
      // A player's own action is activity; time-outs and bot actions (armTimers) are not.
      return recordActivity(applyAction(table, userId, intent), Date.now(), userId);
    }, turnId === undefined ? revision : undefined);
  }
  async seatClaim(tableId: string, userId: string, seatIndex: number, buyIn: number): Promise<void> {
    await this.mutate(tableId, async (table, tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.kind !== "HUMAN") throw new EngineError("UNAUTHORIZED", "User missing");
      // Taking a seat is activity (sitDown refuses a closing table). It keeps
      // the table open only while this player stays (idleSince).
      const now = Date.now();
      const next = recordActivity(sitDown(table, seatIndex, { userId, username: user.username, avatarHue: user.avatarHue, kind: "HUMAN", botProfile: null, buyIn }, now), now, userId);
      const paid = await tx.user.updateMany({ where: { id: userId, bankroll: { gte: buyIn } }, data: { bankroll: { decrement: buyIn } } });
      if (!paid.count) throw new EngineError("BANKROLL", "Not enough bankroll");
      const occupied = await tx.tableSeat.findFirst({ where: { userId } });
      if (occupied) throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
      return next;
    });
    // The seat and the debit are committed: a failed balance notification must
    // not turn the claim into a reported failure (CR-017).
    await this.patchBankroll(userId).catch((err) => logger.warn({ err, userId, tableId }, "bankroll update not delivered after a seat claim"));
  }
  async sitToggle(tableId: string, userId: string, out: boolean): Promise<void> {
    await this.mutate(tableId, (table) => {
      const next = out ? sitOut(table, userId) : sitIn(table, userId);
      // A toggle that changes state is activity; a repeated one is not.
      return next === table ? table : recordActivity(next, Date.now(), userId);
    });
  }
  /** Leaving is not activity. The host has no special role: the game goes on without them. */
  async standUp(tableId: string, userId: string): Promise<boolean> {
    const next = await this.mutate(tableId, (table) => table.players.some((p) => p?.userId === userId) ? leaveSeat(table, userId) : table);
    return next.players.some((p) => p?.userId === userId && p.pendingLeave);
  }
  /** "I'm still here" from the idle warning (keepTableOpen decides who may send it). */
  async keepAlive(tableId: string, userId: string): Promise<void> {
    await this.mutate(tableId, (table) => keepTableOpen(table, userId));
  }
  /** The wallet to the user's own sockets whose session re-validates (notifyUser). */
  private async patchBankroll(userId: string, cashOutTableId?: string, tableClosedReason?: TableCloseReason): Promise<void> {
    if (!this.io) return;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { bankroll: true } });
    if (user) await notifyUser(userId, SOCKET_EVENTS.USER_PATCH, { ...user, ...(cashOutTableId ? { cashOutTableId } : {}), ...(tableClosedReason ? { tableClosedReason } : {}) }, this.io);
  }
  /**
   * TABLE_IDLE_NOTICE to seated players' own rooms (user:<id>), so a player
   * who kept their seat but is elsewhere in the app (the lobby) still sees the
   * warning and can keep the table open. `before` and `next` are the two
   * committed states of one mutation.
   * - Warning started: every human still at the table (seated, not leaving;
   *   a leaving player cannot keep it open, see keepTableOpen).
   * - Warning ended without closure: every human seated before or after, so
   *   nobody who was told keeps a stale countdown.
   * A closure is reported by the cash-out USER_PATCH. Spectators and bots
   * get nothing here; viewers of the table see the warning in its snapshot.
   * Delivered through notifyUser (only sockets whose session re-validates),
   * one user after another so the order is deterministic. Never rejects: a
   * failed notice is logged, and the table snapshot still carries the warning.
   */
  private async idleNotices(before: EngineTable, next: EngineTable): Promise<void> {
    if (!this.io) return;
    const humans = (table: EngineTable, staying: boolean): string[] =>
      table.players.flatMap((p) => p && p.kind === "HUMAN" && !(staying && p.pendingLeave) ? [p.userId] : []);
    let to: string[];
    let closingInMs: number | null;
    if (before.closingAt == null && next.closingAt != null) {
      to = humans(next, true);
      closingInMs = Math.max(0, next.closingAt - Date.now());
    } else if (before.closingAt != null && next.closingAt == null && next.closeReason == null) {
      to = [...new Set([...humans(before, false), ...humans(next, false)])];
      closingInMs = null;
    } else return;
    const notice: TableIdleNoticePayload = { tableId: next.tableId, tableName: next.name, closingInMs };
    for (const userId of to) {
      try { await notifyUser(userId, SOCKET_EVENTS.TABLE_IDLE_NOTICE, notice, this.io); }
      catch (err) { logger.warn({ err, tableId: next.tableId, userId }, "idle notice failed; the table snapshot still carries the warning"); }
    }
  }
  /**
   * Read-only: the idle warning a user seated at `tableId` should see right
   * now (AUTH_OK on connect/reconnect), or null. Mirrors idleNotices' start
   * rule (seated human, not leaving) on the stored state; a warning from
   * before this process resumed is stale (it is being dropped) and is not
   * reported. Loads only: never arms timers, never emits, never writes.
   */
  async currentIdleNotice(tableId: string, userId: string): Promise<TableIdleNoticePayload | null> {
    let table: EngineTable | null;
    try { table = await this.get(tableId); } catch (err) { logger.warn({ err, tableId }, "idle notice lookup failed; AUTH_OK sent without it"); return null; }
    if (!table || table.closingAt == null || table.closeReason != null || this.staleWarning(table)) return null;
    if (!table.players.some((p) => p?.userId === userId && p.kind === "HUMAN" && !p.pendingLeave)) return null;
    return { tableId: table.tableId, tableName: table.name, closingInMs: Math.max(0, table.closingAt - Date.now()) };
  }
  /** Why a table cannot be loaded (under its row lock): it has closed, or there is no such table. */
  private async unavailable(tx: Tx, tableId: string): Promise<EngineError> {
    const row = await tx.table.findUnique({ where: { id: tableId }, select: { status: true } });
    return row?.status === "CLOSED" ? new EngineError("TABLE_CLOSED", "This table has closed") : new EngineError("TABLE_NOT_FOUND", "Table not found");
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
  /**
   * Each viewer's session is re-validated first (admitSocket): a revoked or
   * expired session is told SESSION_REVOKED and disconnected; if the check
   * itself fails (database unavailable) that viewer is skipped for this
   * snapshot only and stays connected (the next snapshot catches it up).
   */
  private async broadcast(table: EngineTable): Promise<void> {
    if (!this.io) return;
    await Promise.all((await this.io.in(roomFor(table.tableId)).fetchSockets()).map(async (socket) => {
      if (!await admitSocket(socket)) return;
      try {
        const state = this.project(table, socket.data.userId);
        if (state) socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, state);
      } catch (err) {
        logger.error({ err, tableId: table.tableId, revision: table.revision, viewerUserId: socket.data.userId }, "table state projection failed; nothing was sent to this viewer");
      }
    }));
  }
  /** A closed table's viewers get its final state (the closed notice), then its room is emptied. */
  private async closeRoom(table: EngineTable): Promise<void> {
    const room = roomFor(table.tableId);
    try { await this.broadcast(table); } finally { this.io?.in(room).socketsLeave(room); }
  }
  private armTimers(table: EngineTable): void {
    if (this.stopped || table.status === "CLOSED") return;
    this.armIdleTimer(table);
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
      // Hand Clean-up commits on its own: it purges the settled hand's secrets
      // and pays leavers' cash-outs. The next deal follows at once as a separate
      // command (tryStart), so a deal that fails, for example on an RNG health
      // check, can never undo the clean-up or its payouts (CR-033); it is retried.
      run = async () => {
        await this.mutate(table.tableId, (current) => completeHand(current), table.revision);
        await this.tryStart(table.tableId);
      };
    } else if (table.phase === "WAITING" || table.phase === "COMPLETE") {
      if (!readyToDeal(table)) return;
      delay = 100;
      run = () => this.tryStart(table.tableId);
    } else {
      if (table.toActSeat == null) return;
      const actor = table.players[table.toActSeat]!;
      // The deadline includes the actor's personal time bank when the table has one.
      const remaining = Math.max(0, (turnDeadline(table) ?? Date.now()) - Date.now());
      // Legacy bots play only when ENABLE_LEGACY_BOTS is on (D11); otherwise a
      // bot's turn is treated like an absent player's and times out.
      if (actor.kind === "BOT" && gameConfig.enableLegacyBots && remaining > 0) {
        const decision = decideBotAction(table);
        delay = Math.max(0, Math.min(remaining, table.turnStartedAt! + decision.delayMs - Date.now()));
        run = () => this.mutate(table.tableId, (current) => Date.now() >= (turnDeadline(current) ?? 0) ? applyTimeout(current) : applyAction(current, actor.userId, decision.intent), table.revision);
      } else {
        delay = remaining;
        run = () => this.mutate(table.tableId, (current) => applyTimeout(current), table.revision);
      }
    }
    const timer = setTimeout(() => {
      if (this.timers.get(table.tableId) !== timer) return;
      this.timers.delete(table.tableId);
      void run().catch((err) => {
        // The table closed (or is gone) since this timer was armed: nothing is left to time.
        if (isGone(err)) { this.dispose(table.tableId); return; }
        if (!(err instanceof EngineError && err.code === "STALE_ACTION")) logger.error({ err, tableId: table.tableId }, "table timer failed");
        this.retryTimer(table.tableId, table.revision);
      });
    }, delay);
    timer.unref(); this.timers.set(table.tableId, timer);
  }
  /** Where the idle clock runs from: the activity of the players still at the table (idleSince), never before this process resumed. */
  private idleFrom(table: EngineTable): number {
    return Math.max(idleSince(table), this.resumedAt);
  }
  /** A warning that began before this process resumed: it counted down while nobody could act. */
  private staleWarning(table: EngineTable): boolean {
    return table.closingAt != null && table.closeReason == null && table.closingAt - TABLE_IDLE_WARNING_MS < this.resumedAt;
  }
  /**
   * The idle timer: at `closingAt` during a warning (at once for a stale
   * warning, which idleCheck drops), otherwise when the idle timeout after
   * idleFrom runs out; none once closure has begun (Hand Clean-up and the
   * empty-table rule finish the table). A stale lower-revision load never
   * replaces the timer of a newer state, and a pending timer for the same
   * deadline is kept.
   */
  private armIdleTimer(table: EngineTable): void {
    const { tableId } = table;
    const armed = this.idleArmed.get(tableId);
    if (armed && armed.revision > table.revision) return;
    const deadline = table.closeReason != null ? null
      : table.closingAt == null ? this.idleFrom(table) + TABLE_IDLE_TIMEOUT_MS
      : this.staleWarning(table) ? this.resumedAt : table.closingAt;
    if (armed && armed.deadline === deadline && (deadline === null || this.idleTimers.has(tableId))) { armed.revision = table.revision; return; }
    this.idleArmed.set(tableId, { revision: table.revision, deadline });
    clearTimeout(this.idleTimers.get(tableId));
    this.idleTimers.delete(tableId);
    if (deadline === null) return;
    // At most one idle timeout: a corrupt far-future lastActivityAt beyond
    // setTimeout's range would otherwise fire at once, over and over. Firing
    // early is harmless (idleCheck changes nothing and the timer is re-armed).
    const delay = Math.min(Math.max(0, deadline - Date.now()), TABLE_IDLE_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (this.idleTimers.get(tableId) !== timer) return;
      this.idleTimers.delete(tableId);
      // A newer state with the same deadline kept this timer: it now stands for
      // that revision, so a failed check must still retry for it.
      const revision = this.idleArmed.get(tableId)?.revision ?? table.revision;
      void this.idleCheck(tableId).catch((err) => {
        if (isGone(err)) { this.dispose(tableId); return; }
        logger.error({ err, tableId }, "table idle timer failed");
        this.retryIdle(tableId, revision);
      });
    }, delay);
    timer.unref(); this.idleTimers.set(tableId, timer);
  }
  /**
   * The idle timer fired on its own copy of the table. Warn or close only if
   * fresh state, read under the row lock, still says so: any activity since
   * then, or a closure already begun, wins over the timer. A warning from
   * before a restart is dropped instead (recover() already does this; this is
   * the fallback), and the table is then timed from idleFrom.
   */
  private idleCheck(tableId: string): Promise<EngineTable> {
    return this.mutate(tableId, (table) => {
      const now = Date.now();
      if (table.closeReason != null) return table;
      if (this.staleWarning(table)) return clearIdleWarning(table);
      if (table.closingAt == null) return now >= this.idleFrom(table) + TABLE_IDLE_TIMEOUT_MS ? beginIdleWarning(table, now + TABLE_IDLE_WARNING_MS) : table;
      return now >= table.closingAt ? closeTable(table, "IDLE", now) : table;
    });
  }
  private retryIdle(tableId: string, revision: number): void {
    // As retryTimer: a failed check never overwrites the idle timer of a newer state.
    if (this.stopped || this.idleTimers.has(tableId) || (this.idleArmed.get(tableId)?.revision ?? revision) > revision) return;
    const retry = setTimeout(() => {
      if (this.idleTimers.get(tableId) !== retry) return;
      this.idleTimers.delete(tableId);
      void this.get(tableId).then((fresh) => { if (fresh) this.armTimers(fresh); else this.dispose(tableId); }).catch((err) => {
        if (isGone(err)) { this.dispose(tableId); return; }
        logger.error({ err, tableId }, "idle timer retry failed");
        this.retryIdle(tableId, revision);
      });
    }, 1_000);
    retry.unref(); this.idleTimers.set(tableId, retry);
  }
  /** Forget a closed table: cancel its timers and drop its bookkeeping. */
  private dispose(tableId: string): void {
    for (const timers of [this.timers, this.idleTimers]) { clearTimeout(timers.get(tableId)); timers.delete(tableId); }
    this.armedRevision.delete(tableId); this.idleArmed.delete(tableId);
  }
  private retryTimer(tableId: string, revision: number): void {
    // A stale callback must never overwrite a newer turn's timer.
    if (this.stopped || this.timers.has(tableId) || (this.armedRevision.get(tableId) ?? revision) > revision) return;
    const retry = setTimeout(() => {
      if (this.timers.get(tableId) !== retry) return;
      this.timers.delete(tableId);
      void this.get(tableId).then((fresh) => { if (fresh) this.armTimers(fresh); }).catch((err) => {
        if (isGone(err)) { this.dispose(tableId); return; }
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
  // No hand is dealt during the idle warning or once closure has begun (startHand
  // refuses too).
  if (table.closingAt != null || table.closeReason != null) return false;
  const live = table.players.filter((p) => p && !p.sittingOut && p.stack > 0);
  return live.length >= 2 && live.some((p) => p!.kind === "HUMAN");
}

/** The table closed or no longer exists: a timer that meets this has nothing left to time. */
function isGone(err: unknown): boolean {
  return err instanceof EngineError && (err.code === "TABLE_NOT_FOUND" || err.code === "TABLE_CLOSED");
}

/** A row timestamp in ms, or undefined when it is missing (in-memory test rows), so the engine uses now. */
function epochMs(value: Date | null | undefined): number | undefined {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}
