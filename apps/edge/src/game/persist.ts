import {
  EngineError,
  closeIfEmpty,
  createTable,
  sitDown,
  sitOut,
  type EngineTable,
} from "@poker/engine";
import type { BotProfile, CommandResult } from "@poker/shared";
import { createPrisma } from "../db/client";
import { insertGameCommand } from "../db/game-command";
import type { EdgeConfig, Env } from "../env";
import { readEdgeConfig } from "../env";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { handAuditColumns, handContext } from "./audit";
import { decryptState, encryptState, ringFromConfig } from "./crypto";
import { upgradeStoredTableState } from "./legacy";
import { logEvent, prismaCode } from "./log";
import type { KeyRing } from "./key-ring";
import {
  commandGet,
  commandPut,
  insertPending,
  metaGet,
  metaSet,
  pendingOutbox,
  setOutboxStatus,
  type StoredCommand,
} from "../table/store";

type Tx = Prisma.TransactionClient;

export class DuplicateCommand extends Error {
  constructor() {
    super("DUPLICATE_COMMAND");
    this.name = "DuplicateCommand";
  }
}

export class TransientDb extends Error {
  constructor() {
    super("TRANSIENT_DB");
    this.name = "TransientDb";
  }
}

/** Thrown after Postgres commits and before the DO meta write. One-shot. */
export class TestFault extends Error {
  constructor() {
    super("TEST_FAULT_AFTER_POSTGRES");
    this.name = "TestFault";
  }
}

export interface ChipOp {
  userId: string;
  amount: number;
  mode: "credit" | "debit";
}

export interface OutboxPayload {
  commandId: string;
  kind: string;
  userId: string | null;
  revision: number;
  ciphertext: string;
  chips: ChipOp[];
}

export interface TableRowInfo {
  id: string;
  name: string;
  status: string;
  isPrivate: boolean;
  hostId: string | null;
  stateCiphertext: string | null;
  createdAt: Date;
  updatedAt: Date;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  timeBankMs: number;
  closedAt: Date | null;
}

export interface OpenedTable {
  table: EngineTable | null;
  upgraded: boolean;
  row: TableRowInfo | null;
  paused: boolean;
  closed: boolean;
  missing: boolean;
}

export interface DbCtx {
  prisma: PrismaClient;
  config: EdgeConfig;
  ring: KeyRing;
}

