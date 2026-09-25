/**
 * Requirement 4: pot settlement (main pot, multi-way side pots, split pots,
 * odd chips) for regulatory submission.
 *
 * What this file proves about awardPots (pots.ts) and settlement (table.ts):
 * 1. An independent chip-by-chip reference settlement (below) agrees exactly
 *    with awardPots on 20,000 random scenarios. The comparison covers
 *    per-seat payouts, uncalled refunds and the pot list (amount, eligible
 *    seats, winners, odd-chip seat). Chips are conserved, winners are always
 *    eligible, and folded players are never paid.
 * 2. Real hands driven through startHand / applyAction / applyTimeout /
 *    sitOut / leaveSeat settle exactly as the reference predicts. This
 *    includes 3-6 short stacks all-in at different amounts. The audit's
 *    POTS_AWARDED and HAND_SETTLED events agree with the resulting stacks.
 * 3. No pot can end up with zero eligible players through the public API
 *    (proof below). If internal state is corrupted into that condition, the
 *    engine fails closed with CHIP_INVARIANT.
 * 4. Odd chips go one at a time to the winners, clockwise, starting left of
 *    the button.
 *
 * Determinism: inputs are drawn from node:crypto, so there is no seed. All
 * checks are exact. Failure messages print the concrete scenario, so any
 * failure is a reproducible defect. The coverage floors below are the only
 * probabilistic assertions, and each documents its bound.
 */
import { randomFillSync } from "node:crypto";
import type { ActionType, Card } from "@poker/shared";
import { awardPots, seatingOrderFromBlinds, splitOddChips, type Contribution } from "../pots.js";
import { applyAction, applyTimeout, completeHand, createTable, leaveSeat, sitDown, sitOut, startHand } from "../table.js";
import { legalActions } from "../legal.js";
import { EngineError, type EngineTable } from "../types.js";

// ---------------------------------------------------------------------------
// Independent 7-card hand ranking (no code shared with evaluate.ts; the same
// algorithm is verified against evaluate() in evaluate-exhaustive.test.ts).
// ---------------------------------------------------------------------------
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
const DECK: Card[] = [...RANKS].flatMap((r) => [...SUITS].map((s) => `${r}${s}` as Card));

function straightTop(mask: number): number {
  for (let top = 12; top >= 4; top -= 1) if (((mask >> (top - 4)) & 0x1f) === 0x1f) return top;
  return (mask & 0x100f) === 0x100f ? 3 : -1;
}
function topRanks(mask: number, n: number, skip: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r -= 1) if ((mask >> r) & 1 && !skip.includes(r)) out.push(r);
  return out;
}
/** Comparable strength of the best hand in 5-7 cards: higher wins, equal ties. */
function handKey(cards: readonly string[]): number {
  const count = new Array<number>(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const r = RANKS.indexOf(card[0]!), s = SUITS.indexOf(card[1]!);
    if (card.length !== 2 || r < 0 || s < 0 || (suitMask[s]! >> r) & 1) throw new Error(`bad or duplicate card ${card}`);
    count[r]! += 1; suitMask[s]! |= 1 << r; suitCount[s]! += 1; mask |= 1 << r;
  }
  const withCount = (n: number) => { const o: number[] = []; for (let r = 12; r >= 0; r -= 1) if (count[r] === n) o.push(r); return o; };
  const quads = withCount(4), trips = withCount(3), pairs = withCount(2);
  const fs = suitCount.findIndex((n) => n >= 5);
  const flush = fs >= 0 ? suitMask[fs]! : 0;
  const sf = fs >= 0 ? straightTop(flush) : -1;
  const st = straightTop(mask);
  let cat: number, t: number[];
  if (sf >= 0) { cat = 8; t = [sf]; }
  else if (quads.length) { cat = 7; t = [quads[0]!, ...topRanks(mask, 1, [quads[0]!])]; }
  else if (trips.length && trips.length + pairs.length >= 2) { cat = 6; t = [trips[0]!, Math.max(trips[1] ?? -1, pairs[0] ?? -1)]; }
  else if (fs >= 0) { cat = 5; t = topRanks(flush, 5); }
  else if (st >= 0) { cat = 4; t = [st]; }
  else if (trips.length) { cat = 3; t = [trips[0]!, ...topRanks(mask, 2, [trips[0]!])]; }
  else if (pairs.length >= 2) { cat = 2; t = [pairs[0]!, pairs[1]!, ...topRanks(mask, 1, [pairs[0]!, pairs[1]!])]; }
  else if (pairs.length === 1) { cat = 1; t = [pairs[0]!, ...topRanks(mask, 3, [pairs[0]!])]; }
  else { cat = 0; t = topRanks(mask, 5); }
  let key = cat;
  for (let i = 0; i < 5; i += 1) key = key * 13 + (t[i] ?? 0);
  return key;
}

// ---------------------------------------------------------------------------
// Independent reference settlement: chip-by-chip layering.
// ---------------------------------------------------------------------------
interface RefPot { amount: number; eligible: number[]; winners: number[]; oddChipSeat: number | null }
interface RefSettlement { refunds: Map<number, number>; pots: RefPot[]; payouts: Map<number, number> }

