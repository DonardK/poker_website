/**
 * Hold'em hand state machine.
 *
 *   WAITING -> PREFLOP -> FLOP -> TURN -> RIVER -> SHOWDOWN -> (Hand Clean-up) -> WAITING
 *
 * Every exported transition clones the input table, applies one validated
 * command and returns the new state (or returns the input itself when the
 * command changes nothing). The input is never mutated, so a rejected command
 * cannot leave a half-applied state. The transitions are deterministic in
 * their arguments with two exceptions: startHand draws OS entropy (the
 * shuffle) and a random UUID (the hand id), and every optional `now`
 * parameter defaults to Date.now(). The server passes `now` explicitly.
 *
 * COMPLIANCE NOTES
 * - Shuffle and commitment (startHand): the deck comes only from
 *   `shuffledDeck()` (OS CSPRNG, unbiased Fisher-Yates). Its SHA-256
 *   commitments and the audit record exist before any blind is posted or any
 *   card leaves the deck. No API accepts a caller-chosen deck or seed.
 * - Street isolation: board cards are taken from the deck only when their
 *   betting round begins (or in an all-in runout, when no betting remains).
 *   Until then they stay in the server-only `deck`.
 * - Audit: every transition appends a hash-chained event (see audit.ts).
 * - Settlement: pots are built with side pots for all-in players, 7-card hands
 *   are compared, ties split with a deterministic odd-chip rule, and the
 *   engine refuses to settle if chips are not conserved.
 * - Hand Clean-up (completeHand): purges the deck, burns, hole cards and
 *   commitments from live state after the sealed record is persisted.
 * - Table closure (closeTable / closeIfEmpty): a hand in progress is settled
 *   under the ordinary sit-out rule and sealed like any other hand, never
 *   voided or abandoned. Every player is cashed out exactly once, either at
 *   once or by Hand Clean-up, and the chip total is checked across the
 *   transition. A closing table cannot be revived.
 */
import type { Card, RakeTerms, SitOutReason, TableCloseReason } from "@poker/shared";
import {
  boardPositions, HAND_AUDIT_VERSION, handRakeTerms, holeCardPositions, NO_RAKE, TABLE_IDLE_TIMEOUT_MS, TABLE_IDLE_WARNING_MS, validRakeTerms, validVoidReason,
} from "@poker/shared";
import { burnAndDealFlop, burnAndDealOne, dealHoleCards, dealOrderFromDealer, shuffledDeck } from "./deck.js";
import { legalActions } from "./legal.js";
import { awardPots, buildSidePots, mergePotsByEligibility, returnUncalledBets, type Contribution } from "./pots.js";
import { pushLog } from "./public.js";
import { commitDeck, newHandId } from "./fairness.js";
import { appendAudit, openHandAudit, sealedAudit, sealHandAudit } from "./audit.js";
import { evaluate } from "./evaluate.js";
import {
  anyoneNeedsAction,
  contenders,
  isBlindCandidate,
  isLiveForDeal,
  liveDealSeats,
  needsAction,
  nextLiveSeat,
  nextMatching,
  nextToActSeat,
  receivesCards,
} from "./seats.js";
import {
  EngineError,
  type CreateTableConfig,
  type EngineIntent,
  type EnginePlayer,
  type EngineTable,
  type ExtraTimeBankConfig,
  type SeatPlayerConfig,
  type VoidedHand,
} from "./types.js";

const structuredClone = (globalThis as unknown as {
  structuredClone: <T>(value: T) => T;
}).structuredClone;

function cloneTable(table: EngineTable): EngineTable {
  return structuredClone(table);
}

export function createTable(cfg: CreateTableConfig): EngineTable {
  if (!Number.isInteger(cfg.maxSeats) || cfg.maxSeats < 2 || cfg.maxSeats > 9 ||
      !Number.isSafeInteger(cfg.smallBlind) || cfg.smallBlind <= 0 || cfg.smallBlind > 100_000 ||
      cfg.bigBlind !== cfg.smallBlind * 2 || !Number.isInteger(cfg.timeBankMs) || cfg.timeBankMs <= 0 ||
      (cfg.createdAt !== undefined && !Number.isFinite(cfg.createdAt)) ||
      (cfg.sitOutOnTimeout !== undefined && typeof cfg.sitOutOnTimeout !== "boolean") ||
      (cfg.extraTimeBank != null && !validTimeBank(cfg.extraTimeBank)) ||
      !validRakeTerms(rakeTermsOf(cfg))) {
    throw new EngineError("BAD_CONFIG", "Invalid table configuration");
  }
  const rake = rakeTermsOf(cfg);
  return {
    revision: 0, fairness: null, audit: null, auditChainTip: null, handChipTotal: null, dealtSeats: [], smallBlindPosition: null, actions: [], awards: [], refunds: [],
    lastActedBet: Array.from({ length: cfg.maxSeats }, () => null),
    startedAt: null, settledAt: null,
    tableId: cfg.tableId,
    name: cfg.name,
    maxSeats: cfg.maxSeats,
    smallBlind: cfg.smallBlind,
    bigBlind: cfg.bigBlind,
    timeBankMs: cfg.timeBankMs,
    // Copied, so a caller who later edits its config object cannot change a live table.
    extraTimeBank: cfg.extraTimeBank != null ? { ...cfg.extraTimeBank } : null,
    sitOutOnTimeout: cfg.sitOutOnTimeout ?? true,
    rakeBps: rake.rakeBps,
    rakeCapChips: rake.rakeCapChips,
    rakeNoFlopNoDrop: rake.rakeNoFlopNoDrop,
    rakeTaken: 0,
    status: "WAITING",
    handNumber: 0,
    phase: "WAITING",
    dealerSeat: 0,
    sbSeat: null,
    bbSeat: null,
    deck: [],
    burns: [],
    board: [],
    players: Array.from({ length: cfg.maxSeats }, () => null),
    toActSeat: null,
    currentBet: 0,
    lastFullRaiseSize: cfg.bigBlind,
    lastAggressorSeat: null,
    actedThisStreet: Array.from({ length: cfg.maxSeats }, () => false),
    pots: [],
    potTotal: 0,
    log: [],
    logSeq: 0,
    turnStartedAt: null,
    turnSeq: 0,
    winners: [],
    animToken: 0,
    cashOuts: [],
    // Creating a table is activity: the idle clock starts now.
    lastActivityAt: cfg.createdAt ?? Date.now(),
    closingAt: null,
    closeReason: null,
  };
}

/** A config's rake terms with the defaults (no rake; no flop, no drop) filled in. */
function rakeTermsOf(cfg: Pick<CreateTableConfig, "rakeBps" | "rakeCapChips" | "rakeNoFlopNoDrop">): RakeTerms {
  return {
    rakeBps: cfg.rakeBps ?? NO_RAKE.rakeBps,
    rakeCapChips: cfg.rakeCapChips ?? NO_RAKE.rakeCapChips,
    rakeNoFlopNoDrop: cfg.rakeNoFlopNoDrop ?? NO_RAKE.rakeNoFlopNoDrop,
  };
}

/** Whole, non-negative milliseconds; a pool never exceeds its cap and refills come at least every hand. */
function validTimeBank(bank: ExtraTimeBankConfig): boolean {
  const ms = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
  return typeof bank === "object" && ms(bank.initialMs) && ms(bank.maxMs) && ms(bank.refillMs) &&
    bank.initialMs <= bank.maxMs && Number.isSafeInteger(bank.refillEveryHands) && bank.refillEveryHands >= 1;
}

