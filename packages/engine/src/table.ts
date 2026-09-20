import type { Card } from "@poker/shared";
import { burnAndDealFlop, burnAndDealOne, dealHoleCards, shuffledDeck } from "./deck.js";
import { legalActions } from "./legal.js";
import { awardPots, buildSidePots, returnUncalledBets, type Contribution } from "./pots.js";
import { pushLog } from "./public.js";
import {
  anyoneNeedsAction,
  contenders,
  isLiveForDeal,
  liveDealSeats,
  needsAction,
  nextIndex,
  nextLiveSeat,
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
  return {
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
  if (seatIndex < 0 || seatIndex >= next.maxSeats) throw new EngineError("BAD_SEAT", "Invalid seat");
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
  };
  pushLog(next, seatIndex, `${cfg.username} sits with $${cfg.buyIn}`);
  next.animToken += 1;
  return next;
}

export function sitOut(table: EngineTable, userId: string): EngineTable {
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = true;
  player.status = "SIT_OUT";
  pushLog(next, player.seatIndex, `${player.username} sits out`);
  if (next.toActSeat === player.seatIndex) return applyTimeout(next);
  return next;
}

export function sitIn(table: EngineTable, userId: string): EngineTable {
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  player.sittingOut = false;
  if (next.phase === "WAITING" || next.phase === "COMPLETE") player.status = "ACTIVE";
  pushLog(next, player.seatIndex, `${player.username} sits in`);
  return next;
}

export function leaveSeat(table: EngineTable, userId: string): EngineTable {
  const next = cloneTable(table);
  const player = requirePlayer(next, userId);
  const inProgress = next.phase !== "WAITING" && next.phase !== "COMPLETE" && next.phase !== "SHOWDOWN";
  if (inProgress) {
    const wasToAct = next.toActSeat === player.seatIndex;
    player.status = "FOLDED";
    player.sittingOut = true;
    player.pendingLeave = true;
    next.actedThisStreet[player.seatIndex] = true;
    pushLog(next, player.seatIndex, `${player.username} leaves the table`);
    next.animToken += 1;
    if (wasToAct) progressAfterAction(next);
    return next;
  }
  next.cashOuts.push({ userId: player.userId, stack: player.stack });
  next.players[player.seatIndex] = null;
  pushLog(next, player.seatIndex, `${player.username} leaves the table`);
  next.animToken += 1;
  return next;
}

export function startHand(table: EngineTable, now = Date.now()): EngineTable {
  const next = cloneTable(table);
  const live = liveDealSeats(next);
  if (live.length < 2) throw new EngineError("NOT_ENOUGH_PLAYERS", "Need at least two players with chips");

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
    if (p.sittingOut) {
      p.status = "SIT_OUT";
      continue;
    }
    p.status = "ACTIVE";
  }

  next.handNumber += 1;
  next.winners = [];
  next.board = [];
  next.burns = [];
  next.pots = [];
  next.potTotal = 0;
  next.lastAggressorSeat = null;
  assignButtonAndBlinds(next);
  postBlind(next, next.sbSeat, next.smallBlind, "small blind");
  postBlind(next, next.bbSeat, next.bigBlind, "big blind");
  dealHoles(next);
  beginStreet(next, "PREFLOP", now);
  next.status = "IN_HAND";
  pushLog(next, null, `Hand #${next.handNumber}`);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