/**
 * Chip level k (k = 1..max) holds one chip from every player with
 * committed >= k.
 * - A level with a single contributor was never called. Its chip goes back to
 *   that contributor, whether or not the player folded.
 * - Any other level is contested by its non-folded contributors. Consecutive
 *   levels with the same contestants form ONE pot, so a new (side) pot starts
 *   only where a contestant's all-in amount is exceeded. A folded player's
 *   chips are dead money in the pots they reach and never open a pot.
 * - Each pot goes to its best hand(s) in equal shares. Odd chips go one at a
 *   time to the winners, clockwise, starting left of the button.
 */
function referenceSettle(
  contribs: readonly Contribution[], holes: Readonly<Record<number, readonly Card[]>>,
  board: readonly Card[], dealerSeat: number, maxSeats: number,
): RefSettlement {
  const refunds = new Map<number, number>();
  const payouts = new Map<number, number>();
  const add = (m: Map<number, number>, seat: number, n: number) => m.set(seat, (m.get(seat) ?? 0) + n);
  const layers: { amount: number; eligible: number[] }[] = [];
  const max = Math.max(0, ...contribs.map((c) => c.committed));
  for (let k = 1; k <= max; k += 1) {
    const layer = contribs.filter((c) => c.committed >= k);
    if (layer.length === 1) { add(refunds, layer[0]!.seatIndex, 1); continue; }
    const eligible = layer.filter((c) => !c.folded).map((c) => c.seatIndex).sort((a, b) => a - b);
    const last = layers.at(-1);
    if (last && last.eligible.join() === eligible.join()) last.amount += layer.length;
    else layers.push({ amount: layer.length, eligible });
  }
  for (const [seat, n] of refunds) add(payouts, seat, n);
  const pots = layers.map(({ amount, eligible }): RefPot => {
    if (eligible.length === 0) throw new Error("reference: a pot has no eligible player");
    let winners = eligible;
    if (eligible.length > 1) {
      if (board.length !== 5) throw new Error("reference: contested pot without a full board");
      const keys = eligible.map((seat) => handKey([...holes[seat]!, ...board]));
      winners = eligible.filter((_, i) => keys[i] === Math.max(...keys));
    }
    const share = Math.floor(amount / winners.length);
    let odd = amount - share * winners.length;
    for (const seat of winners) add(payouts, seat, share);
    let oddChipSeat: number | null = null;
    for (let step = 1; step <= maxSeats && odd > 0; step += 1) {
      const seat = (dealerSeat + step) % maxSeats;
      if (!winners.includes(seat)) continue;
      add(payouts, seat, 1);
      odd -= 1;
      oddChipSeat ??= seat;
    }
    return { amount, eligible, winners, oddChipSeat };
  });
  return { refunds, pots, payouts };
}

const entries = (m: ReadonlyMap<number, number>) => [...m].filter(([, v]) => v !== 0).sort(([a], [b]) => a - b);
const potsView = (pots: readonly { amount: number; eligibleSeatIndexes: readonly number[]; winnerSeatIndexes: readonly number[]; oddChipSeatIndex: number | null }[]): RefPot[] =>
  pots.map((p) => ({
    amount: p.amount,
    eligible: [...p.eligibleSeatIndexes].sort((a, b) => a - b),
    winners: [...p.winnerSeatIndexes].sort((a, b) => a - b),
    oddChipSeat: p.oddChipSeatIndex,
  }));