/** `now` (ms epoch) starts the player's own idle clock: taking a seat is activity. */
export function sitDown(table: EngineTable, seatIndex: number, cfg: SeatPlayerConfig, now = Date.now()): EngineTable {
  // A closing table's chips are on their way back to bankrolls; no new money may join.
  if (table.closeReason != null) throw tableClosing();
  const next = cloneTable(table);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= next.maxSeats) throw new EngineError("BAD_SEAT", "Invalid seat");
  if (!Number.isSafeInteger(cfg.buyIn) || cfg.buyIn <= 0 || cfg.buyIn > 2_000_000_000) throw new EngineError("BUYIN", "Invalid buy-in");
  if (next.players[seatIndex]) throw new EngineError("SEAT_TAKEN", "Seat is occupied");
  if (next.players.some((p) => p?.userId === cfg.userId)) {
    throw new EngineError("ALREADY_SEATED", "Already seated at this table");
  }
  const min = next.bigBlind * 20;
  const max = next.bigBlind * 200;
  if (!cfg.skipBuyInCheck && (cfg.buyIn < min || cfg.buyIn > max)) {
    throw new EngineError("BUYIN", `Buy-in must be between ${min} and ${max}`);
  }
  const inProgress = next.phase !== "WAITING" && next.phase !== "COMPLETE";
  // Standard entry rule: once a game is running (a hand has been played and
  // two others can play on), a newcomer waits for the big blind. They cannot
  // be dealt in on the button or between the button and the blinds for free.
  const waitingForBigBlind = next.handNumber > 0 && liveDealSeats(next).length >= 2;
  next.players[seatIndex] = {
    seatIndex,
    userId: cfg.userId,
    username: cfg.username,
    avatarHue: cfg.avatarHue,
    kind: cfg.kind,
    botProfile: cfg.botProfile,
    stack: cfg.buyIn,
    holeCards: null,
    status: inProgress ? "SIT_OUT" : "ACTIVE",
    committedThisStreet: 0,
    committedThisHand: 0,
    sittingOut: false,
    sittingOutReason: null,
    showedCards: false,
    handResult: null,
    pendingLeave: false,
    waitingForBigBlind,
    missedBlind: false,
    lastActivityAt: now,
    extraTimeMs: next.extraTimeBank?.initialMs ?? 0,
    handsSinceRefill: 0,
  };
  pushLog(next, seatIndex, `${cfg.username} sits with ${cfg.buyIn}`);
  next.animToken += 1;
  return next;
}

const SIT_OUT_REASONS: ReadonlySet<unknown> = new Set<SitOutReason>(["SELF", "TIMEOUT", "DISCONNECTED", "CLOSING"]);

/**
 * Sit a player out. `reason` is shown to clients (sittingOutReason): SELF for
 * the player's own request; the server passes DISCONNECTED when it sits out a
 * player whose connection dropped. A player already sitting out is returned
 * unchanged, keeping the reason they were first sat out for.
 */
export function sitOut(table: EngineTable, userId: string, now = Date.now(), reason: SitOutReason = "SELF"): EngineTable {
  if (!SIT_OUT_REASONS.has(reason)) throw new EngineError("BAD_REASON", "Invalid sit-out reason");
  // A repeated toggle changes nothing: no audit event, no new revision.
  if (requirePlayer(table, userId).sittingOut) return table;
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = true;
  player.sittingOutReason = reason;
  if (next.phase === "WAITING" || next.phase === "COMPLETE") player.status = "SIT_OUT";
  pushLog(next, player.seatIndex, `${player.username} sits out`);
  auditStatus(next, player, "SIT_OUT", now);
  if (next.toActSeat === player.seatIndex && player.status === "ACTIVE") return autoAct(next, now, "SIT_OUT");
  return next;
}

export function sitIn(table: EngineTable, userId: string, now = Date.now()): EngineTable {
  // Sitting in would cancel the pending leave closeTable set; closure is final.
  if (table.closeReason != null) throw tableClosing();
  if (!requirePlayer(table, userId).sittingOut) return table;
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = false;
  player.sittingOutReason = null;
  // Sitting back in cancels a pending leave. The player stays seated and acts
  // for themselves again (a hand already folded for them stays folded).
  player.pendingLeave = false;
  // Blinds passed while away: play resumes when the big blind comes round.
  if (player.missedBlind === true) {
    player.missedBlind = false;
    player.waitingForBigBlind = true;
  }
  if (next.phase === "WAITING" || next.phase === "COMPLETE") player.status = "ACTIVE";
  pushLog(next, player.seatIndex, `${player.username} sits in`);
  auditStatus(next, player, "SIT_IN", now);
  return next;
}

export function leaveSeat(table: EngineTable, userId: string, now = Date.now()): EngineTable {
  if (requirePlayer(table, userId).pendingLeave) return table;
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  if (bettingInProgress(next) && player.holeCards !== null) {
    // Leaving is the player's own choice; one already sitting out keeps their reason.
    if (!player.sittingOut) player.sittingOutReason = "SELF";
    player.sittingOut = true;
    player.pendingLeave = true;
    pushLog(next, player.seatIndex, `${player.username} leaves the table`);
    auditStatus(next, player, "LEAVE", now);
    next.animToken += 1;
    // All-in hands remain eligible. Other leavers fold on their own turn
    // (see autoAct). Folding out of turn could strand a side pot with no
    // eligible player.
    if (next.toActSeat === player.seatIndex && player.status === "ACTIVE") return autoAct(next, now, "LEAVE");
    return next;
  }
  // Log first: pushLog labels the entry with the seated player's name.
  pushLog(next, player.seatIndex, `${player.username} leaves the table`);
  next.cashOuts.push({ userId: player.userId, stack: player.stack });
  next.players[player.seatIndex] = null;
  next.animToken += 1;
  return next;
}