export async function withDb<T>(env: Env, fn: (db: DbCtx) => Promise<T>): Promise<T> {
  const config = readEdgeConfig(env);
  const prisma = createPrisma(env.HYPERDRIVE.connectionString);
  try {
    return await fn({ prisma, config, ring: ringFromConfig(config) });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

export interface MutationRequest {
  /** A function id is resolved after the engine runs (deal and idle ids depend on the result). */
  commandId: string | ((before: EngineTable, next: EngineTable) => string);
  kind: string;
  userId: string | null;
  /** Client mistakes are stored. Alarm failures are not, so the clock can retry. */
  storeEngineError: boolean;
  /**
   * Client no-ops still record GameCommand so a later retry cannot apply.
   * Server clock ids must not be consumed by a no-op, or the real deal/timeout
   * would look like a duplicate.
   */
  durableNoOp?: boolean;
  extraChips?: ChipOp[];
  fn: (table: EngineTable) => EngineTable | Promise<EngineTable>;
  success: (table: EngineTable) => Extract<CommandResult, { ok: true }>;
}

export interface Settlement {
  table: EngineTable | null;
  walletUserIds: string[];
  creditUserIds: string[];
}

export interface MutationOutcome {
  result: CommandResult;
  /** Newest committed state the caller should broadcast, if clients might not have it. */
  broadcast: EngineTable | null;
  before: EngineTable | null;
  changed: boolean;
  walletUserIds: string[];
  creditUserIds: string[];
  row: TableRowInfo | null;
}

function errorResult(error: EngineError, retryable = false): CommandResult {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(retryable ? { retryable: true } : {}),
  };
}

function replay(raw: string): CommandResult {
  const parsed = JSON.parse(raw) as CommandResult;
  if (parsed.ok) return { ...parsed, duplicate: true };
  return parsed;
}

function storeResult(sql: SqlStorage, commandId: string, result: CommandResult, revision: number): void {
  commandPut(sql, commandId, JSON.stringify(result), revision);
}

function isTransient(error: unknown): boolean {
  const code = prismaCode(error);
  if (!code) return true;
  return code.startsWith("P10") || code === "P2024" || code === "P2028" || code === "P2034";
}

function cashOutChips(table: EngineTable): ChipOp[] {
  return table.cashOuts.map((cash) => ({ userId: cash.userId, amount: cash.stack, mode: "credit" as const }));
}

async function applyChips(tx: Tx, chips: ChipOp[]): Promise<void> {
  for (const chip of chips) {
    if (!Number.isSafeInteger(chip.amount) || chip.amount < 0) {
      throw new EngineError("CASHOUT_FAILED", "A cash-out could not be credited; nothing was changed");
    }
    if (chip.mode === "debit") {
      const paid = await tx.user.updateMany({
        where: { id: chip.userId, kind: "HUMAN", bankroll: { gte: chip.amount } },
        data: { bankroll: { decrement: chip.amount } },
      });
      if (!paid.count) {
        const owner = await tx.user.findUnique({ where: { id: chip.userId }, select: { kind: true } });
        if (!owner || owner.kind !== "HUMAN") throw new EngineError("UNAUTHORIZED", "User missing");
        throw new EngineError("BANKROLL", "Not enough bankroll");
      }
      const occupied = await tx.tableSeat.findFirst({ where: { userId: chip.userId }, select: { id: true } });
      if (occupied) throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
      continue;
    }
    const paid = await tx.user.updateMany({
      where: { id: chip.userId, kind: "HUMAN" },
      data: { bankroll: { increment: chip.amount } },
    });
    if (paid.count !== 1) {
      const owner = await tx.user.findUnique({ where: { id: chip.userId }, select: { kind: true } });
      if (owner?.kind !== "BOT") throw new EngineError("CASHOUT_FAILED", "A cash-out could not be credited; nothing was changed");
    }
  }
}

function seatData(player: EngineTable["players"][number] | null | undefined) {
  return player
    ? {
        userId: player.userId,
        status: player.sittingOut ? "SIT_OUT" as const : "OCCUPIED" as const,
        playerKind: player.kind,
        botProfile: player.botProfile,
        stack: player.stack,
        sittingOut: player.sittingOut,
      }
    : { userId: null, status: "EMPTY" as const, playerKind: "HUMAN" as const, botProfile: null, stack: 0, sittingOut: false };
}

async function persistSeats(tx: Tx, table: EngineTable): Promise<void> {
  for (let seatIndex = 0; seatIndex < table.maxSeats; seatIndex++) {
    await tx.tableSeat.update({
      where: { tableId_seatIndex: { tableId: table.tableId, seatIndex } },
      data: seatData(table.players[seatIndex]),
    });
  }
}

async function persistHand(tx: Tx, table: EngineTable, ring: KeyRing): Promise<void> {
  const existing = await tx.hand.findUnique({
    where: { tableId_handNumber: { tableId: table.tableId, handNumber: table.handNumber } },
    select: { id: true },
  });
  if (existing || table.phase !== "SHOWDOWN") return;
  const dealt = table.players.filter((p) => p?.holeCards);
  const context = handContext(table.tableId, table.handNumber);
  const audit = await handAuditColumns(table, ring);
  const snapshot = JSON.parse(JSON.stringify({ winners: table.winners, refunds: table.refunds, log: table.log })) as Prisma.InputJsonValue;
  await tx.hand.create({
    data: {
      tableId: table.tableId,
      handNumber: table.handNumber,
      phase: "COMPLETE",
      dealerSeat: table.dealerSeat,
      sbSeat: table.sbSeat,
      bbSeat: table.bbSeat,
      board: table.board,
      potTotal: table.potTotal,
      rake: table.rakeTaken ?? 0,
      startedAt: new Date(table.startedAt ?? Date.now()),
      endedAt: new Date(table.settledAt ?? Date.now()),
      fairnessRoot: audit.auditRecord.merkleRoot,
      handUuid: audit.handUuid,
      deckCommitment: audit.deckCommitment,
      finalStateHash: audit.finalStateHash,
      auditRecord: JSON.parse(JSON.stringify(audit.auditRecord)) as Prisma.InputJsonValue,
      auditSealed: audit.auditSealed,
      snapshot,
      players: {
        create: dealt.map((p) => {
          const win = table.winners.find((w) => w.seatIndex === p!.seatIndex)?.amount ?? 0;
          const refund = table.refunds.find((r) => r.seatIndex === p!.seatIndex)?.amount ?? 0;
          return {
            userId: p!.userId,
            seatIndex: p!.seatIndex,
            playerKind: p!.kind,
            botProfile: p!.botProfile,
            holeCards: [],
            encryptedHoleCards: encryptState(ring, p!.holeCards, `${context}:seat:${p!.seatIndex}`),
            startingStack: p!.stack - win - refund + p!.committedThisHand,
            endingStack: p!.stack,
            net: win + refund - p!.committedThisHand,
            showedCards: p!.showedCards,
            won: win > 0,
            handRankName: p!.handResult?.name,
            handRankValue: p!.handResult ? BigInt(p!.handResult.rankValue) : null,
          };
        }),
      },
      pots: {
        create: table.awards.map((pot) => ({
          potIndex: pot.potIndex,
          amount: pot.amount,
          eligibleSeats: [...pot.eligibleSeatIndexes],
          winnerSeats: [...pot.winnerSeatIndexes],
          oddChipSeat: pot.oddChipSeatIndex,
        })),
      },
      actions: {
        create: table.actions.map((action) => ({
          seq: action.seq,
          seatIndex: action.seatIndex,
          street: action.street,
          action: action.action,
          amount: action.amount,
          toAmount: action.toAmount,
          createdAt: new Date(action.at),
        })),
      },
    },
  });
  for (const player of dealt) {
    if (player?.kind !== "BOT") continue;
    const won = table.winners.find((w) => w.seatIndex === player.seatIndex)?.amount ?? 0;
    const refund = table.refunds.find((r) => r.seatIndex === player.seatIndex)?.amount ?? 0;
    await tx.botStatistic.updateMany({
      where: { userId: player.userId },
      data: {
        handsPlayed: { increment: 1 },
        chipsWon: { increment: won + refund - player.committedThisHand },
        showdowns: { increment: player.showedCards ? 1 : 0 },
        showdownsWon: { increment: won > 0 && player.showedCards ? 1 : 0 },
      },
    });
  }
}

async function writePostgres(db: DbCtx, tableId: string, payload: OutboxPayload): Promise<void> {
  const table = decryptState<EngineTable>(db.ring, payload.ciphertext, `table:${tableId}`);
  try {
  await db.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."Table" WHERE id = ${tableId} FOR UPDATE`;
    const existing = await tx.gameCommand.findUnique({ where: { id: payload.commandId }, select: { id: true } });
    if (existing) throw new DuplicateCommand();
    await applyChips(tx, payload.chips);
    await persistSeats(tx, table);
    await persistHand(tx, table, db.ring);
    const row = await tx.table.findUnique({ where: { id: tableId }, select: { closedAt: true } });
    await tx.table.update({
      where: { id: tableId },
      data: {
        status: table.status,
        stateCiphertext: payload.ciphertext,
        ...(table.status === "CLOSED" && !row?.closedAt ? { closedAt: new Date() } : {}),
      },
    });
    const inserted = await insertGameCommand(tx, {
      id: payload.commandId,
      tableId,
      userId: payload.userId,
      kind: payload.kind,
      appliedRevision: payload.revision,
    });
    if (inserted === "duplicate") throw new DuplicateCommand();
  }, { maxWait: 10_000, timeout: 20_000 });
  } catch (error) {
    if (error instanceof DuplicateCommand || error instanceof EngineError) throw error;
    if (prismaCode(error) === "P2002") throw new EngineError("ALREADY_SEATED", "Leave your current table before joining another");
    throw error;
  }
}

function remember(storage: DurableObjectStorage, payload: OutboxPayload, result: CommandResult): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    metaSet(sql, "engine", payload.ciphertext);
    metaSet(sql, "revision", String(payload.revision));
    commandPut(sql, payload.commandId, JSON.stringify(result), payload.revision);
    setOutboxStatus(sql, payload.commandId, "committed");
  });
}

function abortOutbox(storage: DurableObjectStorage, commandId: string, result: CommandResult, revision: number): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    setOutboxStatus(sql, commandId, "aborted");
    commandPut(sql, commandId, JSON.stringify(result), revision);
  });
}

async function adoptPostgres(db: DbCtx, storage: DurableObjectStorage, tableId: string, commandId: string): Promise<EngineTable | null> {
  const sql = storage.sql;
  const row = await db.prisma.table.findUnique({ where: { id: tableId }, select: { stateCiphertext: true } });
  if (!row?.stateCiphertext) return null;
  const table = decryptState<EngineTable>(db.ring, row.stateCiphertext, `table:${tableId}`);
  const doRevision = Number(metaGet(sql, "revision"));
  const behind = !Number.isFinite(doRevision) || doRevision !== table.revision || metaGet(sql, "engine") !== row.stateCiphertext;
  const result: CommandResult = { ok: true };
  storage.transactionSync(() => {
    if (behind) {
      metaSet(sql, "engine", row.stateCiphertext!);
      metaSet(sql, "revision", String(table.revision));
    }
    if (!commandGet(sql, commandId)) commandPut(sql, commandId, JSON.stringify(result), table.revision);
    setOutboxStatus(sql, commandId, "committed");
  });
  return behind ? table : null;
}

/**
 * Finish one pending outbox row. If GameCommand exists, adopt Postgres and do
 * not apply chips again. A transient error leaves the row pending.
 */
function walletsOf(payload: OutboxPayload): Pick<Settlement, "walletUserIds" | "creditUserIds"> {
  return {
    walletUserIds: payload.chips.map((chip) => chip.userId),
    creditUserIds: payload.chips.filter((chip) => chip.mode === "credit").map((chip) => chip.userId),
  };
}

export async function settlePending(db: DbCtx, storage: DurableObjectStorage, tableId: string): Promise<Settlement | null> {
  const sql = storage.sql;
  const pending = pendingOutbox(sql);
  if (!pending) return null;
  let payload: OutboxPayload;
  try {
    payload = JSON.parse(pending.payload) as OutboxPayload;
  } catch {
    setOutboxStatus(sql, pending.id, "aborted");
    logEvent("error", "outbox payload was not json", { tableId });
    return { table: null, walletUserIds: [], creditUserIds: [] };
  }
  const wallets = walletsOf(payload);
  const existing = await db.prisma.gameCommand.findUnique({ where: { id: payload.commandId }, select: { id: true } });
  if (existing) return { table: await adoptPostgres(db, storage, tableId, payload.commandId), ...wallets };
  try {
    await writePostgres(db, tableId, payload);
  } catch (error) {
    if (error instanceof DuplicateCommand) return { table: await adoptPostgres(db, storage, tableId, payload.commandId), ...wallets };
    if (error instanceof EngineError) {
      abortOutbox(storage, payload.commandId, errorResult(error), Math.max(0, payload.revision - 1));
      logEvent("warn", "table mutation refused", { tableId, code: error.code });
      return { table: null, walletUserIds: [], creditUserIds: [] };
    }
    logEvent("error", "table mutation failed", { tableId, code: prismaCode(error) });
    throw new TransientDb();
  }
  if (metaGet(sql, "testFault") === "throw-after-postgres") {
    metaSet(sql, "testFault", "");
    throw new TestFault();
  }
  const result: CommandResult = { ok: true };
  remember(storage, payload, result);
  return { table: decryptState<EngineTable>(db.ring, payload.ciphertext, `table:${tableId}`), ...wallets };
}

async function pauseTable(db: DbCtx, sql: SqlStorage, tableId: string, kind: "STATE_DIVERGENCE" | "RECOVERY_REQUIRED", reason: string): Promise<void> {
  if (metaGet(sql, "paused")) return;
  const text = reason.slice(0, 1000);
  await db.prisma.table.update({
    where: { id: tableId },
    data: { status: "PAUSED", pausedAt: new Date(), pausedReason: text },
  });
  await db.prisma.tableIncident.create({ data: { tableId, kind, reason: text } });
  metaSet(sql, "paused", kind);
  logEvent("error", "table paused", { tableId, kind });
}

function upgrade(tableId: string, ciphertext: string, ring: KeyRing, fallbackActivityAt?: number): { table: EngineTable; upgraded: boolean } {
  const stored = decryptState<EngineTable>(ring, ciphertext, `table:${tableId}`);
  return upgradeStoredTableState(tableId, stored, (voided) => {
    logEvent("warn", "legacy in-flight hand voided during upgrade", { tableId: voided.tableId, handNumber: voided.handNumber });
  }, { fallbackActivityAt });
}

function buildFromSeats(row: TableRowInfo & { seats: SeatSeed[] }, config: EdgeConfig): EngineTable {
  const createdAt = row.createdAt.getTime();
  let table = createTable({
    tableId: row.id,
    name: row.name,
    maxSeats: row.maxSeats,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    timeBankMs: row.timeBankMs,
    createdAt,
    extraTimeBank: {
      initialMs: config.timeBankInitialMs,
      maxMs: config.timeBankMaxMs,
      refillMs: config.timeBankRefillMs,
      refillEveryHands: config.timeBankRefillEveryHands,
    },
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
    }, createdAt);
    if (seat.sittingOut) table = sitOut(table, seat.user.id);
  }
  return table;
}

interface SeatSeed {
  seatIndex: number;
  status: string;
  stack: number;
  sittingOut: boolean;
  playerKind: "HUMAN" | "BOT";
  botProfile: BotProfile | null;
  user: { id: string; username: string; avatarHue: number } | null;
}

function rowInfo(row: {
  id: string;
  name: string;
  status: string;
  isPrivate: boolean;
  hostId: string | null;
  stateCiphertext: string | null;
  createdAt: Date;
  updatedAt: Date;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  timeBankMs: number;
  closedAt: Date | null;
}): TableRowInfo {
  return row;
}

/** Cold start, divergence check, or the hot DO copy. Does not deal. */
export async function openTable(db: DbCtx, storage: DurableObjectStorage, tableId: string): Promise<OpenedTable> {
  const sql = storage.sql;
  const row = await db.prisma.table.findUnique({
    where: { id: tableId },
    include: { seats: { include: { user: true }, orderBy: { seatIndex: "asc" } } },
  });
  if (!row) return { table: null, upgraded: false, row: null, paused: false, closed: false, missing: true };
  const info = rowInfo(row);
  if (row.status === "CLOSED") return { table: null, upgraded: false, row: info, paused: false, closed: true, missing: false };
  if (metaGet(sql, "paused") || row.status === "PAUSED") {
    return { table: null, upgraded: false, row: info, paused: true, closed: false, missing: false };
  }
  const doCipher = metaGet(sql, "engine");
  const pgCipher = row.stateCiphertext;
  if (!doCipher && !pgCipher) {
    const hands = await db.prisma.hand.count({ where: { tableId } });
    if (row.status === "IN_HAND" || hands > 0) {
      await pauseTable(db, sql, tableId, "RECOVERY_REQUIRED", "Saved game state is missing; table paused for recovery");
      return { table: null, upgraded: false, row: info, paused: true, closed: false, missing: false };
    }
    return { table: buildFromSeats({ ...info, seats: row.seats }, db.config), upgraded: false, row: info, paused: false, closed: false, missing: false };
  }
  if (doCipher && pgCipher) {
    const doState = decryptState<EngineTable>(db.ring, doCipher, `table:${tableId}`);
    const pgState = decryptState<EngineTable>(db.ring, pgCipher, `table:${tableId}`);
    if (doState.revision !== pgState.revision) {
      const pending = pendingOutbox(sql);
      const explained = pending ? explainPending(doState.revision, pgState.revision, pending.payload) : false;
      if (!explained) {
        await pauseTable(db, sql, tableId, "STATE_DIVERGENCE", "DO revision and Postgres checkpoint revision differ");
        return { table: null, upgraded: false, row: info, paused: true, closed: false, missing: false };
      }
    }
  } else if (doCipher && !pgCipher) {
    await pauseTable(db, sql, tableId, "STATE_DIVERGENCE", "DO has engine state and Postgres has no checkpoint");
    return { table: null, upgraded: false, row: info, paused: true, closed: false, missing: false };
  }
  const cipher = doCipher ?? pgCipher!;
  if (!doCipher && pgCipher) {
    metaSet(sql, "engine", pgCipher);
    const revision = decryptState<EngineTable>(db.ring, pgCipher, `table:${tableId}`).revision;
    metaSet(sql, "revision", String(revision));
  }
  const loaded = upgrade(tableId, cipher, db.ring, row.updatedAt.getTime());
  return { table: loaded.table, upgraded: loaded.upgraded, row: info, paused: false, closed: false, missing: false };
}

function explainPending(doRevision: number, pgRevision: number, payloadRaw: string): boolean {
  try {
    const payload = JSON.parse(payloadRaw) as OutboxPayload;
    if (pgRevision === payload.revision && payload.revision === doRevision + 1) return true;
    if (pgRevision === doRevision && payload.revision === doRevision + 1) return true;
    return false;
  } catch {
    return false;
  }
}

function resolveCommandId(request: MutationRequest, before: EngineTable, next: EngineTable): string {
  return typeof request.commandId === "string" ? request.commandId : request.commandId(before, next);
}

async function recordNoOp(db: DbCtx, storage: DurableObjectStorage, tableId: string, request: MutationRequest, table: EngineTable, commandId: string): Promise<CommandResult> {
  const sql = storage.sql;
  const result = request.success(table);
  await db.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."Table" WHERE id = ${tableId} FOR UPDATE`;
    const inserted = await insertGameCommand(tx, {
      id: commandId,
      tableId,
      userId: request.userId,
      kind: request.kind,
      appliedRevision: table.revision,
    });
    if (inserted === "duplicate") throw new DuplicateCommand();
  }, { maxWait: 10_000, timeout: 20_000 });
  storeResult(sql, commandId, result, table.revision);
  return result;
}