// ---------------------------------------------------------------------------
// Test-input sampling: OS CSPRNG words with rejection sampling (unbiased).
// ---------------------------------------------------------------------------
const words = new Uint32Array(8192);
let wordAt = words.length;
function below(n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    if (wordAt === words.length) { randomFillSync(words); wordAt = 0; }
    const w = words[wordAt++]!;
    if (w < limit) return w % n;
  }
}
function shuffled<T>(items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = below(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}
const LONG = 180_000;

// ---------------------------------------------------------------------------
// 1. Random scenarios: awardPots vs the reference.
// ---------------------------------------------------------------------------
describe("awardPots vs chip-by-chip reference settlement", () => {
  it("agrees on 20,000 random multi-way scenarios (payouts, refunds, pots, odd chips)", () => {
    const problems: string[] = [];
    const seen = { threePlusPots: 0, splitPots: 0, oddChipPots: 0, deadMoney: 0, equalAllIns: 0 };
    for (let i = 0; i < 20_000; i += 1) {
      const n = 2 + below(8);
      const maxSeats = n + below(10 - n);
      const seats = shuffled(Array.from({ length: maxSeats }, (_, s) => s)).slice(0, n);
      const dealerSeat = below(maxSeats);
      const levels = Array.from({ length: 1 + below(3) }, () => 1 + below(300));
      const contribs: Contribution[] = seats.map((seatIndex) => {
        const mode = i % 4;
        const committed = mode === 0 ? 1 + below(500) : mode === 1 ? levels[below(levels.length)]! : mode === 2 ? 1 + below(12) : below(8) === 0 ? 0 : 1 + below(200);
        return { seatIndex, committed, folded: below(8) < 3 };
      });
      // Realistic states only: a non-folded player holds the largest
      // commitment, which the proof in section 3 shows is always true in play.
      // So the top pot after the refund is non-folded, and no refund goes to a
      // folded player.
      const top = Math.max(...contribs.map((c) => c.committed));
      if (!contribs.some((c) => !c.folded && c.committed === top)) {
        const candidates = contribs.filter((c) => c.committed === top);
        candidates[below(candidates.length)]!.folded = false;
      }
      // Every 5th scenario uses a rainbow broadway board (A-K-Q-J-T, at most
      // two per suit). Nothing can beat it, so every contested pot splits.
      const broadway = i % 5 === 0;
      const board: Card[] = broadway ? shuffled(["A", "K", "Q", "J", "T"]).map((r, k) => `${r}${"cdhsc"[k]}` as Card) : [];
      const deck = shuffled(DECK.filter((c) => !board.includes(c)));
      while (board.length < 5) board.push(deck.pop()!);
      const holes: Record<number, [Card, Card]> = {};
      for (const s of seats) holes[s] = [deck.pop()!, deck.pop()!];

      const got = awardPots({ contribs, holeCards: holes, board, dealerSeat, maxSeats });
      const ref = referenceSettle(contribs, holes, board, dealerSeat, maxSeats);
      const describe = () => JSON.stringify({ contribs, holes, board, dealerSeat, maxSeats });
      const same = JSON.stringify([entries(got.payouts), entries(got.returned), potsView(got.pots)]) ===
        JSON.stringify([entries(ref.payouts), entries(ref.refunds), ref.pots]);
      if (!same && problems.length < 5) {
        problems.push(`${describe()}\n engine ${JSON.stringify([entries(got.payouts), potsView(got.pots)])}\n reference ${JSON.stringify([entries(ref.payouts), ref.pots])}`);
      }
      // Invariants, checked on the engine's own output.
      const paid = [...got.payouts.values()].reduce((a, b) => a + b, 0);
      const committed = contribs.reduce((a, c) => a + c.committed, 0);
      const bad =
        paid !== committed ? "chips not conserved" :
        got.pots.some((p) => p.winnerSeatIndexes.length === 0 || p.winnerSeatIndexes.some((w) => !p.eligibleSeatIndexes.includes(w))) ? "winner not eligible" :
        got.pots.some((p) => p.eligibleSeatIndexes.some((s) => contribs.find((c) => c.seatIndex === s)!.folded)) ? "folded player eligible" :
        contribs.some((c) => c.folded && (got.payouts.get(c.seatIndex) ?? 0) !== 0) ? "folded player paid" :
        null;
      if (bad && problems.length < 5) problems.push(`${bad}: ${describe()}`);

      if (ref.pots.length >= 3) seen.threePlusPots += 1;
      if (ref.pots.some((p) => p.winners.length > 1)) seen.splitPots += 1;
      if (ref.pots.some((p) => p.oddChipSeat !== null)) seen.oddChipPots += 1;
      if (ref.pots.length >= 2 && contribs.some((c) => c.folded && c.committed > 0)) seen.deadMoney += 1;
      if (new Set(contribs.filter((c) => !c.folded).map((c) => c.committed)).size < contribs.filter((c) => !c.folded).length) seen.equalAllIns += 1;
    }
    expect(problems).toEqual([]);
    // Coverage floors, each far below its expectation: the broadway quarter
    // alone gives thousands of splits, odd chips and equal all-ins. Every
    // count is a sum of independent trials with an expected value above
    // 1,000, so a floor of 50 fails with probability < exp(-450) by Chernoff.
    expect(Math.min(...Object.values(seen))).toBeGreaterThanOrEqual(50);
  }, LONG);
});

// ---------------------------------------------------------------------------
// Real-hand helpers.
// ---------------------------------------------------------------------------
function seatPlayers(stacks: readonly (number | null)[], opts: { maxSeats?: number; smallBlind?: number } = {}): EngineTable {
  const smallBlind = opts.smallBlind ?? 5;
  let t = createTable({ tableId: "pots-ref", name: "Pots", maxSeats: opts.maxSeats ?? stacks.length, smallBlind, bigBlind: 2 * smallBlind, timeBankMs: 15_000 });
  stacks.forEach((buyIn, seat) => {
    if (buyIn) t = sitDown(t, seat, { userId: `u${seat}`, username: `P${seat}`, avatarHue: 0, kind: "HUMAN", botProfile: null, buyIn, skipBuyInCheck: true });
  });
  return t;
}
function act(t: EngineTable, action: ActionType, amount?: number): EngineTable {
  return applyAction(t, t.players[t.toActSeat!]!.userId, amount === undefined ? { action } : { action, amount });
}
/** Scripted betting. Each step names the seat expected to act, which also documents the action order. */
function play(t: EngineTable, script: readonly [seat: number, action: ActionType, amount?: number][]): EngineTable {
  for (const [seat, action, amount] of script) {
    expect({ toAct: t.toActSeat, phase: t.phase }).toEqual({ toAct: seat, phase: t.phase });
    t = act(t, action, amount);
  }
  return t;
}

/**
 * White-box card placement for deterministic split-pot hands. Only card
 * values change. Betting, pot building and settlement still run through the
 * public API. Hole cards become fixed cards, and the undealt deck is
 * rearranged so the board runs out as a royal flush in hearts, which every
 * player plays. The result is a guaranteed split among all live hands.
 */
function rigRoyalBoard(t: EngineTable): EngineTable {
  const next = structuredClone(t);
  const royal = ["Ah", "Kh", "Qh", "Jh", "Th"] as Card[];
  const spare = DECK.filter((c) => !royal.includes(c));
  for (const seat of next.dealtSeats) next.players[seat]!.holeCards = [spare.shift()!, spare.shift()!];
  const [f1, f2, f3, turn, river] = royal;
  const deck = [spare[0]!, f1!, f2!, f3!, spare[1]!, turn!, spare[2]!, river!, ...spare.slice(3)].slice(0, next.deck.length);
  expect(deck).toHaveLength(next.deck.length);
  next.deck = deck;
  return next;
}

interface StartedData { seats: { seatIndex: number; stack: number }[]; chipTotal: number }
interface AwardedData {
  pots: { amount: number; eligibleSeatIndexes: number[]; winnerSeatIndexes: number[]; oddChipSeatIndex: number | null }[];
  refunds: { seatIndex: number; amount: number }[];
  payouts: { seatIndex: number; amount: number }[];
}
interface SettledData { stacks: { seatIndex: number; stack: number }[]; chipTotal: number }

/**
 * A settled real hand must match the reference settlement, computed from the
 * hole cards, the board and each player's committedThisHand. The audit must
 * agree: HAND_STARTED stack - committed + reference payout = final stack =
 * HAND_SETTLED stack. POTS_AWARDED must equal the reference pots, refunds and
 * payouts, and the audit chip total must be unchanged.
 */
function verifySettlement(t: EngineTable): RefSettlement {
  expect(t.phase).toBe("SHOWDOWN");
  const events = t.audit!.events;
  const started = events[0]!.data as unknown as StartedData;
  const awarded = events.find((e) => e.type === "POTS_AWARDED")!.data as unknown as AwardedData;
  const settled = events.at(-1)!;
  expect(settled.type).toBe("HAND_SETTLED");
  const contribs: Contribution[] = [];
  const holes: Record<number, readonly Card[]> = {};
  for (const seat of t.dealtSeats) {
    const p = t.players[seat]!;
    holes[seat] = p.holeCards!;
    if (p.committedThisHand > 0) contribs.push({ seatIndex: seat, committed: p.committedThisHand, folded: p.status === "FOLDED" });
  }
  // Invariant proved in section 3: a live player holds the largest commitment, so no folded player is paid.
  const largest = Math.max(...contribs.map((c) => c.committed));
  expect(contribs.some((c) => !c.folded && c.committed === largest)).toBe(true);
  const ref = referenceSettle(contribs, holes, t.board, t.dealerSeat, t.maxSeats);
  expect(contribs.filter((c) => c.folded && ref.payouts.has(c.seatIndex))).toEqual([]);
  const finalStacks = t.dealtSeats.map((seatIndex) => ({ seatIndex, stack: t.players[seatIndex]!.stack }));
  expect(finalStacks).toEqual(started.seats.map(({ seatIndex, stack }) => ({
    seatIndex, stack: stack - t.players[seatIndex]!.committedThisHand + (ref.payouts.get(seatIndex) ?? 0),
  })));
  expect((settled.data as unknown as SettledData).stacks).toEqual(finalStacks);
  expect((settled.data as unknown as SettledData).chipTotal).toBe(started.chipTotal);
  expect(potsView(awarded.pots)).toEqual(ref.pots);
  expect(awarded.payouts.filter((p) => p.amount !== 0)).toEqual(entries(ref.payouts).map(([seatIndex, amount]) => ({ seatIndex, amount })));
  expect([...awarded.refunds].sort((a, b) => a.seatIndex - b.seatIndex)).toEqual(entries(ref.refunds).map(([seatIndex, amount]) => ({ seatIndex, amount })));
  expect(potsView(t.awards)).toEqual(ref.pots);
  return ref;
}

const stackOf = (t: EngineTable, seat: number) => t.players[seat]!.stack;

// ---------------------------------------------------------------------------
// 2. Real hands through the state machine.
// ---------------------------------------------------------------------------
describe("real hands settle exactly as the reference", () => {
  it("3-6 short stacks all-in at different amounts build 2-5 pots and settle exactly (300 hands)", () => {
    for (let hand = 0; hand < 300; hand += 1) {
      const n = 3 + below(4);
      const stacks = new Set<number>();
      while (stacks.size < n) stacks.add(15 + below(2000));
      const seats = shuffled(Array.from({ length: 9 }, (_, s) => s)).slice(0, n);
      const layout: (number | null)[] = Array.from({ length: 9 }, () => null);
      [...stacks].forEach((stack, k) => { layout[seats[k]!] = stack; });
      let t = startHand(seatPlayers(layout, { maxSeats: 9 }));
      for (let guard = 0; t.phase !== "SHOWDOWN"; guard += 1) {
        expect(guard).toBeLessThan(50);
        const legal = legalActions(t, t.toActSeat!)!;
        t = act(t, legal.actions.includes("ALL_IN") ? "ALL_IN" : legal.actions.includes("CALL") ? "CALL" : "CHECK");
      }
      const ref = verifySettlement(t);
      // Nobody folds and all stacks differ, so every player below the largest
      // stack is all-in at a distinct amount. That gives n-1 pots: at least
      // three once n >= 4.
      expect(ref.pots).toHaveLength(n - 1);
      expect(t.board).toHaveLength(5);
    }
  }, LONG);

  it("random legal play with timeouts, sit-outs and mid-hand leaves settles exactly (1,000 hands)", () => {
    let hands = 0;
    let multiPot = 0;
    while (hands < 1_000) {
      const maxSeats = 2 + below(8);
      const n = 2 + below(maxSeats - 1);
      const layout: (number | null)[] = Array.from({ length: maxSeats }, () => null);
      for (const seat of shuffled(Array.from({ length: maxSeats }, (_, s) => s)).slice(0, n)) {
        layout[seat] = below(3) === 0 ? 1 + below(40) : 50 + below(1500);
      }
      let t = seatPlayers(layout, { maxSeats, smallBlind: 1 + below(5) });
      for (let tableHand = 0; tableHand < 4 && hands < 1_000; tableHand += 1) {
        const live = t.players.filter((p) => p && p.stack > 0 && !p.sittingOut).length;
        if (live < 2) break;
        t = startHand(t);
        for (let guard = 0; t.phase !== "SHOWDOWN"; guard += 1) {
          expect(guard).toBeLessThan(500);
          expect(t.toActSeat).not.toBeNull();
          t = randomStep(t);
        }
        const ref = verifySettlement(t);
        if (ref.pots.length > 1) multiPot += 1;
        hands += 1;
        t = completeHand(t);
      }
    }
    // Coverage floor: side pots occurred. About a third of stacks are short
    // (1-40 chips against blinds up to 5/10), so multi-pot hands are routine,
    // with an expected count in the hundreds. A floor of 10 cannot fail in
    // practice: by Chernoff the probability is below 1e-20.
    expect(multiPot).toBeGreaterThanOrEqual(10);
  }, LONG);

  function randomStep(t: EngineTable): EngineTable {
    const roll = below(100);
    const dealt = t.dealtSeats.map((s) => t.players[s]!);
    if (roll < 3) return applyTimeout(t);
    if (roll < 5) return sitOut(t, dealt[below(dealt.length)]!.userId);
    if (roll < 6) return leaveSeat(t, dealt[below(dealt.length)]!.userId);
    const legal = legalActions(t, t.toActSeat!)!;
    const weight: Record<ActionType, number> = { FOLD: 3, CHECK: 5, CALL: 5, BET: 2, RAISE: 2, ALL_IN: 1 };
    let pick = below(legal.actions.reduce((s, a) => s + weight[a], 0));
    const action = legal.actions.find((a) => (pick -= weight[a]) < 0)!;
    if (action === "BET" || action === "RAISE") {
      const lo = action === "BET" ? legal.minBet : legal.minRaiseTo;
      const hi = legal.maxRaiseTo;
      return act(t, action, lo >= hi ? hi : lo + below(hi - lo + 1));
    }
    return act(t, action);
  }
});

// ---------------------------------------------------------------------------
// Pot identity: folded players' levels never split a pot.
// ---------------------------------------------------------------------------
describe("a pot is defined by who can win it", () => {
  // Five players and no all-in, so the hand has exactly one pot. Folds at
  // 5 (SB), 25 (BB) and 56 (button) leave U1 and U2 to split 220 chips:
  // 110 each, with no odd chip. Cutting "pots" at the folded players' levels
  // (25 / 80 / 93 / 22) and giving each piece its own odd chip would pay
  // 111 / 109.
  it("a split pot with dead money from several folded players divides evenly (real hand, no all-in)", () => {
    let t = rigRoyalBoard(startHand(seatPlayers([1000, 1000, 1000, 1000, 1000])));
    expect([t.dealerSeat, t.sbSeat, t.bbSeat]).toEqual([0, 1, 2]);
    t = play(t, [
      [3, "RAISE", 25], [4, "CALL"], [0, "CALL"], [1, "FOLD"], [2, "CALL"], // preflop
      [2, "CHECK"], [3, "BET", 20], [4, "CALL"], [0, "CALL"], [2, "FOLD"], // flop
      [3, "BET", 11], [4, "CALL"], [0, "CALL"], // turn
      [3, "BET", 11], [4, "CALL"], [0, "FOLD"], // river
    ]);
    expect(t.players.map((p) => p!.committedThisHand)).toEqual([56, 5, 25, 67, 67]);
    expect(t.players.some((p) => p!.status === "ALL_IN")).toBe(false);
    const ref = verifySettlement(t);
    expect(ref.pots).toEqual([{ amount: 220, eligible: [3, 4], winners: [3, 4], oddChipSeat: null }]);
    expect([stackOf(t, 3), stackOf(t, 4)]).toEqual([1000 - 67 + 110, 1000 - 67 + 110]);
  });

  it("the same contributions through awardPots directly", () => {
    const got = awardPots({
      contribs: [
        { seatIndex: 0, committed: 56, folded: true }, { seatIndex: 1, committed: 5, folded: true },
        { seatIndex: 2, committed: 25, folded: true }, { seatIndex: 3, committed: 67, folded: false },
        { seatIndex: 4, committed: 67, folded: false },
      ],
      holeCards: { 0: ["2c", "2d"], 1: ["3c", "3d"], 2: ["4c", "4d"], 3: ["5c", "6d"], 4: ["5d", "6c"] },
      board: ["Ah", "Kh", "Qh", "Jh", "Th"],
      dealerSeat: 0,
      maxSeats: 5,
    });
    expect(entries(got.payouts)).toEqual([[3, 110], [4, 110]]);
    expect(potsView(got.pots)).toEqual([{ amount: 220, eligible: [3, 4], winners: [3, 4], oddChipSeat: null }]);
  });

  it("dead money from a folded player joins the side pot it reaches, not a new pot", () => {
    // Seat 0 is all-in for 30. Seat 1 folds after putting in 50. Seats 2 and
    // 3 put in 100. That makes a main pot of 4 x 30 = 120 for {0, 2, 3} and
    // ONE side pot of 20 + 70 + 70 = 160 for {2, 3}.
    const got = awardPots({
      contribs: [
        { seatIndex: 0, committed: 30, folded: false }, { seatIndex: 1, committed: 50, folded: true },
        { seatIndex: 2, committed: 100, folded: false }, { seatIndex: 3, committed: 100, folded: false },
      ],
      holeCards: { 0: ["2c", "3d"], 1: ["4c", "5d"], 2: ["6c", "7d"], 3: ["8c", "9d"] },
      board: ["Ah", "Kh", "Qh", "Jh", "Th"],
      dealerSeat: 3,
      maxSeats: 4,
    });
    expect(potsView(got.pots)).toEqual([
      { amount: 120, eligible: [0, 2, 3], winners: [0, 2, 3], oddChipSeat: null },
      { amount: 160, eligible: [2, 3], winners: [2, 3], oddChipSeat: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Pots with zero eligible players: unreachable, and fail-closed.
// ---------------------------------------------------------------------------
/*
 * CLAIM. Through the public API (startHand, applyAction, applyTimeout,
 * sitOut, sitIn, leaveSeat, sitDown, completeHand), at every point of a hand
 * some LIVE (ACTIVE or ALL_IN) player holds the largest committedThisHand.
 *
 * Consequences at settlement. awardPots returns the unique largest
 * commitment down to the second-largest, M2, then cuts pots at the distinct
 * levels.
 *  (a) The uncalled refund goes to a live player, never to a folded one.
 *  (b) The top pot contains the live maximum holder. Each lower pot contains
 *      every contributor of the pots above it. So every pot has at least one
 *      eligible player, and a pot with ZERO eligible players cannot occur.
 *  (c) Folded players are never paid: they are not eligible, and by (a) they
 *      get no refund.
 *
 * Facts from legal.ts / table.ts:
 *  F1. Within a street, currentBet >= every committedThisStreet. It starts
 *      at max(posted blinds, big blind). raiseTo raises it to any larger
 *      target, and calls or short all-ins never exceed it.
 *  F2. A fold happens only in turn and always faces a bet (toCall > 0).
 *      FOLD is legal only then, and applyTimeout folds only when CHECK is
 *      illegal. Its third branch (legal == null) is unreachable, because
 *      toActSeat is assigned only from nextToActSeat/firstToAct, which
 *      require needsAction and therefore canAct.
 *  F3. No out-of-turn status change. Mid-hand, sitOut and leaveSeat only set
 *      sittingOut/pendingLeave, and they send the player to act through
 *      applyTimeout (F2). SIT_OUT and ELIMINATED are assigned only between
 *      hands, to players with nothing committed. sitDown mid-hand gives
 *      SIT_OUT with nothing committed.
 *  F4. A street closes (dealStreet, runout = false) only when no ACTIVE
 *      player needs action, so every ACTIVE player ends it with
 *      committedThisStreet = currentBet.
 *  F5. progressAfterAction ends the betting (runout, showdown) when at most
 *      one player can still bet and that player has already put in at least
 *      as much this street as every other live player. So a lone bettor gets
 *      a decision only if another live player has put in strictly more.
 *
 * Holder lemma. Call a live player H a "holder" if committedThisStreet(H) =
 * currentBet > 0. Then H holds the largest committedThisHand. H is acting on
 * this street, so H was ACTIVE when each earlier street closed. By F4 it paid
 * that street's final currentBet, which by F1 is at least anyone's
 * contribution on that street. On this street, committedThisStreet(H) =
 * currentBet >= everyone's (F1). A folder X is never a holder, because it
 * faces toCall > 0 (F2).
 *
 * Proof by induction over transitions. After the blinds the maximum is the
 * small or big blind, both live. Chips are added only by live players, so a
 * live player keeps the maximum. Statuses change only by in-turn folds (F2,
 * F3). Take a fold by X:
 *   - If a holder exists, it is not X, it stays live, and it holds the
 *     maximum.
 *   - If X has nothing committed, the maximum (> 0: the big blind posted) is
 *     someone else's, and it is live by induction.
 *   - Otherwise there is no holder, and X has chips in. currentBet > 0 with
 *     nobody at it happens only preflop with a short, all-in big blind: a
 *     full big blind would be a holder, and post-flop the first bettor is a
 *     holder. Nobody has called the full bring-in or raised, since that
 *     player would be a holder. So every other player with chips in is
 *     ALL_IN (the big blind or a short all-in), and only the small blind can
 *     fold with chips in, so X is the small blind. Everyone else is folded
 *     or ALL_IN, so X is the lone bettor. By F5, X has a decision only
 *     because a live player put in strictly more, and that player keeps the
 *     maximum after X folds.
 * QED.
 *
 * The tests below exercise exactly these boundaries: a short all-in big
 * blind (the small blind either has no decision or folds under a larger
 * live all-in), and timeouts, sit-outs and leaves with chips committed. The
 * random-play test above covers them at random, and the random scenarios
 * above assert (c) on awardPots itself.
 */
describe("pots never lose their last eligible player", () => {
  const eligibleEverywhere = (t: EngineTable) => {
    for (const pot of t.awards) {
      expect(pot.eligibleSeatIndexes.length).toBeGreaterThan(0);
      expect(pot.winnerSeatIndexes.length).toBeGreaterThan(0);
    }
    for (const seat of t.dealtSeats) {
      if (t.players[seat]!.status === "FOLDED") expect(t.refunds.some((r) => r.seatIndex === seat)).toBe(false);
    }
  };

  it("short all-in big blind (3-handed): once the button folds, the SB already covers it and gets no decision", () => {
    let t = startHand(seatPlayers([1000, 1000, 3]));
    expect(t.players[2]!.status).toBe("ALL_IN");
    t = play(t, [[0, "FOLD"]]);
    // F5: the small blind (5 in) is the lone bettor and already covers the all-in 3, so the board runs out.
    expect(t.players[1]!.status).toBe("ACTIVE");
    const ref = verifySettlement(t);
    eligibleEverywhere(t);
    expect(t.refunds).toEqual([{ seatIndex: 1, amount: 2 }]); // uncalled, returned to a LIVE player
    expect(ref.pots.map((p) => [p.amount, p.eligible])).toEqual([[6, [1, 2]]]);
  });

  it("heads-up: a short all-in big blind leaves the button no decision at all", () => {
    const t = startHand(seatPlayers([1000, 3]));
    expect([t.dealerSeat, t.sbSeat, t.bbSeat]).toEqual([0, 0, 1]);
    expect(t.phase).toBe("SHOWDOWN");
    const ref = verifySettlement(t);
    eligibleEverywhere(t);
    expect(t.refunds).toEqual([{ seatIndex: 0, amount: 2 }]);
    expect(ref.pots.map((p) => [p.amount, p.eligible])).toEqual([[6, [0, 1]]]);
  });


  it("the no-holder fold: SB folds under a larger live all-in, so its dead chips feed the pots and it is paid nothing", () => {
    let t = startHand(seatPlayers([1000, 1000, 3, 7]));
    t = play(t, [[3, "ALL_IN"], [0, "FOLD"]]);
    // Nobody is at the 10-chip bring-in (no holder). The SB has a decision only because a live all-in (7) exceeds its 5.
    t = play(t, [[1, "FOLD"]]);
    const ref = verifySettlement(t);
    eligibleEverywhere(t);
    // SB 5 (folded), BB 3, UTG 7 (2 uncalled): main 3 x 3 = 9 for {2, 3}, then 2 x 2 = 4 for {3}.
    expect(ref.refunds).toEqual(new Map([[3, 2]]));
    expect(ref.pots.map((p) => [p.amount, p.eligible])).toEqual([[9, [2, 3]], [4, [3]]]);
    expect(ref.payouts.get(1)).toBeUndefined();
    expect(stackOf(t, 1)).toBe(995);
  });

  it("timeouts and sit-outs of players with chips in, facing a shove, leave every pot contested", () => {
    let t = startHand(seatPlayers([1000, 1000, 1000, 40]));
    t = play(t, [[3, "ALL_IN"], [0, "RAISE", 200]]);
    expect(t.toActSeat).toBe(1);
    t = sitOut(t, "u2"); // out of turn: the BB stays ACTIVE and is timed out on its turn
    expect(t.players[2]!.status).toBe("ACTIVE");
    t = applyTimeout(t); // SB folds on time; then the sat-out BB is folded automatically
    expect(t.players.map((p) => p!.status)).toEqual(["ACTIVE", "FOLDED", "FOLDED", "ALL_IN"]);
    const ref = verifySettlement(t);
    eligibleEverywhere(t);
    expect(ref.refunds).toEqual(new Map([[0, 160]]));
    expect(ref.pots).toHaveLength(1); // 5 + 10 dead chips join the one pot {0, 3}
    expect(ref.pots[0]!.amount).toBe(95);
  });

  it("a player who leaves out of turn with chips committed is folded only on its own turn", () => {
    let t = startHand(seatPlayers([1000, 1000, 1000]));
    t = play(t, [[0, "RAISE", 30], [1, "CALL"], [2, "CALL"], [1, "BET", 50]]);
    t = leaveSeat(t, "u0");
    expect(t.players[0]!.status).toBe("ACTIVE");
    t = play(t, [[2, "CALL"]]); // seat 0 is now folded on its turn by the time-out path
    expect(t.players[0]!.status).toBe("FOLDED");
    while (t.phase !== "SHOWDOWN") t = act(t, "CHECK");
    verifySettlement(t);
    eligibleEverywhere(t);
    t = completeHand(t);
    expect(t.players[0]).toBeNull();
    expect(t.cashOuts).toEqual([{ userId: "u0", stack: 970 }]);
  });

  it("fails closed: state corrupted out of band into a no-eligible pot is refused with CHIP_INVARIANT", () => {
    let t = startHand(seatPlayers([1000, 1000, 1000, 30]));
    t = play(t, [[3, "ALL_IN"], [0, "RAISE", 100], [1, "CALL"]]);
    // Not reachable through the API (see the proof above). Simulate memory
    // corruption: both 100-chip players are marked folded without acting.
    const corrupt = structuredClone(t);
    corrupt.players[0]!.status = "FOLDED";
    corrupt.players[1]!.status = "FOLDED";
    let error: unknown;
    try { act(corrupt, "FOLD"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe("CHIP_INVARIANT");
  });
});

// ---------------------------------------------------------------------------
// 4. Odd chips.
// ---------------------------------------------------------------------------
describe("odd chips go to the first winner(s) clockwise from the button", () => {
  /** Winners ordered clockwise starting left of the button (the button itself is last). */
  const clockwise = (winners: readonly number[], dealer: number, maxSeats: number) =>
    [...winners].sort((a, b) => ((a - dealer - 1 + maxSeats) % maxSeats) - ((b - dealer - 1 + maxSeats) % maxSeats));

  it("splitOddChips: every table size, button, 2- and 3-winner set and remainder", () => {
    let cases = 0;
    for (let maxSeats = 2; maxSeats <= 9; maxSeats += 1) {
      const seats = Array.from({ length: maxSeats }, (_, s) => s);
      expect(seatingOrderFromBlinds(0, maxSeats)).toEqual([...seats.slice(1), 0]);
      const sets = seats.flatMap((a) => seats.flatMap((b) => [
        ...(b > a ? [[a, b]] : []),
        ...seats.filter((c) => c > b && b > a).map((c) => [a, b, c]),
      ]));
      for (const winners of sets) for (let dealer = 0; dealer < maxSeats; dealer += 1) {
        const w = winners.length;
        for (const amount of [w - 1, w, w + 1, 7 * w + 1, 7 * w + (w - 1), 101]) {
          const { payouts, oddChipSeatIndex } = splitOddChips(amount, shuffled(winners), dealer, maxSeats);
          const order = clockwise(winners, dealer, maxSeats);
          const rem = amount % w;
          expect(order.map((s) => payouts.get(s))).toEqual(order.map((_, i) => Math.floor(amount / w) + (i < rem ? 1 : 0)));
          expect(oddChipSeatIndex).toBe(rem > 0 ? order[0] : null);
          cases += 1;
        }
      }
    }
    expect(cases).toBeGreaterThan(10_000);
  });

  it("heads-up: the big blind (left of the button) gets the odd chip; the button gets it last", () => {
    expect(entries(splitOddChips(5, [0, 1], 0, 2).payouts)).toEqual([[0, 2], [1, 3]]);
    expect(entries(splitOddChips(5, [0, 1], 1, 2).payouts)).toEqual([[0, 3], [1, 2]]);
    // Two players at a 9-seat table, button on seat 7: seat 3 is next clockwise (8, 0, 1, 2, 3).
    expect(splitOddChips(9, [7, 3], 7, 9).oddChipSeatIndex).toBe(3);
    // Heads-up hands themselves never need an odd chip: after the uncalled
    // refund both contributions are equal, so a two-player pot is even.
    const got = awardPots({
      contribs: [{ seatIndex: 0, committed: 7, folded: false }, { seatIndex: 1, committed: 12, folded: false }],
      holeCards: { 0: ["2c", "3d"], 1: ["4c", "5d"] }, board: ["Ah", "Kh", "Qh", "Jh", "Th"], dealerSeat: 0, maxSeats: 2,
    });
    expect(potsView(got.pots)).toEqual([{ amount: 14, eligible: [0, 1], winners: [0, 1], oddChipSeat: null }]);
    expect(entries(got.payouts)).toEqual([[0, 7], [1, 12]]);
  });

  it("awardPots: 2 and 3 tied winners with every remainder and every button position", () => {
    for (let dealer = 0; dealer < 6; dealer += 1) for (const dead of [1, 2, 3, 4, 5]) for (const w of [2, 3]) {
      // Seats 0..w-1 tie on a royal board. Seat 5 folded `dead` chips into the pot.
      const contribs: Contribution[] = [
        ...Array.from({ length: w }, (_, s) => ({ seatIndex: s, committed: 10, folded: false })),
        { seatIndex: 5, committed: dead, folded: true },
      ];
      const holeCards: Record<number, [Card, Card]> = { 0: ["2c", "3d"], 1: ["4c", "5d"], 2: ["6c", "7d"], 5: ["8c", "9d"] };
      const got = awardPots({ contribs, holeCards, board: ["Ah", "Kh", "Qh", "Jh", "Th"], dealerSeat: dealer, maxSeats: 6 });
      const amount = 10 * w + dead;
      const order = clockwise(Array.from({ length: w }, (_, s) => s), dealer, 6);
      const rem = amount % w;
      expect(potsView(got.pots)).toEqual([{ amount, eligible: order.slice().sort(), winners: order.slice().sort(), oddChipSeat: rem ? order[0]! : null }]);
      expect(order.map((s) => got.payouts.get(s))).toEqual(order.map((_, i) => Math.floor(amount / w) + (i < rem ? 1 : 0)));
    }
  });

  it("real hand: a 35-chip pot split three ways gives the two odd chips clockwise from the button, not to the button", () => {
    let t = rigRoyalBoard(startHand(seatPlayers([1000, 1000, 1000, 1000])));
    t = play(t, [[3, "CALL"], [0, "CALL"], [1, "FOLD"], [2, "CHECK"]]);
    while (t.phase !== "SHOWDOWN") t = act(t, "CHECK");
    const ref = verifySettlement(t);
    expect(ref.pots).toEqual([{ amount: 35, eligible: [0, 2, 3], winners: [0, 2, 3], oddChipSeat: 2 }]);
    expect([stackOf(t, 0), stackOf(t, 1), stackOf(t, 2), stackOf(t, 3)]).toEqual([1001, 995, 1002, 1002]);
  });
});