export function applyAction(table: EngineTable, userId: string, intent: EngineIntent, now = Date.now()): EngineTable {
  const next = cloneTable(table);
  if (next.toActSeat == null) throw new EngineError("NO_TURN", "No one to act");
  const player = next.players[next.toActSeat];
  if (!player || player.userId !== userId) throw new EngineError("NOT_YOUR_TURN", "Not your turn");
  const legal = legalActions(next, player.seatIndex);
  if (!legal || !legal.actions.includes(intent.action)) {
    throw new EngineError("ILLEGAL", "That action is not legal");
  }
  executeIntent(next, player, intent, legal);
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

export function applyTimeout(table: EngineTable, now = Date.now()): EngineTable {
  const next = cloneTable(table);
  if (next.toActSeat == null) return next;
  const player = next.players[next.toActSeat];
  if (!player) return next;
  const legal = legalActions(next, player.seatIndex);
  if (legal?.actions.includes("CHECK")) {
    executeIntent(next, player, { action: "CHECK" }, legal);
  } else if (legal?.actions.includes("FOLD")) {
    executeIntent(next, player, { action: "FOLD" }, legal);
  } else {
    player.status = "FOLDED";
    next.actedThisStreet[player.seatIndex] = true;
    pushLog(next, player.seatIndex, `${player.username} folds (time)`);
  }
  const last = next.log[next.log.length - 1];
  if (last && !last.text.endsWith("(time)")) last.text = `${last.text} (time)`;
  next.animToken += 1;
  progressAfterAction(next, now);
  return next;
}

export function completeHand(table: EngineTable): EngineTable {
  const next = cloneTable(table);
  next.phase = "WAITING";
  next.status = "WAITING";
  next.toActSeat = null;
  next.turnStartedAt = null;
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

function requirePlayer(table: EngineTable, userId: string): EnginePlayer {
  const player = table.players.find((p) => p?.userId === userId);
  if (!player) throw new EngineError("NOT_SEATED", "You are not seated");
  return player;
}

function assignButtonAndBlinds(table: EngineTable): void {
  const live = liveDealSeats(table);
  if (table.handNumber <= 1) {
    table.dealerSeat = live[0]!;
  } else if (live.length === 2) {
    table.dealerSeat = nextLiveSeat(table, table.dealerSeat) ?? live[0]!;
  } else {
    table.dealerSeat = nextIndex(table.dealerSeat, table.maxSeats);
  }

  if (live.length === 2) {
    if (!isLiveForDeal(table.players[table.dealerSeat])) {
      table.dealerSeat = live[0]!;
    }
    table.sbSeat = table.dealerSeat;
    table.bbSeat = nextLiveSeat(table, table.dealerSeat);
  } else {
    table.sbSeat = nextLiveSeat(table, table.dealerSeat);
    table.bbSeat = table.sbSeat != null ? nextLiveSeat(table, table.sbSeat) : null;
  }
  if (table.sbSeat == null || table.bbSeat == null) {
    throw new EngineError("BLINDS", "Could not place blinds");
  }
}

function postBlind(table: EngineTable, seat: number | null, amount: number, label: string): void {
  if (seat == null) return;
  const player = table.players[seat];
  if (!player) return;
  const pay = Math.min(player.stack, amount);
  player.stack -= pay;
  player.committedThisStreet += pay;
  player.committedThisHand += pay;
  if (player.stack === 0) player.status = "ALL_IN";
  pushLog(table, seat, `${player.username} posts ${label} $${pay}`);
}

function dealHoles(table: EngineTable): void {
  table.deck = shuffledDeck();
  const order: number[] = [];
  let seat = table.sbSeat!;
  for (let i = 0; i < table.maxSeats; i += 1) {
    if (receivesCards(table.players[seat])) order.push(seat);
    seat = nextIndex(seat, table.maxSeats);
  }
  const dealt = dealHoleCards(table.deck, order.length);
  table.deck = dealt.deck;
  order.forEach((s, i) => {
    table.players[s]!.holeCards = dealt.holeCards[i]!;
  });
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
    table.currentBet = Math.max(...table.players.map((p) => p?.committedThisStreet ?? 0), 0);
    table.lastFullRaiseSize = table.bigBlind;
  }
  table.actedThisStreet = table.actedThisStreet.map(() => false);
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
    ? target >= table.bigBlind || !allIn
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
    settle(table, "fold");
    return;
  }
  if (anyoneNeedsAction(table)) {
    const current = table.toActSeat != null ? table.players[table.toActSeat] : null;
    if (!current || !needsAction(table, current)) {
      table.toActSeat = nextToActSeat(table, table.toActSeat ?? table.dealerSeat);
    }
    table.turnStartedAt = table.toActSeat == null ? null : now;
    return;
  }
  const canBet = alive.filter((p) => p.status === "ACTIVE" && p.stack > 0);
  if (canBet.length <= 1) {
    runout(table);
    settle(table, "showdown");
    return;
  }
  if (table.phase === "RIVER") {
    settle(table, "showdown");
    return;
  }
  dealNextBoard(table);
  const nextPhase =
    table.phase === "PREFLOP" ? "FLOP" : table.phase === "FLOP" ? "TURN" : "RIVER";
  beginStreet(table, nextPhase, now);
  if (!anyoneNeedsAction(table)) progressAfterAction(table, now);
}

function dealNextBoard(table: EngineTable): void {
  if (table.phase === "PREFLOP") {
    const flop = burnAndDealFlop(table.deck);
    table.deck = flop.deck;
    table.burns.push(flop.burn);
    table.board.push(...flop.flop);
    pushLog(table, null, `Flop ${flop.flop.join(" ")}`);
  } else {
    const one = burnAndDealOne(table.deck);
    table.deck = one.deck;
    table.burns.push(one.burn);
    table.board.push(one.card);
    pushLog(table, null, `${table.phase === "FLOP" ? "Turn" : "River"} ${one.card}`);
  }
}

function runout(table: EngineTable): void {
  while (table.board.length < 5) {
    if (table.board.length === 0) {
      const flop = burnAndDealFlop(table.deck);
      table.deck = flop.deck;
      table.burns.push(flop.burn);
      table.board.push(...flop.flop);
    } else {
      const one = burnAndDealOne(table.deck);
      table.deck = one.deck;
      table.burns.push(one.burn);
      table.board.push(one.card);
    }
  }
}

function settle(table: EngineTable, reason: "fold" | "showdown"): void {
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

  if (reason === "showdown") {
    for (const p of contenders(table)) {
      p.showedCards = true;
    }
  }

  const awarded = awardPots({
    contribs,
    holeCards,
    board: table.board,
    dealerSeat: table.dealerSeat,
    maxSeats: table.maxSeats,
  });

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
    bySeat.set(seat, (bySeat.get(seat) ?? 0) + amt);
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
  table.phase = "SHOWDOWN";
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
  table.pots = buildSidePots(adjusted);
}
