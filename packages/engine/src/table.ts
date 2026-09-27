/**
 * Hold'em hand state machine.
 *
 *   WAITING -> PREFLOP -> FLOP -> TURN -> RIVER -> SHOWDOWN -> (Hand Clean-up) -> WAITING
 *
 * Every public function is a pure transition. It clones the input table,
 * applies one validated command and returns the new state. The input is never
 * mutated, so a rejected command cannot leave a half-applied state.
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
 */
import type { Card } from "@poker/shared";
import { boardPositions, holeCardPositions } from "@poker/shared";
import { burnAndDealFlop, burnAndDealOne, dealHoleCards, dealOrderFromDealer, shuffledDeck } from "./deck.js";
import { legalActions } from "./legal.js";
import { awardPots, buildSidePots, mergePotsByEligibility, returnUncalledBets, type Contribution } from "./pots.js";
import { pushLog } from "./public.js";
import { commitDeck, newHandId } from "./fairness.js";
import { appendAudit, openHandAudit, sealHandAudit } from "./audit.js";
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
  type SeatPlayerConfig,
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
      cfg.bigBlind !== cfg.smallBlind * 2 || !Number.isInteger(cfg.timeBankMs) || cfg.timeBankMs <= 0) {
    throw new EngineError("BAD_CONFIG", "Invalid table configuration");
  }
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
    winners: [],
    animToken: 0,
    cashOuts: [],
  };
}

export function sitDown(table: EngineTable, seatIndex: number, cfg: SeatPlayerConfig): EngineTable {
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
    showedCards: false,
    handResult: null,
    pendingLeave: false,
    waitingForBigBlind,
    missedBlind: false,
  };
  pushLog(next, seatIndex, `${cfg.username} sits with $${cfg.buyIn}`);
  next.animToken += 1;
  return next;
}

export function sitOut(table: EngineTable, userId: string, now = Date.now()): EngineTable {
  // A repeated toggle changes nothing: no audit event, no new revision.
  if (requirePlayer(table, userId).sittingOut) return table;
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = true;
  if (next.phase === "WAITING" || next.phase === "COMPLETE") player.status = "SIT_OUT";
  pushLog(next, player.seatIndex, `${player.username} sits out`);
  auditStatus(next, player, "SIT_OUT", now);
  if (next.toActSeat === player.seatIndex && player.status === "ACTIVE") return autoAct(next, now, "SIT_OUT");
  return next;
}

export function sitIn(table: EngineTable, userId: string, now = Date.now()): EngineTable {
  if (!requirePlayer(table, userId).sittingOut) return table;
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = false;
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
  const next = upgradeTableState(cloneTable(table)).table;
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
  next.lastAggressorSeat = null;
  next.audit = null;
  assignButtonAndBlinds(next);

  // Seats dealt in, in deal order: first card to the seat left of the button
  // (the big blind heads-up).
  next.dealtSeats = dealOrderFromDealer(next.dealerSeat, next.maxSeats,
    next.players.map((player, seat) => receivesCards(player) ? seat : -1).filter((seat) => seat >= 0));
  next.handChipTotal = next.dealtSeats.reduce((sum, seat) => sum + next.players[seat]!.stack, 0);

  // 1. Shuffle with the OS CSPRNG. 2. Commit to the full deck order with
  // SHA-256. 3. Open the audit record. All three happen before any blind is
  // posted or any card is dealt.
  next.fairness = commitDeck(shuffledDeck(), next.tableId, next.handNumber, newHandId());
  next.deck = [...next.fairness.deck];
  openHandAudit(next, next.fairness, now, {
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
  recordAction(next, player, intent.action, player.committedThisStreet - before, now);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

/** The acting player's time bank expired: check if free, otherwise fold. */
export function applyTimeout(table: EngineTable, now = Date.now()): EngineTable {
  return autoAct(table, now, "TIMEOUT");
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
  purgeHandState(next);
  for (const p of next.players) {
    if (!p) continue;
    if (p.pendingLeave) {
      next.cashOuts.push({ userId: p.userId, stack: p.stack });
      next.players[p.seatIndex] = null;
      continue;
    }
    if (p.stack <= 0) {
      next.cashOuts.push({ userId: p.userId, stack: 0 });
      next.players[p.seatIndex] = null;
    }
  }
  return next;
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

/**
 * Bring table state saved by an earlier engine version up to this model.
 * The upgrade is deterministic and idempotent. The server applies it on
 * every load; on current state it changes nothing.
 * - Missing fields get their defaults. The retired pre-deal seed protocol,
 *   including its server seed, is dropped.
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
export function upgradeTableState(table: EngineTable): { table: EngineTable; voidedHand: number | null } {
  const t = table as EngineTable & { pendingShuffle?: unknown };
  delete t.pendingShuffle;
  t.audit ??= null;
  t.auditChainTip ??= null;
  t.handChipTotal ??= null;
  t.smallBlindPosition ??= null;
  t.dealtSeats ??= [];
  for (const p of t.players) {
    if (!p) continue;
    p.waitingForBigBlind ??= false;
    p.missedBlind ??= false;
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
  table.turnStartedAt = table.toActSeat == null ? null : now;
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
        throw new EngineError("MIN_BET", `Minimum bet is $${legal.minBet}`);
      }
      raiseTo(table, player, Math.min(to, legal.maxRaiseTo), false);
      return;
    }
    case "RAISE": {
      const to = intent.amount ?? legal.minRaiseTo;
      if (to < legal.minRaiseTo && to < legal.maxRaiseTo) {
        throw new EngineError("MIN_RAISE", `Minimum raise is to $${legal.minRaiseTo}`);
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
  pushLog(table, player.seatIndex, `${player.username} ${verb} $${pay}`);
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
  pushLog(table, player.seatIndex, `${player.username} ${label} $${target}`);
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
    table.turnStartedAt = table.toActSeat == null ? null : now;
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

  const awarded = awardPots({
    contribs,
    holeCards,
    board: table.board,
    dealerSeat: table.dealerSeat,
    maxSeats: table.maxSeats,
  });

  table.awards = awarded.pots;
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
    pushLog(table, seat, `${player.username} wins $${amount}${extra}`);
  }
  appendAudit(table, "POTS_AWARDED", {
    pots: awarded.pots.map((p) => ({
      potIndex: p.potIndex, amount: p.amount, eligibleSeatIndexes: [...p.eligibleSeatIndexes],
      winnerSeatIndexes: [...p.winnerSeatIndexes], oddChipSeatIndex: p.oddChipSeatIndex,
    })),
    refunds: table.refunds.map((r) => ({ seatIndex: r.seatIndex, amount: r.amount })),
    payouts: [...awarded.payouts].sort(([a], [b]) => a - b).map(([seatIndex, amount]) => ({ seatIndex, amount })),
  }, now);

  // Invariant: settlement redistributes chips and never creates or destroys them.
  const chipTotal = table.dealtSeats.reduce((sum, seat) => sum + (table.players[seat]?.stack ?? 0), 0);
  // `!= null`: tables persisted before this field existed decrypt with it undefined.
  if (table.handChipTotal != null && chipTotal !== table.handChipTotal) {
    throw new EngineError("CHIP_INVARIANT", `Chip conservation failed: ${chipTotal} after settlement, ${table.handChipTotal} at hand start`);
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