function storedCommand(sql: SqlStorage, commandId: string): StoredCommand | null {
  return commandGet(sql, commandId);
}

/**
 * Idempotent mutation. Settles a pending outbox first. A pure no-op still
 * records GameCommand so a later retry cannot apply against newer state.
 */
function outcome(partial: Pick<MutationOutcome, "result" | "broadcast" | "before" | "changed" | "row"> & Partial<Pick<MutationOutcome, "walletUserIds" | "creditUserIds">>): MutationOutcome {
  return { walletUserIds: [], creditUserIds: [], ...partial };
}

export async function applyMutation(db: DbCtx, storage: DurableObjectStorage, tableId: string, request: MutationRequest): Promise<MutationOutcome> {
  const sql = storage.sql;
  let broadcast: EngineTable | null = null;
  const walletUserIds: string[] = [];
  const creditUserIds: string[] = [];
  const earlyId = typeof request.commandId === "string" ? request.commandId : null;
  const takeWallets = (settled: Settlement | null) => {
    if (!settled) return;
    if (settled.table) broadcast = settled.table;
    walletUserIds.push(...settled.walletUserIds);
    creditUserIds.push(...settled.creditUserIds);
  };
  for (let i = 0; i < 8; i++) {
    if (earlyId) {
      const stored = storedCommand(sql, earlyId);
      if (stored) return outcome({ result: replay(stored.result), broadcast, before: null, changed: false, row: null, walletUserIds, creditUserIds });
    }
    if (!pendingOutbox(sql)) break;
    takeWallets(await settlePending(db, storage, tableId));
  }
  if (earlyId) {
    const again = storedCommand(sql, earlyId);
    if (again) return outcome({ result: replay(again.result), broadcast, before: null, changed: false, row: null, walletUserIds, creditUserIds });
    const existing = await db.prisma.gameCommand.findUnique({ where: { id: earlyId }, select: { id: true } });
    if (existing) {
      const adopted = await adoptPostgres(db, storage, tableId, earlyId);
      return outcome({
        result: replay(commandGet(sql, earlyId)?.result ?? JSON.stringify({ ok: true })),
        broadcast: adopted ?? broadcast,
        before: null,
        changed: false,
        row: null,
        walletUserIds,
        creditUserIds,
      });
    }
  }
  const opened = await openTable(db, storage, tableId);
  if (opened.missing) return outcome({ result: errorResult(new EngineError("TABLE_NOT_FOUND", "Table not found")), broadcast, before: null, changed: false, row: null, walletUserIds, creditUserIds });
  if (opened.closed) return outcome({ result: errorResult(new EngineError("TABLE_CLOSED", "This table has closed")), broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
  if (opened.paused || !opened.table) {
    return outcome({
      result: { ok: false, code: "RECOVERY_REQUIRED", message: "Saved game state is missing; table paused for recovery", retryable: true },
      broadcast,
      before: null,
      changed: false,
      row: opened.row,
      walletUserIds,
      creditUserIds,
    });
  }
  let next: EngineTable;
  try {
    next = closeIfEmpty(await request.fn(opened.table));
  } catch (error) {
    if (error instanceof EngineError) {
      const commandId = resolveCommandId(request, opened.table, opened.table);
      if (request.storeEngineError) storeResult(sql, commandId, errorResult(error), opened.table.revision);
      else throw error;
      return outcome({ result: errorResult(error), broadcast, before: opened.table, changed: false, row: opened.row, walletUserIds, creditUserIds });
    }
    throw error;
  }
  if (next === opened.table && !opened.upgraded) {
    if (request.durableNoOp === false) {
      return outcome({ result: { ok: true }, broadcast, before: opened.table, changed: false, row: opened.row, walletUserIds, creditUserIds });
    }
    const commandId = resolveCommandId(request, opened.table, next);
    const prior = storedCommand(sql, commandId);
    if (prior) return outcome({ result: replay(prior.result), broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
    try {
      const result = await recordNoOp(db, storage, tableId, request, opened.table, commandId);
      return outcome({ result, broadcast, before: opened.table, changed: false, row: opened.row, walletUserIds, creditUserIds });
    } catch (error) {
      if (error instanceof DuplicateCommand) {
        const adopted = await adoptPostgres(db, storage, tableId, commandId);
        return outcome({ result: { ok: true, duplicate: true }, broadcast: adopted ?? broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
      }
      if (isTransient(error)) throw new TransientDb();
      throw error;
    }
  }
  next.revision = opened.table.revision + 1;
  const commandId = resolveCommandId(request, opened.table, next);
  const prior = storedCommand(sql, commandId);
  if (prior) return outcome({ result: replay(prior.result), broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
  const already = await db.prisma.gameCommand.findUnique({ where: { id: commandId }, select: { id: true } });
  if (already) {
    const adopted = await adoptPostgres(db, storage, tableId, commandId);
    return outcome({ result: { ok: true, duplicate: true }, broadcast: adopted ?? broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
  }
  const chips = [...cashOutChips(next), ...(request.extraChips ?? [])];
  next.cashOuts = [];
  const payload: OutboxPayload = {
    commandId,
    kind: request.kind,
    userId: request.userId,
    revision: next.revision,
    ciphertext: encryptState(db.ring, next, `table:${tableId}`),
    chips,
  };
  insertPending(sql, payload.commandId, payload.kind, JSON.stringify(payload));
  try {
    await writePostgres(db, tableId, payload);
  } catch (error) {
    if (error instanceof DuplicateCommand) {
      const adopted = await adoptPostgres(db, storage, tableId, payload.commandId);
      return outcome({ result: { ok: true, duplicate: true }, broadcast: adopted ?? broadcast, before: null, changed: false, row: opened.row, walletUserIds, creditUserIds });
    }
    if (error instanceof EngineError) {
      abortOutbox(storage, payload.commandId, errorResult(error), opened.table.revision);
      return outcome({ result: errorResult(error), broadcast, before: opened.table, changed: false, row: opened.row, walletUserIds, creditUserIds });
    }
    logEvent("error", "table mutation failed", { tableId, code: prismaCode(error) });
    throw new TransientDb();
  }
  if (metaGet(sql, "testFault") === "throw-after-postgres") {
    metaSet(sql, "testFault", "");
    throw new TestFault();
  }
  const result = request.success(next);
  remember(storage, payload, result);
  return outcome({
    result,
    broadcast: next,
    before: opened.table,
    changed: true,
    row: opened.row,
    walletUserIds: [...new Set([...walletUserIds, ...chips.map((chip) => chip.userId)])],
    creditUserIds: [...creditUserIds, ...chips.filter((chip) => chip.mode === "credit").map((chip) => chip.userId)],
  });
}

export async function checkVisible(db: DbCtx, tableId: string, userId: string): Promise<void> {
  const row = await db.prisma.table.findUnique({ where: { id: tableId }, select: { status: true, isPrivate: true, hostId: true } });
  if (!row || (row.isPrivate && row.hostId !== userId && !await db.prisma.tableSeat.findFirst({ where: { tableId, userId }, select: { id: true } }))) {
    throw new EngineError("TABLE_NOT_FOUND", "Table not found");
  }
  if (row.status === "CLOSED") throw new EngineError("TABLE_CLOSED", "This table has closed");
}

export async function walletPatch(db: DbCtx, userId: string): Promise<number | null> {
  const user = await db.prisma.user.findUnique({ where: { id: userId }, select: { bankroll: true } });
  return user?.bankroll ?? null;
}