export function startHand(table: EngineTable, now = Date.now()): EngineTable {
  if (table.phase !== "WAITING" && table.phase !== "COMPLETE") throw new EngineError("IN_HAND", "Hand already in progress");
  // No hand is dealt while the idle warning is up or once closure has begun:
  // a closing table must not put players' chips back at risk.
  if (table.closeReason != null || table.closingAt != null) throw tableClosing();
  const next = upgradeTableState(cloneTable(table), { fallbackActivityAt: now }).table;
  // The terms are written into HAND_STARTED and govern the hand's settlement.
  if (!validRakeTerms({ rakeBps: next.rakeBps, rakeCapChips: next.rakeCapChips, rakeNoFlopNoDrop: next.rakeNoFlopNoDrop })) {
    throw new EngineError("BAD_CONFIG", "Invalid rake configuration");
  }
  if (next.players.filter((p) => isBlindCandidate(p)).length < 2) throw new EngineError("NOT_ENOUGH_PLAYERS", "Need at least two players with chips");
  // Waiting for the big blind only matters while a game can run without you.
  if (liveDealSeats(next).length < 2) {
    for (const p of next.players) if (isBlindCandidate(p)) p.waitingForBigBlind = false;
  }

  for (const p of next.players) {
    if (!p) continue;
    p.committedThisStreet = 0;
    p.committedThisHand = 0;
    p.holeCards = null;
    p.showedCards = false;
    p.handResult = null;
    if (p.stack <= 0) {
      p.status = "ELIMINATED";
      continue;
    }
    if (p.sittingOut || p.waitingForBigBlind) {
      p.status = "SIT_OUT";
      continue;
    }
    p.status = "ACTIVE";
  }

  next.handNumber += 1;
  next.phase = "PREFLOP";
  next.actions = [];
  next.awards = [];
  next.refunds = [];
  next.log = [];
  next.startedAt = now;
  next.settledAt = null;
  next.winners = [];
  next.board = [];
  next.burns = [];
  next.pots = [];
  next.potTotal = 0;
  next.rakeTaken = 0;
  next.lastAggressorSeat = null;
  next.audit = null;
  assignButtonAndBlinds(next);

  // Seats dealt in, in deal order: first card to the seat left of the button
  // (the big blind heads-up).
  next.dealtSeats = dealOrderFromDealer(next.dealerSeat, next.maxSeats,
    next.players.map((player, seat) => receivesCards(player) ? seat : -1).filter((seat) => seat >= 0));
  next.handChipTotal = next.dealtSeats.reduce((sum, seat) => sum + next.players[seat]!.stack, 0);
  if (next.extraTimeBank) refillTimeBanks(next, next.extraTimeBank);

  // 1. Shuffle with the OS CSPRNG. 2. Commit to the full deck order with
  // SHA-256. 3. Open the audit record. All three happen before any blind is
  // posted or any card is dealt. The record is HAND_AUDIT_VERSION (v2): it
  // also fixes the hand's rake terms (settlement reads them back from here)
  // and the turn clock it starts with: the base turn time and, with a
  // personal time bank, each dealt seat's pool after this hand's refill.
  next.fairness = commitDeck(shuffledDeck(), next.tableId, next.handNumber, newHandId());
  next.deck = [...next.fairness.deck];
  openHandAudit(next, next.fairness, now, {
    rakeBps: next.rakeBps,
    rakeCapChips: next.rakeCapChips,
    rakeNoFlopNoDrop: next.rakeNoFlopNoDrop,
    turnTimeMs: next.timeBankMs,
    timeBankPools: next.extraTimeBank
      ? next.dealtSeats.map((seat) => ({ seatIndex: seat, extraTimeMs: next.players[seat]!.extraTimeMs }))
      : null,
    maxSeats: next.maxSeats,
    smallBlind: next.smallBlind,
    bigBlind: next.bigBlind,
    dealerSeat: next.dealerSeat,
    sbSeat: next.sbSeat,
    bbSeat: next.bbSeat,
    dealtSeats: [...next.dealtSeats],
    seats: next.dealtSeats.map((seat) => {
      const p = next.players[seat]!;
      return { seatIndex: seat, userId: p.userId, username: p.username, kind: p.kind, stack: p.stack };
    }),
    chipTotal: next.handChipTotal,
  });

  postBlind(next, next.sbSeat, next.smallBlind, "small blind", now);
  postBlind(next, next.bbSeat, next.bigBlind, "big blind", now);
  dealHoles(next, now);
  beginStreet(next, "PREFLOP", now);
  next.status = "IN_HAND";
  pushLog(next, null, `Hand #${next.handNumber}`);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

export function applyAction(table: EngineTable, userId: string, intent: EngineIntent, now = Date.now()): EngineTable {
  if (intent.amount !== undefined && (!Number.isSafeInteger(intent.amount) || intent.amount <= 0)) {
    throw new EngineError("BAD_AMOUNT", "Amount must be a positive whole number of chips");
  }
  const next = cloneTable(table);
  if (next.toActSeat == null) throw new EngineError("NO_TURN", "No one to act");
  const player = next.players[next.toActSeat];
  if (!player || player.userId !== userId) throw new EngineError("NOT_YOUR_TURN", "Not your turn");
  const legal = legalActions(next, player.seatIndex);
  if (!legal || !legal.actions.includes(intent.action)) {
    throw new EngineError("ILLEGAL", "That action is not legal");
  }
  const before = player.committedThisStreet;
  executeIntent(next, player, intent, legal);
  chargeTurnClock(next, player, now);
  recordAction(next, player, intent.action, player.committedThisStreet - before, now);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

/**
 * The acting player's time expired: check if free, otherwise fold. With
 * sitOutOnTimeout (the default) a human is also sat out (reason TIMEOUT): the
 * sat-out cascade acts for them for the rest of the hand, and they are not
 * dealt in again until they sit in (missed blinds then apply as usual). So a
 * player who has walked away loses at most the hand they timed out in instead
 * of being blinded off. A time-out is never activity: the idle clocks do not move.
 */
export function applyTimeout(table: EngineTable, now = Date.now()): EngineTable {
  return autoAct(table, now, "TIMEOUT");
}

/**
 * Restart the pending actor's base clock at `now` after server downtime, so a
 * restart cannot time a player out at once for time they could not use. The
 * actor's personal time bank is not charged for the downtime (nor for the
 * part of the turn before it). It starts a new turn (new turnId) and appends
 * a TURN_CLOCK_RESET audit event. No one to act: the input is returned unchanged.
 */
export function rebaseTurnClock(table: EngineTable, now: number, reason: "SERVER_RESUME"): EngineTable {
  if (reason !== "SERVER_RESUME") throw new EngineError("BAD_REASON", "Invalid clock reset reason");
  if (!Number.isSafeInteger(now)) throw new EngineError("BAD_TIME", "Invalid time");
  if (table.toActSeat == null || !bettingInProgress(table)) return table;
  const next = cloneTable(table);
  const seatIndex = next.toActSeat!;
  startTurn(next, now);
  appendAudit(next, "TURN_CLOCK_RESET", { seatIndex, reason }, now);
  return next;
}

/** A new turn begins for `table.toActSeat` (or none): restart the base clock and give the turn a new identity. */
function startTurn(table: EngineTable, now: number): void {
  if (table.toActSeat == null) {
    table.turnStartedAt = null;
    return;
  }
  table.turnStartedAt = now;
  table.turnSeq = (Number.isSafeInteger(table.turnSeq) ? table.turnSeq : 0) + 1;
}

/**
 * The actor's turn is over: time used beyond the base clock comes out of
 * their personal time bank, which never goes below zero. Without a time bank
 * nothing changes, so timing is exactly the base clock.
 */
function chargeTurnClock(table: EngineTable, player: EnginePlayer, now: number): void {
  if (!table.extraTimeBank || table.turnStartedAt == null || table.toActSeat !== player.seatIndex) return;
  const over = Math.ceil(now - table.turnStartedAt - table.timeBankMs);
  if (over > 0) player.extraTimeMs = Math.max(0, player.extraTimeMs - over);
}

/** Every dealt player's hand counts toward their next refill: `refillMs` every `refillEveryHands` hands, capped at `maxMs`. */
function refillTimeBanks(table: EngineTable, bank: ExtraTimeBankConfig): void {
  for (const seat of table.dealtSeats) {
    const p = table.players[seat]!;
    p.handsSinceRefill += 1;
    if (p.handsSinceRefill < bank.refillEveryHands) continue;
    p.handsSinceRefill = 0;
    p.extraTimeMs = Math.min(bank.maxMs, p.extraTimeMs + bank.refillMs);
  }
}

/**
 * Sit out a human whose turn just timed out (EngineTable.sitOutOnTimeout).
 * Recorded like a sit-out (log and PLAYER_STATUS) right after the time-out
 * action, before the hand moves on. Bots never walk away, so they are never
 * sat out by the clock (nothing would sit them back in).
 */
function sitOutAfterTimeout(table: EngineTable, player: EnginePlayer, now: number): void {
  if (table.sitOutOnTimeout === false || player.kind !== "HUMAN" || player.sittingOut) return;
  player.sittingOut = true;
  player.sittingOutReason = "TIMEOUT";
  pushLog(table, player.seatIndex, `${player.username} sits out`);
  auditStatus(table, player, "SIT_OUT", now);
}

type AutoReason = "TIMEOUT" | "SIT_OUT" | "LEAVE";
const AUTO_SUFFIX: Record<AutoReason, string> = { TIMEOUT: " (time)", SIT_OUT: " (sitting out)", LEAVE: " (leaving)" };

/**
 * Act for a player who cannot act themselves. The audit records the true
 * reason: TIMEOUT_CHECK / TIMEOUT_FOLD only when the time bank expired.
 * Otherwise it records CHECK / FOLD with `auto: "SIT_OUT" | "LEAVE"`.
 *
 * A player who asked to leave FOLDS on their turn, even when a check is free,
 * so a hand they abandoned is never carried to showdown and tabled. The one
 * exception is when folding would leave a pot they contributed to with no
 * eligible player; then they check.
 */
function autoAct(table: EngineTable, now: number, reason: AutoReason): EngineTable {
  const next = cloneTable(table);
  if (next.toActSeat == null) return next;
  const player = next.players[next.toActSeat];
  if (!player) return next;
  const legal = legalActions(next, player.seatIndex);
  const before = player.committedThisStreet;
  // The turn ends now, whoever ended it; a cascade auto-act starts and ends at the same instant.
  chargeTurnClock(next, player, now);
  const leaverFolds = reason === "LEAVE" && foldKeepsEveryPotContested(next, player);
  let folded = false;
  if (!leaverFolds && legal?.actions.includes("CHECK")) {
    executeIntent(next, player, { action: "CHECK" }, legal);
  } else if (legal?.actions.includes("FOLD")) {
    executeIntent(next, player, { action: "FOLD" }, legal);
    folded = true;
  } else {
    player.status = "FOLDED";
    next.actedThisStreet[player.seatIndex] = true;
    pushLog(next, player.seatIndex, `${player.username} folds`);
    folded = true;
  }
  const last = next.log[next.log.length - 1];
  if (last && !last.text.endsWith(AUTO_SUFFIX[reason])) last.text = `${last.text}${AUTO_SUFFIX[reason]}`;
  const action = reason === "TIMEOUT" ? (folded ? "TIMEOUT_FOLD" : "TIMEOUT_CHECK") : (folded ? "FOLD" : "CHECK");
  recordAction(next, player, action, player.committedThisStreet - before, now, reason === "TIMEOUT" ? null : reason);
  if (reason === "TIMEOUT") sitOutAfterTimeout(next, player, now);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

/**
 * Folding `player` keeps every pot contested if another live player has
 * committed at least as much. Every pot level `player` is eligible for then
 * keeps an eligible player.
 */
function foldKeepsEveryPotContested(table: EngineTable, player: EnginePlayer): boolean {
  return table.players.some((p) => p !== null && p !== player && (p.status === "ACTIVE" || p.status === "ALL_IN") &&
    p.committedThisHand >= player.committedThisHand);
}

/**
 * Hand Clean-up: SHOWDOWN -> WAITING.
 *
 * COMPLIANCE NOTE: the server persists the sealed audit record in the same
 * transaction that enters SHOWDOWN. Clean-up then purges the deck, burns,
 * hole cards, salts and commitments from live state. Between hands the table
 * holds no card secrets, and the public view shows no cards.
 */
export function completeHand(table: EngineTable): EngineTable {
  if (table.phase !== "SHOWDOWN" && table.phase !== "COMPLETE") throw new EngineError("IN_HAND", "Cannot complete an unsettled hand");
  const next = cloneTable(table);
  cleanUp(next);
  return next;
}

/** Hand Clean-up proper: purge the hand, then cash out leavers and busted players (in place). */
function cleanUp(table: EngineTable): void {
  purgeHandState(table);
  for (const p of table.players) {
    if (!p) continue;
    if (p.pendingLeave) {
      table.cashOuts.push({ userId: p.userId, stack: p.stack });
      table.players[p.seatIndex] = null;
      continue;
    }
    if (p.stack <= 0) {
      table.cashOuts.push({ userId: p.userId, stack: 0 });
      table.players[p.seatIndex] = null;
    }
  }
}

/**
 * Staff recovery: void the hand in progress.
 *
 * COMPLIANCE NOTE (voided hand): nobody wins or loses anything. Every chip
 * committed to the hand (blinds, bets, calls) goes back to the player who
 * put it in, so every final stack equals its starting stack and no rake is
 * taken. The audit trail records it rather than hiding it: HAND_VOIDED
 * {reason} and then HAND_SETTLED {reason: "void", board, starting stacks},
 * with no showdown and no awards, sealed like any other hand so it verifies
 * and the table's hash chain continues through it. The table is then left
 * exactly as Hand Clean-up leaves it (no card secrets, pending leavers
 * cashed out). The sealed record and its deck secrets are returned for the
 * server to persist, because Clean-up has already removed them from the
 * table. Pure: the input is never mutated.
 *
 * Refused (EngineError) when no hand is in progress (between hands, or
 * already settled: a settled hand is final), for a blank or over-long
 * reason (it is public in every participant's audit, so it must not carry
 * private detail), and for a hand dealt under a v1 audit record, which
 * cannot express a void; such a hand can only be played to its end.
 */
export function voidHand(table: EngineTable, now: number, reason: string): VoidedHand {
  if (!bettingInProgress(table)) throw new EngineError("NO_HAND", "No hand is in progress");
  if (!validVoidReason(reason)) throw new EngineError("BAD_REASON", "A void needs a short, printable reason");
  if (!Number.isSafeInteger(now)) throw new EngineError("BAD_TIME", "Invalid time");
  if (table.audit && table.audit.version !== HAND_AUDIT_VERSION) {
    throw new EngineError("AUDIT_VERSION", "This hand was dealt under an audit format that cannot record a void");
  }
  const chipsBefore = chipsOnTable(table);
  const next = cloneTable(table);
  const handNumber = next.handNumber;
  const returned = next.dealtSeats.map((seat) => {
    const p = next.players[seat]!;
    return { seatIndex: seat, userId: p.userId, amount: p.committedThisHand };
  });
  for (const p of next.players) {
    if (!p) continue;
    p.stack += p.committedThisHand;
    p.committedThisHand = 0;
    p.committedThisStreet = 0;
  }
  const stacks = next.dealtSeats.map((seat) => ({ seatIndex: seat, stack: next.players[seat]!.stack }));
  const chipTotal = stacks.reduce((sum, row) => sum + row.stack, 0);
  if (next.handChipTotal != null && chipTotal !== next.handChipTotal) {
    throw new EngineError("CHIP_INVARIANT", `Void did not restore the starting stacks: ${chipTotal} now, ${next.handChipTotal} at hand start`);
  }
  next.toActSeat = null;
  next.turnStartedAt = null;
  // Both events carry the street the hand was stopped on (nothing was shown down).
  appendAudit(next, "HAND_VOIDED", { reason }, now);
  appendAudit(next, "HAND_SETTLED", { reason: "void", board: [...next.board], stacks, chipTotal }, now);
  sealHandAudit(next, now);
  const record = next.audit ? structuredClone(next.audit) : null;
  const sealed = next.fairness ? sealedAudit(next.fairness) : null;
  cleanUp(next);
  pushLog(next, null, `Hand #${handNumber} was voided; all bets were returned`);
  next.animToken += 1;
  if (chipsOnTable(next) !== chipsBefore) {
    throw new EngineError("CHIP_INVARIANT", `Chip conservation failed while voiding: ${chipsOnTable(next)} after, ${chipsBefore} before`);
  }
  return { table: next, handNumber, record, sealed, returned };
}

/** Remove every trace of the finished hand from live state (Hand Clean-up). */
function purgeHandState(table: EngineTable): void {
  table.phase = "WAITING";
  table.status = "WAITING";
  table.toActSeat = null;
  table.turnStartedAt = null;
  table.deck = [];
  table.burns = [];
  table.board = [];
  table.fairness = null;
  table.audit = null;
  table.handChipTotal = null;
  table.dealtSeats = [];
  table.pots = [];
  table.potTotal = 0;
  table.rakeTaken = 0;
  table.currentBet = 0;
  table.winners = [];
  table.actions = [];
  table.awards = [];
  table.refunds = [];
  // The hand's log (with its board cards) was persisted with the hand history.
  table.log = [];
  for (const p of table.players) {
    if (!p) continue;
    p.holeCards = null;
    p.handResult = null;
    p.showedCards = false;
    p.committedThisStreet = 0;
    p.committedThisHand = 0;
  }
}

// ---------------------------------------------------------------------------
// Table lifecycle: idle clock, idle warning, closure
//
// The server decides WHEN (its timers are advisory; every decision is
// re-checked under the table's row lock on fresh state). These transitions
// decide WHAT happens to seats, hands and chips.
// ---------------------------------------------------------------------------

function tableClosing(): EngineError {
  return new EngineError("TABLE_CLOSING", "This table is closing");
}

/**
 * A voluntary player action: restart the idle clock and cancel an idle
 * warning. The server calls it only for a human's own action (see
 * EngineTable.lastActivityAt), naming that player as `userId` so their own
 * clock restarts too (see idleSince). Time-outs, bots and dealing never call
 * it, so a table of AFK players whose hands keep timing out still goes idle.
 * Closure, once begun, cannot be undone: the input is then returned unchanged.
 */
export function recordActivity(table: EngineTable, now = Date.now(), userId?: string): EngineTable {
  if (table.closeReason != null) return table;
  const next = cloneTable(table);
  next.lastActivityAt = now;
  next.closingAt = null;
  const player = userId === undefined ? undefined : next.players.find((p) => p?.userId === userId);
  if (player) player.lastActivityAt = now;
  return next;
}

/**
 * When this table last saw activity that still counts: the latest own
 * activity of the humans still at it (seated and not leaving), or, with no
 * such human, the table's own clock. So an outsider who takes a seat and
 * leaves again, or a player who acted and then left, no longer keeps an AFK
 * table open, while a newcomer who stays does. Bots never count. A legacy
 * player without a clock of their own counts from the table's.
 */
export function idleSince(table: EngineTable): number {
  let since: number | null = null;
  for (const p of table.players) {
    if (!p || p.kind !== "HUMAN" || p.pendingLeave) continue;
    const own = Number.isFinite(p.lastActivityAt) ? p.lastActivityAt : table.lastActivityAt;
    since = since === null ? own : Math.max(since, own);
  }
  return since ?? table.lastActivityAt;
}

/**
 * Drop an idle warning without touching anything else (the clocks, the
 * hand, the log): the server uses it for a warning that began before it
 * restarted, since downtime is not the players' inactivity. No warning, or a
 * closure already begun: the input is returned unchanged.
 */
export function clearIdleWarning(table: EngineTable): EngineTable {
  if (table.closingAt == null || table.closeReason != null) return table;
  const next = cloneTable(table);
  next.closingAt = null;
  return next;
}

/**
 * "I'm still here" from the idle warning. Only a seated human who is not
 * leaving may keep a table open. A spectator, a bot or a departing player
 * cannot hold everyone else's chips at an abandoned table. Without an active
 * warning nothing changes (same object, so no new revision).
 */
export function keepTableOpen(table: EngineTable, userId: string, now = Date.now()): EngineTable {
  if (table.closeReason != null) throw tableClosing();
  const player = table.players.find((p) => p?.userId === userId);
  if (!player || player.kind !== "HUMAN" || player.pendingLeave) {
    throw new EngineError("NOT_SEATED", "Only seated players can keep the table open");
  }
  if (table.closingAt == null) return table;
  const next = recordActivity(table, now, userId);
  pushLog(next, player.seatIndex, `${player.username} is back — the table stays open`);
  return next;
}

/**
 * Start the idle warning: the table closes at `closesAt` unless a player acts
 * first. The caller has established that the idle timeout has passed. A hand
 * in progress is untouched (no card, bet, turn or audit event changes); the
 * server just deals no new hand while the warning is up.
 */
export function beginIdleWarning(table: EngineTable, closesAt: number): EngineTable {
  if (table.closeReason != null || table.closingAt != null) return table;
  const next = cloneTable(table);
  next.closingAt = closesAt;
  pushLog(next, null,
    `No activity for ${TABLE_IDLE_TIMEOUT_MS / 60_000} minutes — the table closes in ${TABLE_IDLE_WARNING_MS / 1_000} seconds unless a player acts`);
  return next;
}

/**
 * Begin closing the table. It becomes CLOSED as soon as it is empty.
 *
 * COMPLIANCE NOTE (closure): chips are never created, lost or paid twice.
 * - Between hands every player is cashed out now and the table is CLOSED.
 * - A hand in progress is FINISHED, not voided. It has a pre-deal commitment
 *   and an audit trail, so it settles by the ordinary rules and its sealed
 *   record verifies like any other hand:
 *   1. players not dealt in are cashed out at once (as leaveSeat does);
 *   2. every dealt player is sat out, with a PLAYER_STATUS audit event (as
 *      sitOut does). They are all marked BEFORE anyone acts, so
 *   3. one auto-action by the current actor lets the existing cascade
 *      (progressAfterAction) auto-act every remaining actor until the hand
 *      settles: check when free, otherwise fold; a player who already asked
 *      to leave folds, as always. All-in players keep their claim on the pots.
 *   A dealt seat is never released here: the server records the hand's
 *   players from the seats in the transaction that enters SHOWDOWN.
 * - At SHOWDOWN every remaining player is marked as leaving. Hand Clean-up
 *   (completeHand) cashes each of them out once, and the server's
 *   closeIfEmpty then closes the empty table.
 * - The chips the table is responsible for (stacks, the unsettled pot and
 *   unpaid cash-outs) are counted before and after. A mismatch, or a hand
 *   that does not settle, throws, so the transaction rolls back and nothing
 *   is paid.
 */
export function closeTable(table: EngineTable, reason: TableCloseReason, now = Date.now()): EngineTable {
  if (table.closeReason != null || table.status === "CLOSED") return table;
  const chipsBefore = chipsOnTable(table);
  let next = cloneTable(table);
  next.closingAt = null;
  next.closeReason = reason;
  next.animToken += 1;
  pushLog(next, null, reason === "IDLE" ? "The table is closing for inactivity" : "The table is closing");
  if (bettingInProgress(next)) {
    // 1. Not dealt in (sitting out, waiting for the big blind, busted): nothing at stake.
    for (const p of next.players) if (p && p.holeCards === null) cashOutNow(next, p);
    // 2. Every dealt player sits out first, so the cascade below acts for all of them.
    for (const p of next.players) {
      if (!p || p.sittingOut) continue;
      p.sittingOut = true;
      p.sittingOutReason = "CLOSING";
      pushLog(next, p.seatIndex, `${p.username} sits out`);
      auditStatus(next, p, "SIT_OUT", now);
    }
    // 3. One auto-action; progressAfterAction auto-acts every later sat-out actor.
    const actor = next.toActSeat != null ? next.players[next.toActSeat] : null;
    if (actor?.status === "ACTIVE") next = autoAct(next, now, actor.pendingLeave ? "LEAVE" : "SIT_OUT");
    else progressAfterAction(next, now);
    if (next.phase !== "SHOWDOWN") throw new EngineError("CLOSE_FAILED", `The hand in progress could not be settled (${next.phase})`);
  }
  if (next.phase === "SHOWDOWN") {
    // Settled: Hand Clean-up pays everyone. Seats stay until then (hand history).
    for (const p of next.players) {
      if (!p) continue;
      if (!p.sittingOut) p.sittingOutReason = "CLOSING";
      p.pendingLeave = true;
      p.sittingOut = true;
    }
  } else {
    for (const p of next.players) if (p) cashOutNow(next, p);
    markClosed(next);
  }
  // A hand settled here may have been raked: those chips left the table legitimately.
  const raked = bettingInProgress(table) && next.phase === "SHOWDOWN" ? next.rakeTaken : 0;
  const chipsAfter = chipsOnTable(next) + raked;
  if (chipsAfter !== chipsBefore) {
    throw new EngineError("CHIP_INVARIANT", `Chip conservation failed while closing: ${chipsAfter} after, ${chipsBefore} before`);
  }
  return next;
}

/**
 * Every seat is empty and no hand is running: the table is CLOSED, with
 * reason EMPTY unless closure had already begun for another reason. The
 * server applies this to every committed mutation, so a host who leaves a
 * table nobody joined, or the last player to leave any table, closes it in
 * that same transaction. Otherwise the input is returned unchanged.
 */
export function closeIfEmpty(table: EngineTable): EngineTable {
  if (table.status === "CLOSED" || (table.phase !== "WAITING" && table.phase !== "COMPLETE") || table.players.some((p) => p != null)) return table;
  const next = cloneTable(table);
  markClosed(next);
  return next;
}

function markClosed(table: EngineTable): void {
  table.status = "CLOSED";
  table.closingAt = null;
  table.closeReason ??= "EMPTY";
  pushLog(table, null, "Table closed");
}

/** Release a seat whose player holds no cards in a running hand, returning the whole stack. */
function cashOutNow(table: EngineTable, player: EnginePlayer): void {
  // Log first: pushLog labels the entry with the seated player's name.
  pushLog(table, player.seatIndex, `${player.username} leaves the table`);
  table.cashOuts.push({ userId: player.userId, stack: player.stack });
  table.players[player.seatIndex] = null;
}

/** Chips the table is answerable for: stacks, an unsettled pot, and cash-outs not yet paid. */
function chipsOnTable(table: EngineTable): number {
  const unsettled = bettingInProgress(table);
  return table.players.reduce((sum, p) => sum + (p ? p.stack + (unsettled ? p.committedThisHand : 0) : 0), 0) +
    table.cashOuts.reduce((sum, cash) => sum + cash.stack, 0);
}

/**
 * Bring table state saved by an earlier engine version up to this model.
 * The upgrade is deterministic and idempotent. The server applies it on
 * every load; on current state it changes nothing.
 * - Missing fields get their defaults. The retired pre-deal seed protocol,
 *   including its server seed, is dropped. A table saved before the idle
 *   clock existed starts it at `fallbackActivityAt` (the server passes the
 *   row's last update, so a long-abandoned table does not get a fresh five
 *   minutes on every load), or now. It is open, with no warning pending. A
 *   seated player saved without a clock of their own gets the table's.
 * - WAITING state that still holds the previous hand's cards, log or
 *   commitments is purged (old versions did not purge at clean-up).
 * - A legacy hand already settled (SHOWDOWN) was recorded by the old server,
 *   so it simply runs Hand Clean-up.
 * - A legacy hand still in progress has no pre-deal commitment or audit
 *   trail, so it can never be verified. It is VOIDED: every bet is returned,
 *   the standard rule for a hand interrupted by a system change. Players who
 *   were leaving are cashed out. `voidedHand` reports its number so the
 *   server can log it.
 */
export function upgradeTableState(table: EngineTable, options: { fallbackActivityAt?: number } = {}): { table: EngineTable; voidedHand: number | null } {
  const t = table as EngineTable & { pendingShuffle?: unknown };
  delete t.pendingShuffle;
  t.audit ??= null;
  t.auditChainTip ??= null;
  t.handChipTotal ??= null;
  t.smallBlindPosition ??= null;
  t.dealtSeats ??= [];
  t.closingAt ??= null;
  t.closeReason ??= null;
  t.extraTimeBank ??= null;
  if (typeof t.sitOutOnTimeout !== "boolean") t.sitOutOnTimeout = true;
  // Saved before rake existed: such a table never raked, so it keeps not raking.
  t.rakeBps ??= NO_RAKE.rakeBps;
  t.rakeCapChips ??= NO_RAKE.rakeCapChips;
  t.rakeNoFlopNoDrop ??= NO_RAKE.rakeNoFlopNoDrop;
  t.rakeTaken ??= 0;
  if (!Number.isSafeInteger(t.turnSeq) || t.turnSeq < 0) t.turnSeq = 0;
  if (typeof t.lastActivityAt !== "number" || !Number.isFinite(t.lastActivityAt)) t.lastActivityAt = options.fallbackActivityAt ?? Date.now();
  for (const p of t.players) {
    if (!p) continue;
    p.waitingForBigBlind ??= false;
    p.missedBlind ??= false;
    // Saved before reasons were recorded: the reason a sat-out player left is unknown.
    if (p.sittingOutReason === undefined) p.sittingOutReason = null;
    if (!Number.isSafeInteger(p.extraTimeMs) || p.extraTimeMs < 0) p.extraTimeMs = t.extraTimeBank?.initialMs ?? 0;
    if (!Number.isSafeInteger(p.handsSinceRefill) || p.handsSinceRefill < 0) p.handsSinceRefill = 0;
    // A player seated before per-player clocks existed last counted as active with the table.
    if (typeof p.lastActivityAt !== "number" || !Number.isFinite(p.lastActivityAt)) p.lastActivityAt = t.lastActivityAt;
  }
  if (t.audit !== null) return { table: t, voidedHand: null };
  if (bettingInProgress(t)) {
    const handNumber = t.handNumber;
    for (const p of t.players) if (p) p.stack += p.committedThisHand;
    t.phase = "SHOWDOWN";
    const voided = completeHand(t);
    pushLog(voided, null, `Hand #${handNumber} was voided during a system upgrade; all bets were returned`);
    return { table: voided, voidedHand: handNumber };
  }
  if (t.phase === "SHOWDOWN") return { table: completeHand(t), voidedHand: null };
  const leftovers = t.fairness !== null || t.board.length > 0 || t.deck.length > 0 || t.burns.length > 0 || t.players.some((p) => p?.holeCards);
  if (leftovers) purgeHandState(t);
  return { table: t, voidedHand: null };
}

function requirePlayer(table: EngineTable, userId: string): EnginePlayer {
  const player = table.players.find((p) => p?.userId === userId);
  if (!player) throw new EngineError("NOT_SEATED", "You are not seated");
  return player;
}

/**
 * Button and blinds for the next hand (forward-moving big blind, dead button,
 * dead small blind).
 * - The big blind moves to the next player in line. If that player is
 *   waiting for the big blind, they are dealt in now and post it.
 * - The small blind is the previous big blind, or dead if that player is
 *   gone or sitting out.
 * - The button goes to the seat where the previous small blind was due. If
 *   that seat has emptied, the button is dead.
 * - Heads-up, the button posts the small blind and the other player the big
 *   blind.
 * - Sitting-out players whose blinds are skipped are marked as owing them
 *   (missedBlind).
 */
function assignButtonAndBlinds(table: EngineTable): void {
  const previousBB = table.bbSeat;
  const previousSBPosition = table.smallBlindPosition ?? null;
  const continuing = table.handNumber > 1 && previousBB != null;
  let nextBB: number | null = null;
  if (continuing) {
    nextBB = nextMatching(table, previousBB, (p) => isBlindCandidate(p));
    const incoming = nextBB == null ? null : table.players[nextBB];
    if (incoming?.waitingForBigBlind) {
      incoming.waitingForBigBlind = false;
      incoming.status = "ACTIVE";
    }
    markMissedBlinds(table, previousBB, nextBB);
  }
  const live = liveDealSeats(table);

  if (live.length === 2) {
    table.bbSeat = continuing ? nextLiveSeat(table, previousBB!) : nextLiveSeat(table, live[0]!);
    table.dealerSeat = live.find((seat) => seat !== table.bbSeat)!;
    table.sbSeat = table.dealerSeat;
    table.smallBlindPosition = table.dealerSeat;
  } else if (continuing) {
    table.bbSeat = nextBB;
    table.sbSeat = isLiveForDeal(table.players[previousBB!]) ? previousBB : null;
    table.smallBlindPosition = previousBB;
    const fallback = (previousBB! - 1 + table.maxSeats) % table.maxSeats;
    table.dealerSeat = previousSBPosition !== null && previousSBPosition !== table.bbSeat && previousSBPosition !== previousBB
      ? previousSBPosition
      : fallback;
  } else {
    table.dealerSeat = live[0]!;
    table.sbSeat = nextLiveSeat(table, table.dealerSeat);
    table.bbSeat = table.sbSeat != null ? nextLiveSeat(table, table.sbSeat) : null;
    table.smallBlindPosition = table.sbSeat;
  }
  if (table.bbSeat == null || !isLiveForDeal(table.players[table.bbSeat])) {
    throw new EngineError("BLINDS", "Could not place blinds");
  }
}

/**
 * Sitting-out players whose blinds this hand skips owe them. That is the
 * previous big blind, whose small blind is now dead, and every seat the big
 * blind passes. They wait for the big blind when they return.
 */
function markMissedBlinds(table: EngineTable, previousBB: number, nextBB: number | null): void {
  const owes = (seat: number): void => {
    const p = table.players[seat];
    if (p && p.sittingOut && p.stack > 0) p.missedBlind = true;
  };
  owes(previousBB);
  if (nextBB == null) return;
  for (let seat = (previousBB + 1) % table.maxSeats; seat !== nextBB; seat = (seat + 1) % table.maxSeats) owes(seat);
}

function postBlind(table: EngineTable, seat: number | null, amount: number, label: string, now: number): void {
  if (seat == null) return;
  const player = table.players[seat];
  if (!player) return;
  const pay = Math.min(player.stack, amount);
  player.stack -= pay;
  player.committedThisStreet += pay;
  player.committedThisHand += pay;
  if (player.stack === 0) player.status = "ALL_IN";
  pushLog(table, seat, `${player.username} posts ${label} ${pay}`);
  recordAction(table, player, label === "small blind" ? "POST_SB" : "POST_BB", pay, now);
}

/** Deal two orbits of hole cards to `dealtSeats` from the committed deck. */
function dealHoles(table: EngineTable, now: number): void {
  if (table.deck.length !== 52) throw new EngineError("DEAL", "Hole cards must come from a full committed deck");
  const order = table.dealtSeats;
  const dealt = dealHoleCards(table.deck, order.length);
  table.deck = dealt.deck;
  order.forEach((s, i) => {
    table.players[s]!.holeCards = dealt.holeCards[i]!;
  });
  // Positions only: hole cards stay private in the audit trail.
  appendAudit(table, "HOLE_CARDS_DEALT", {
    deals: order.map((seatIndex, i) => ({ seatIndex, positions: holeCardPositions(i, order.length) })),
  }, now);
}

function beginStreet(table: EngineTable, phase: EngineTable["phase"], now: number): void {
  table.phase = phase;
  if (phase !== "PREFLOP") {
    for (const p of table.players) {
      if (p) p.committedThisStreet = 0;
    }
    table.currentBet = 0;
    table.lastFullRaiseSize = table.bigBlind;
    table.lastAggressorSeat = null;
  } else {
    table.currentBet = Math.max(...table.players.map((p) => p?.committedThisStreet ?? 0), table.bigBlind);
    table.lastFullRaiseSize = table.bigBlind;
  }
  table.actedThisStreet = table.actedThisStreet.map(() => false);
  table.lastActedBet = table.lastActedBet.map(() => null);
  table.toActSeat = firstToAct(table);
  startTurn(table, now);
  refreshPots(table);
}

function firstToAct(table: EngineTable): number | null {
  if (table.phase === "PREFLOP") {
    return nextToActSeat(table, table.bbSeat ?? table.dealerSeat);
  }
  return nextToActSeat(table, table.dealerSeat);
}

function executeIntent(
  table: EngineTable,
  player: EnginePlayer,
  intent: EngineIntent,
  legal: NonNullable<ReturnType<typeof legalActions>>,
): void {
  if (intent.amount !== undefined && intent.amount > legal.maxRaiseTo) {
    throw new EngineError("BAD_AMOUNT", "Bet exceeds available stack");
  }
  switch (intent.action) {
    case "FOLD":
      player.status = "FOLDED";
      table.actedThisStreet[player.seatIndex] = true;
      pushLog(table, player.seatIndex, `${player.username} folds`);
      return;
    case "CHECK":
      table.actedThisStreet[player.seatIndex] = true;
      pushLog(table, player.seatIndex, `${player.username} checks`);
      return;
    case "CALL": {
      putChips(table, player, legal.callAmount, "calls");
      return;
    }
    case "BET": {
      const to = intent.amount ?? legal.minBet;
      if (to < legal.minBet && to < legal.maxRaiseTo) {
        throw new EngineError("MIN_BET", `Minimum bet is ${legal.minBet}`);
      }
      raiseTo(table, player, Math.min(to, legal.maxRaiseTo), false);
      return;
    }
    case "RAISE": {
      const to = intent.amount ?? legal.minRaiseTo;
      if (to < legal.minRaiseTo && to < legal.maxRaiseTo) {
        throw new EngineError("MIN_RAISE", `Minimum raise is to ${legal.minRaiseTo}`);
      }
      raiseTo(table, player, Math.min(to, legal.maxRaiseTo), false);
      return;
    }
    case "ALL_IN":
      raiseTo(table, player, player.stack + player.committedThisStreet, true);
      return;
    default:
      throw new EngineError("ILLEGAL", "Unknown action");
  }
}

function putChips(table: EngineTable, player: EnginePlayer, amount: number, verb: string): void {
  const pay = Math.min(player.stack, amount);
  player.stack -= pay;
  player.committedThisStreet += pay;
  player.committedThisHand += pay;
  table.actedThisStreet[player.seatIndex] = true;
  if (player.stack === 0) player.status = "ALL_IN";
  pushLog(table, player.seatIndex, `${player.username} ${verb} ${pay}`);
}

function raiseTo(table: EngineTable, player: EnginePlayer, toAmount: number, allIn: boolean): void {
  const target = Math.min(toAmount, player.stack + player.committedThisStreet);
  const putting = target - player.committedThisStreet;
  if (putting < 0) throw new EngineError("ILLEGAL", "Cannot decrease bet");
  const opening = table.currentBet === 0;
  const raiseSize = target - table.currentBet;
  const isRaise = target > table.currentBet;
  const full = opening
    ? target >= table.bigBlind
    : raiseSize >= table.lastFullRaiseSize;

  player.stack -= putting;
  player.committedThisStreet = target;
  player.committedThisHand += putting;
  if (player.stack === 0) player.status = "ALL_IN";

  if (isRaise && (opening || full)) {
    table.lastFullRaiseSize = opening ? Math.max(target, table.bigBlind) : raiseSize;
    if (opening && target < table.bigBlind) table.lastFullRaiseSize = table.bigBlind;
    else if (opening) table.lastFullRaiseSize = target;
    table.actedThisStreet = table.actedThisStreet.map(() => false);
  }
  table.actedThisStreet[player.seatIndex] = true;
  if (isRaise) {
    table.currentBet = target;
    table.lastAggressorSeat = player.seatIndex;
  }
  const label = allIn ? "all-in" : opening ? "bets" : "raises to";
  pushLog(table, player.seatIndex, `${player.username} ${label} ${target}`);
}

function progressAfterAction(table: EngineTable, now = Date.now()): void {
  refreshPots(table);
  const alive = table.players.filter((p): p is EnginePlayer => p != null && (p.status === "ACTIVE" || p.status === "ALL_IN"));
  if (alive.length <= 1) {
    settle(table, "fold", now);
    return;
  }
  const canBet = alive.filter((p) => p.status === "ACTIVE" && p.stack > 0);
  const lone = canBet[0];
  const facing = lone ? Math.max(...alive.filter((p) => p !== lone).map((p) => p.committedThisStreet), 0) : 0;
  if (canBet.length === 0 || (canBet.length === 1 && lone!.committedThisStreet >= facing)) {
    runout(table, now);
    settle(table, "showdown", now);
    return;
  }
  if (anyoneNeedsAction(table)) {
    const current = table.toActSeat != null ? table.players[table.toActSeat] : null;
    if (!current || !needsAction(table, current)) {
      table.toActSeat = nextToActSeat(table, table.toActSeat ?? table.dealerSeat);
    }
    startTurn(table, now);
    const actor = table.toActSeat != null ? table.players[table.toActSeat] : null;
    if (actor?.sittingOut) {
      Object.assign(table, autoAct(table, now, actor.pendingLeave ? "LEAVE" : "SIT_OUT"));
    }
    return;
  }
  if (canBet.length <= 1) {
    runout(table, now);
    settle(table, "showdown", now);
    return;
  }
  if (table.phase === "RIVER") {
    settle(table, "showdown", now);
    return;
  }
  dealStreet(table, false, now);
  beginStreet(table, table.phase, now);
  if (!anyoneNeedsAction(table) || (table.toActSeat != null && table.players[table.toActSeat]?.sittingOut)) progressAfterAction(table, now);
}

/**
 * Burn one card, then deal the next street from the top of the deck. This is
 * the only place board cards leave the deck, and it is called only when that
 * street begins (or during an all-in runout).
 */
function dealStreet(table: EngineTable, runout: boolean, now: number): void {
  const burnPosition = 52 - table.deck.length;
  const dealtCount = table.dealtSeats.length;
  let street: "FLOP" | "TURN" | "RIVER";
  let cards: Card[];
  if (table.board.length === 0) {
    const flop = burnAndDealFlop(table.deck);
    table.deck = flop.deck;
    table.burns.push(flop.burn);
    cards = [...flop.flop];
    street = "FLOP";
  } else if (table.board.length === 3 || table.board.length === 4) {
    const one = burnAndDealOne(table.deck);
    table.deck = one.deck;
    table.burns.push(one.burn);
    cards = [one.card];
    street = table.board.length === 3 ? "TURN" : "RIVER";
  } else {
    throw new EngineError("DEAL", "Board is already complete");
  }
  const positions = cards.map((_, i) => burnPosition + 1 + i);
  const expected = boardPositions(dealtCount).slice(table.board.length, table.board.length + cards.length);
  if (positions.some((p, i) => p !== expected[i])) throw new EngineError("DEAL", "Deck position out of sequence");
  table.board.push(...cards);
  table.phase = street;
  if (!runout) pushLog(table, null, street === "FLOP" ? `Flop ${cards.join(" ")}` : `${street === "TURN" ? "Turn" : "River"} ${cards[0]}`);
  appendAudit(table, "STREET_DEALT", { street, burnPosition, positions, cards: [...cards], runout }, now);
}

/** All-in with no betting left: deal the remaining streets in order. */
function runout(table: EngineTable, now: number): void {
  while (table.board.length < 5) dealStreet(table, true, now);
}

function settle(table: EngineTable, reason: "fold" | "showdown", now: number): void {
  table.phase = "SHOWDOWN";
  const contribs: Contribution[] = [];
  const holeCards: Record<number, [Card, Card]> = {};
  for (const p of table.players) {
    if (!p || p.committedThisHand <= 0) continue;
    contribs.push({
      seatIndex: p.seatIndex,
      committed: p.committedThisHand,
      folded: p.status === "FOLDED" || p.status === "SIT_OUT" || p.status === "ELIMINATED",
    });
    if (p.holeCards) holeCards[p.seatIndex] = p.holeCards;
  }

  // All live hands are tabled at showdown. Hands that folded or won
  // uncontested are never shown.
  if (reason === "showdown") {
    for (const p of contenders(table)) {
      p.showedCards = true;
    }
    appendAudit(table, "SHOWDOWN", {
      shown: table.dealtSeats.filter((seat) => table.players[seat]?.showedCards).map((seat) => {
        const p = table.players[seat]!;
        const hand = evaluate([...p.holeCards!, ...table.board]);
        return {
          seatIndex: seat, cards: [...p.holeCards!], positions: holeCardPositions(table.dealtSeats.indexOf(seat), table.dealtSeats.length),
          category: hand.category, rankValue: hand.rankValue, handName: hand.name, bestFive: [...hand.bestFive],
        };
      }),
    }, now);
  }

  // The rake terms recorded when the hand was dealt (v2 HAND_STARTED), never
  // the table's current settings; a v1 hand (dealt by the previous engine and
  // settled after an upgrade) and a legacy hand without a record are unraked.
  const v2 = table.audit?.version === HAND_AUDIT_VERSION;
  const awarded = awardPots({
    contribs,
    holeCards,
    board: table.board,
    dealerSeat: table.dealerSeat,
    maxSeats: table.maxSeats,
    rake: table.audit ? handRakeTerms(table.audit) : NO_RAKE,
  });

  table.awards = awarded.pots;
  table.rakeTaken = awarded.rake.total;
  table.refunds = [...awarded.returned].map(([seatIndex, amount]) => ({ seatIndex, amount }));
  table.settledAt = now;
  table.pots = awarded.pots.map((p) => ({
    potIndex: p.potIndex,
    amount: p.amount,
    eligibleSeatIndexes: [...p.eligibleSeatIndexes],
  }));
  table.winners = [];
  const bySeat = new Map<number, number>();
  for (const [seat, amt] of awarded.payouts) {
    const player = table.players[seat];
    if (!player) continue;
    player.stack += amt;
    const won = amt - (awarded.returned.get(seat) ?? 0);
    if (won > 0) bySeat.set(seat, (bySeat.get(seat) ?? 0) + won);
    const ev = awarded.evaluations.get(seat);
    if (ev) player.handResult = ev;
  }
  for (const [seat, amount] of bySeat) {
    const player = table.players[seat]!;
    const name = reason === "showdown" ? (player.handResult?.name ?? null) : null;
    table.winners.push({ seatIndex: seat, amount, handName: name });
    const extra = name ? ` with ${name}` : "";
    pushLog(table, seat, `${player.username} wins ${amount}${extra}`);
  }
  if (awarded.rake.total > 0) pushLog(table, null, `Rake ${awarded.rake.total}`);
  appendAudit(table, "POTS_AWARDED", {
    pots: awarded.pots.map((p) => ({
      potIndex: p.potIndex, amount: p.amount, eligibleSeatIndexes: [...p.eligibleSeatIndexes],
      winnerSeatIndexes: [...p.winnerSeatIndexes], oddChipSeatIndex: p.oddChipSeatIndex,
    })),
    refunds: table.refunds.map((r) => ({ seatIndex: r.seatIndex, amount: r.amount })),
    payouts: [...awarded.payouts].sort(([a], [b]) => a - b).map(([seatIndex, amount]) => ({ seatIndex, amount })),
    // v1 records keep their exact v1 shape (they can only be unraked).
    ...(v2 ? { rake: { total: awarded.rake.total, perPot: awarded.rake.perPot.map((row) => ({ ...row })) } } : {}),
  }, now);

  // Invariant: settlement redistributes chips and never creates or destroys
  // them; the only chips that leave the players are the rake.
  const chipTotal = table.dealtSeats.reduce((sum, seat) => sum + (table.players[seat]?.stack ?? 0), 0) + awarded.rake.total;
  // `!= null`: tables persisted before this field existed decrypt with it undefined.
  if (table.handChipTotal != null && chipTotal !== table.handChipTotal) {
    throw new EngineError("CHIP_INVARIANT", `Chip conservation failed: ${chipTotal} after settlement (stacks plus rake), ${table.handChipTotal} at hand start`);
  }
  appendAudit(table, "HAND_SETTLED", {
    reason,
    board: [...table.board],
    stacks: table.dealtSeats.map((seat) => ({ seatIndex: seat, stack: table.players[seat]!.stack })),
    chipTotal,
  }, now);
  sealHandAudit(table, now);
  table.toActSeat = null;
  table.turnStartedAt = null;
  table.status = "IN_HAND";
  refreshPots(table);
}

function refreshPots(table: EngineTable): void {
  if (table.phase === "SHOWDOWN") {
    table.potTotal = table.pots.reduce((s, p) => s + p.amount, 0);
    return;
  }
  table.potTotal = table.players.reduce((s, p) => s + (p?.committedThisHand ?? 0), 0);
  const contribs: Contribution[] = [];
  for (const p of table.players) {
    if (!p || p.committedThisHand <= 0) continue;
    contribs.push({
      seatIndex: p.seatIndex,
      committed: p.committedThisHand,
      folded: p.status === "FOLDED" || p.status === "SIT_OUT" || p.status === "ELIMINATED",
    });
  }
  const anyoneAllIn = table.players.some((p) => p?.status === "ALL_IN");
  if (!anyoneAllIn) {
    const eligible = contribs.filter((c) => !c.folded).map((c) => c.seatIndex);
    table.pots =
      table.potTotal > 0 ? [{ potIndex: 0, amount: table.potTotal, eligibleSeatIndexes: eligible }] : [];
    return;
  }
  const { adjusted } = returnUncalledBets(contribs);
  // Same pot identity as settlement: layers with equal eligible players are one pot.
  table.pots = mergePotsByEligibility(buildSidePots(adjusted));
}

function recordAction(table: EngineTable, player: EnginePlayer, action: EngineTable["actions"][number]["action"], amount: number, now: number,
  auto: "SIT_OUT" | "LEAVE" | null = null): void {
  table.actions.push({ seq: table.actions.length, seatIndex: player.seatIndex, street: table.phase, action, amount, toAmount: player.committedThisStreet, at: new Date(now).toISOString() });
  if (action === "POST_SB" || action === "POST_BB") {
    appendAudit(table, "BLIND_POSTED", { seatIndex: player.seatIndex, blind: action === "POST_SB" ? "SMALL" : "BIG", amount, allIn: player.stack === 0 }, now);
    return;
  }
  table.lastActedBet[player.seatIndex] = table.currentBet;
  appendAudit(table, "PLAYER_ACTION", {
    seatIndex: player.seatIndex, action, amount, toAmount: player.committedThisStreet, stackAfter: player.stack,
    timeout: action === "TIMEOUT_CHECK" || action === "TIMEOUT_FOLD", auto,
  }, now);
}

function bettingInProgress(table: EngineTable): boolean {
  return table.phase === "PREFLOP" || table.phase === "FLOP" || table.phase === "TURN" || table.phase === "RIVER";
}

/** Record sit-out / sit-in / leave for a player dealt into the running hand. */
function auditStatus(table: EngineTable, player: EnginePlayer, status: "SIT_OUT" | "SIT_IN" | "LEAVE", now: number): void {
  if (bettingInProgress(table) && table.dealtSeats.includes(player.seatIndex)) {
    appendAudit(table, "PLAYER_STATUS", { seatIndex: player.seatIndex, status }, now);
  }
}
