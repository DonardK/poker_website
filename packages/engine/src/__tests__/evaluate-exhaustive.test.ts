/**
 * Requirement 4: showdown hand evaluation (GLI-19 outcome correctness).
 *
 * What this file proves about `evaluate5` / `evaluate` (evaluate.ts):
 * 1. Exhaustive 5-card check. All C(52,5) = 2,598,960 five-card hands are
 *    classified. Category frequencies equal the combinatorial counts. There
 *    are exactly 7,462 distinct rank values, with the standard number of
 *    classes per category. Engine rank order equals an independent reference
 *    order: rankValue is a strictly increasing bijection onto the reference
 *    equivalence classes. So on five cards, "higher rankValue wins, equal
 *    rankValue ties" is exactly the rule of poker.
 * 2. Differential 7-card check. An independent reference evaluator works
 *    directly from 7 cards (rank counts, per-suit 13-bit masks, straight
 *    detection on the rank mask) and never enumerates 5-card subsets.
 *    evaluate() agrees with it on:
 *    (a) >= 300,000 random 7-card hands: category, the full total order, and
 *        bestFive (5 distinct input cards whose own value equals the 7-card
 *        value);
 *    (b) >= 200,000 random 2-4 player showdowns on a shared board: identical
 *        winner sets, including splits.
 * 3. Hand-written edge cases (wheels, long straights, SF vs straight, double
 *    trips, three pairs, quads/board plays, counterfeits, 6-7 suited cards,
 *    the full kicker chain, suit-only differences).
 *
 * Determinism: test inputs are drawn from node:crypto, so no seed is
 * involved. Every check is exact, not statistical, so no check can fail by
 * chance. Any failure is a real defect, and its message prints the concrete
 * cards needed to reproduce it.
 */
import { randomFillSync } from "node:crypto";
import type { Card, EvaluatedHand, HandCategory } from "@poker/shared";
import { evaluate, evaluate5 } from "../evaluate.js";

// ---------------------------------------------------------------------------
// Independent reference evaluator (shares no code with evaluate.ts).
// ---------------------------------------------------------------------------
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
const DECK: Card[] = [...RANKS].flatMap((r) => [...SUITS].map((s) => `${r}${s}` as Card));

/** Reference categories, weakest first. A royal flush is the ace-high straight flush. */
const REF_CATEGORY = [
  "HIGH_CARD", "ONE_PAIR", "TWO_PAIR", "THREE_OF_A_KIND", "STRAIGHT", "FLUSH", "FULL_HOUSE", "FOUR_OF_A_KIND", "STRAIGHT_FLUSH",
] as const;

interface RefHand { category: (typeof REF_CATEGORY)[number]; royal: boolean; tuple: number[]; key: number }

/** Top rank of the highest straight in a 13-bit rank mask (bit r = rank r, 0 = deuce); 3 for the wheel; -1 if none. */
function refStraightTop(mask: number): number {
  for (let top = 12; top >= 4; top -= 1) if (((mask >> (top - 4)) & 0x1f) === 0x1f) return top;
  return (mask & 0x100f) === 0x100f ? 3 : -1; // A-2-3-4-5
}

/** The `n` highest ranks present in `mask`, skipping `skip`. */
function refTop(mask: number, n: number, skip: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r -= 1) if ((mask >> r) & 1 && !skip.includes(r)) out.push(r);
  return out;
}

/** Best poker hand of 5-7 cards, computed directly (no combinations). Compare with `key`: higher wins, equal ties. */
function refEvaluate(cards: readonly string[]): RefHand {
  const count = new Array<number>(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let rankMask = 0;
  for (const card of cards) {
    const r = RANKS.indexOf(card[0]!);
    const s = SUITS.indexOf(card[1]!);
    if (card.length !== 2 || r < 0 || s < 0 || (suitMask[s]! >> r) & 1) throw new Error(`bad or duplicate card ${card}`);
    count[r]! += 1;
    suitMask[s]! |= 1 << r;
    suitCount[s]! += 1;
    rankMask |= 1 << r;
  }
  const withCount = (n: number) => { const out: number[] = []; for (let r = 12; r >= 0; r -= 1) if (count[r] === n) out.push(r); return out; };
  const quads = withCount(4), trips = withCount(3), pairs = withCount(2);
  const fs = suitCount.findIndex((n) => n >= 5);
  const flushMask = fs >= 0 ? suitMask[fs]! : 0;
  const sfTop = fs >= 0 ? refStraightTop(flushMask) : -1;
  const straightTop = refStraightTop(rankMask);
  let cat: number;
  let tuple: number[];
  if (sfTop >= 0) { cat = 8; tuple = [sfTop]; }
  else if (quads.length) { cat = 7; tuple = [quads[0]!, ...refTop(rankMask, 1, [quads[0]!])]; }
  else if (trips.length && trips.length + pairs.length >= 2) { cat = 6; tuple = [trips[0]!, Math.max(trips[1] ?? -1, pairs[0] ?? -1)]; }
  else if (fs >= 0) { cat = 5; tuple = refTop(flushMask, 5); }
  else if (straightTop >= 0) { cat = 4; tuple = [straightTop]; }
  else if (trips.length) { cat = 3; tuple = [trips[0]!, ...refTop(rankMask, 2, [trips[0]!])]; }
  else if (pairs.length >= 2) { cat = 2; tuple = [pairs[0]!, pairs[1]!, ...refTop(rankMask, 1, [pairs[0]!, pairs[1]!])]; }
  else if (pairs.length === 1) { cat = 1; tuple = [pairs[0]!, ...refTop(rankMask, 3, [pairs[0]!])]; }
  else { cat = 0; tuple = refTop(rankMask, 5); }
  let key = cat;
  for (let i = 0; i < 5; i += 1) key = key * 13 + (tuple[i] ?? 0);
  return { category: REF_CATEGORY[cat]!, royal: cat === 8 && tuple[0] === 12, tuple, key };
}

/** Engine category agrees with the reference (ROYAL_FLUSH is exactly the ace-high straight flush). */
function sameCategory(engine: HandCategory, ref: RefHand): boolean {
  return engine === "ROYAL_FLUSH" ? ref.royal : !ref.royal && engine === ref.category;
}

/** bestFive must be 5 distinct cards from the input whose own values (engine and reference) equal the full hand's. */
function bestFiveProblem(cards: readonly Card[], ev: EvaluatedHand, refKey: number): string | null {
  const five = ev.bestFive;
  if (five.length !== 5 || new Set(five).size !== 5) return "bestFive is not 5 distinct cards";
  if (five.some((c) => !cards.includes(c))) return "bestFive uses a card outside the hand";
  if (evaluate5(five).rankValue !== ev.rankValue) return "evaluate5(bestFive) differs from the hand value";
  if (refEvaluate(five).key !== refKey) return "bestFive is not a best five (reference)";
  return null;
}

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
const pool = new Uint8Array(52);
/** `n` distinct uniformly random card indexes (partial Fisher-Yates). */
function drawIndexes(n: number): number[] {
  for (let i = 0; i < 52; i += 1) pool[i] = i;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const j = i + below(52 - i);
    const t = pool[i]!; pool[i] = pool[j]!; pool[j] = t;
    out.push(pool[i]!);
  }
  return out;
}

const cardsOf = (s: string) => s.trim().split(/\s+/) as Card[];
const LONG = 180_000;

describe("evaluate5: exhaustive over all 2,598,960 five-card hands", () => {
  it("has exact category counts, 7,462 classes, and the reference total order", () => {
    const catCount = new Map<HandCategory, number>();
    const valueToKey = new Map<number, number>();
    const keyToValue = new Map<number, number>();
    const valueCategory = new Map<number, HandCategory>();
    const problems: string[] = [];
    const note = (msg: string, hand: readonly Card[]) => { if (problems.length < 10) problems.push(`${msg}: ${hand.join(" ")}`); };
    const hand: Card[] = new Array<Card>(5);
    let hands = 0;
    for (let a = 0; a < 52; a += 1) for (let b = a + 1; b < 52; b += 1) for (let c = b + 1; c < 52; c += 1)
      for (let d = c + 1; d < 52; d += 1) for (let e = d + 1; e < 52; e += 1) {
        hand[0] = DECK[a]!; hand[1] = DECK[b]!; hand[2] = DECK[c]!; hand[3] = DECK[d]!; hand[4] = DECK[e]!;
        hands += 1;
        const ev = evaluate5(hand);
        const ref = refEvaluate(hand);
        catCount.set(ev.category, (catCount.get(ev.category) ?? 0) + 1);
        if (!sameCategory(ev.category, ref)) note(`category ${ev.category} vs reference ${ref.category}`, hand);
        // Class consistency both ways: equal reference class <=> equal rankValue.
        const k = valueToKey.get(ev.rankValue);
        if (k === undefined) valueToKey.set(ev.rankValue, ref.key); else if (k !== ref.key) note("one rankValue covers two reference classes", hand);
        const v = keyToValue.get(ref.key);
        if (v === undefined) keyToValue.set(ref.key, ev.rankValue); else if (v !== ev.rankValue) note("one reference class has two rankValues", hand);
        valueCategory.set(ev.rankValue, ev.category);
        // bestFive of a 5-card hand is a permutation of it (each input position used exactly once).
        let used = 0;
        for (const card of ev.bestFive) { const p = hand.indexOf(card); used |= p < 0 || used & (1 << p) ? 64 : 1 << p; }
        if (ev.bestFive.length !== 5 || used !== 31) note("bestFive is not the hand", hand);
      }
    expect(problems).toEqual([]);
    expect(hands).toBe(2_598_960);
    expect(Object.fromEntries(catCount)).toEqual({
      ROYAL_FLUSH: 4, STRAIGHT_FLUSH: 36, FOUR_OF_A_KIND: 624, FULL_HOUSE: 3_744, FLUSH: 5_108,
      STRAIGHT: 10_200, THREE_OF_A_KIND: 54_912, TWO_PAIR: 123_552, ONE_PAIR: 1_098_240, HIGH_CARD: 1_302_540,
    });
    expect(valueToKey.size).toBe(7_462);
    expect(keyToValue.size).toBe(7_462);
    const classes = new Map<HandCategory, number>();
    for (const cat of valueCategory.values()) classes.set(cat, (classes.get(cat) ?? 0) + 1);
    expect((classes.get("STRAIGHT_FLUSH") ?? 0) + (classes.get("ROYAL_FLUSH") ?? 0)).toBe(10);
    expect(Object.fromEntries(classes)).toEqual({
      ROYAL_FLUSH: 1, STRAIGHT_FLUSH: 9, FOUR_OF_A_KIND: 156, FULL_HOUSE: 156, FLUSH: 1_277,
      STRAIGHT: 10, THREE_OF_A_KIND: 858, TWO_PAIR: 858, ONE_PAIR: 2_860, HIGH_CARD: 1_277,
    });
    // Engine order == reference order: sorting the 7,462 classes by reference key gives strictly increasing rankValues.
    const byKey = [...keyToValue].sort(([x], [y]) => x - y);
    for (let i = 1; i < byKey.length; i += 1) expect(byKey[i]![1] > byKey[i - 1]![1]).toBe(true);
    // Every hand of a higher category outranks every hand of a lower one.
    const ORDER: HandCategory[] = ["HIGH_CARD", "ONE_PAIR", "TWO_PAIR", "THREE_OF_A_KIND", "STRAIGHT", "FLUSH", "FULL_HOUSE", "FOUR_OF_A_KIND", "STRAIGHT_FLUSH", "ROYAL_FLUSH"];
    const values = (cat: HandCategory) => [...valueCategory].filter(([, c]) => c === cat).map(([v]) => v);
    for (let i = 1; i < ORDER.length; i += 1) {
      expect(Math.min(...values(ORDER[i]!))).toBeGreaterThan(Math.max(...values(ORDER[i - 1]!)));
    }
  }, LONG);
});

describe("evaluate: differential against the independent 7-card reference", () => {
  it("(a) 300,000 random 7-card hands: same category, same total order, valid bestFive", () => {
    const N = 300_000;
    const hands = new Uint8Array(N * 7);
    const refKeys = new Float64Array(N);
    const values = new Float64Array(N);
    const problems: string[] = [];
    const show = (i: number) => [...hands.subarray(i * 7, i * 7 + 7)].map((x) => DECK[x]).join(" ");
    for (let i = 0; i < N; i += 1) {
      const idx = drawIndexes(7);
      hands.set(idx, i * 7);
      const cards = idx.map((x) => DECK[x]!);
      const ev = evaluate(cards);
      const ref = refEvaluate(cards);
      refKeys[i] = ref.key;
      values[i] = ev.rankValue;
      if (!sameCategory(ev.category, ref) && problems.length < 10) problems.push(`category ${ev.category} vs ${ref.category}: ${show(i)}`);
      const bad = bestFiveProblem(cards, ev, ref.key);
      if (bad && problems.length < 10) problems.push(`${bad}: ${show(i)} -> ${ev.bestFive.join(" ")}`);
    }
    expect(problems).toEqual([]);
    // Total order: after sorting by reference key, adjacent hands must compare the same way in the engine.
    // Adjacent agreement plus transitivity gives agreement on every pair in the sample.
    const order = Array.from({ length: N }, (_, i) => i).sort((x, y) => refKeys[x]! - refKeys[y]!);
    for (let n = 1; n < N; n += 1) {
      const i = order[n - 1]!, j = order[n]!;
      const ok = refKeys[i] === refKeys[j] ? values[i] === values[j] : values[i]! < values[j]!;
      if (!ok && problems.length < 10) problems.push(`order differs: [${show(i)}] vs [${show(j)}]`);
    }
    // Random pairs: sign(engine difference) == sign(reference difference).
    for (let n = 0; n < N; n += 1) {
      const i = below(N), j = below(N);
      if (Math.sign(values[i]! - values[j]!) !== Math.sign(refKeys[i]! - refKeys[j]!) && problems.length < 10) {
        problems.push(`pair sign differs: [${show(i)}] vs [${show(j)}]`);
      }
    }
    expect(problems).toEqual([]);
  }, LONG);

  it("(b) 200,000 random 2-4 player showdowns: identical winner sets including splits", () => {
    const N = 200_000;
    const problems: string[] = [];
    const splits = [0, 0, 0, 0, 0];
    for (let n = 0; n < N; n += 1) {
      const players = 2 + below(3);
      const cards = drawIndexes(5 + 2 * players).map((x) => DECK[x]!);
      const board = cards.slice(0, 5);
      const holes = Array.from({ length: players }, (_, p) => cards.slice(5 + 2 * p, 7 + 2 * p));
      const engine = holes.map((h) => evaluate([...h, ...board]).rankValue);
      const ref = holes.map((h) => refEvaluate([...h, ...board]).key);
      const eBest = Math.max(...engine), rBest = Math.max(...ref);
      const eWin = engine.flatMap((v, p) => (v === eBest ? [p] : []));
      const rWin = ref.flatMap((v, p) => (v === rBest ? [p] : []));
      if (eWin.join() !== rWin.join() && problems.length < 10) {
        problems.push(`board ${board.join(" ")} holes ${holes.map((h) => h.join(" ")).join(" | ")}: engine ${eWin} reference ${rWin}`);
      }
      if (rWin.length > 1) splits[players]! += 1;
    }
    expect(problems).toEqual([]);
    // Coverage floor: split pots were compared at every table size. This is
    // the only probabilistic assertion in this file. Measured split rates are
    // 4.1% (2 players), 4.6% (3) and 5.4% (4). Assume only p > 1%. Then, per
    // size, "size k and split" has probability > 1/300, so the expected count
    // is mu > 666. Chernoff gives P(X <= 9) <= exp(-mu (1 - 9/mu)^2 / 2) < 1e-140
    // per size, and below 1e-139 for the whole file.
    expect(Math.min(splits[2]!, splits[3]!, splits[4]!)).toBeGreaterThanOrEqual(10);
  }, LONG);
});

describe("evaluate: hand-written edge cases", () => {
  /** Evaluate with both evaluators and check category agreement and bestFive validity. */
  function ev(s: string): EvaluatedHand {
    const cards = cardsOf(s);
    const e = evaluate(cards);
    const r = refEvaluate(cards);
    expect({ hand: s, category: e.category, bestFive: bestFiveProblem(cards, e, r.key) })
      .toEqual({ hand: s, category: r.royal ? "ROYAL_FLUSH" : r.category, bestFive: null });
    return e;
  }
  /** Winners (indexes into holes) by the engine; the reference must agree. */
  function winners(board: string, ...holes: string[]): number[] {
    const e = holes.map((h) => evaluate(cardsOf(`${h} ${board}`)).rankValue);
    const r = holes.map((h) => refEvaluate(cardsOf(`${h} ${board}`)).key);
    const eWin = e.flatMap((v, i) => (v === Math.max(...e) ? [i] : []));
    const rWin = r.flatMap((v, i) => (v === Math.max(...r) ? [i] : []));
    expect(eWin).toEqual(rWin);
    return eWin;
  }
  const five = (h: EvaluatedHand) => [...h.bestFive].sort().join(" ");

  it("wheel A-2-3-4-5 is a five-high straight, below 6-high; A-2-3-4-5-6 plays 6-high", () => {
    const wheel = ev("As 2d 3c 4h 5s Kd 9c");
    expect(wheel.category).toBe("STRAIGHT");
    expect(wheel.name).toBe("Straight, Five-high");
    expect(five(wheel)).toBe(["As", "2d", "3c", "4h", "5s"].sort().join(" "));
    expect(ev("2d 3c 4h 5s 6h Kd 9c").rankValue).toBeGreaterThan(wheel.rankValue);
    expect(ev("As 2d 3c 4h 5s 6d Kc").name).toBe("Straight, Six-high");
    expect(winners("2c 3d 4h 5s Kd", "Ac 9d", "6c 9h", "Ad 6d")).toEqual([1, 2]);
  });

  it("steel wheel is the lowest straight flush and beats quads", () => {
    const steel = ev("Ah 2h 3h 4h 5h Kc Kd");
    expect(steel.category).toBe("STRAIGHT_FLUSH");
    expect(steel.name).toBe("Straight Flush, Five-high");
    expect(steel.rankValue).toBeGreaterThan(ev("Ks Kh Kc Kd Ah 2c 3c").rankValue);
    expect(steel.rankValue).toBeLessThan(ev("2h 3h 4h 5h 6h Kc Kd").rankValue);
    expect(ev("Ah Kh Qh Jh Th 9h 8h").category).toBe("ROYAL_FLUSH");
  });

  it("6- and 7-card straights play the highest five", () => {
    expect(ev("3c 4d 5h 6s 7c 8d 9h").name).toBe("Straight, Nine-high");
    expect(ev("2c 3d 4h 5s 6c 7d Kh").name).toBe("Straight, Seven-high");
    expect(ev("Ac Kd Qh Js Tc 9d 8h").name).toBe("Straight, Ace-high");
  });

  it("straight flush beats a higher plain straight in the same cards; disjoint straight + flush is a flush", () => {
    const sf = ev("5h 6h 7h 8h 9h Ts Jd");
    expect(sf.category).toBe("STRAIGHT_FLUSH");
    expect(sf.name).toBe("Straight Flush, Nine-high");
    expect(ev("9h 8h 7h 6h 5h Ah Kc").name).toBe("Straight Flush, Nine-high");
    const flush = ev("4h 5h 6h 7h 9h 8c Kd");
    expect(flush.category).toBe("FLUSH");
    expect(five(flush)).toBe(["4h", "5h", "6h", "7h", "9h"].sort().join(" "));
    expect(winners("5h 6h 7h 8h Tc", "9h 2c", "9d Jc")).toEqual([0]);
  });

  it("two trips make a full house with the higher trips over; trips + two pairs uses the higher pair", () => {
    const kings = ev("Kh Kd Kc 7s 7h 7d 2c");
    expect(kings.name).toBe("Full House, Kings over Sevens");
    expect(kings.rankValue).toBeGreaterThan(ev("7s 7h 7d Kh Kd 2c 3d").rankValue);
    expect(ev("Qh Qd Qc 9s 9h 4d 4c").name).toBe("Full House, Queens over Nines");
  });

  it("three pairs play the best two pairs plus the best remaining card (possibly from the third pair)", () => {
    const kKicker = ev("Ah Ad 9c 9s 5h 5d Kc");
    const fiveKicker = ev("Ah Ad 9c 9s 5h 5d 2c");
    expect(kKicker.name).toBe("Two Pair, Aces and Nines");
    expect(five(fiveKicker)).toContain("5");
    expect(kKicker.rankValue).toBeGreaterThan(fiveKicker.rankValue);
    expect(ev("As Ah Ks Kh Qs Qh 2c").rankValue).toBe(ev("Ad Ac Kd Kc Qd 3h 2h").rankValue);
  });

  it("quads on board: kicker decides, and a board kicker splits", () => {
    expect(winners("8c 8d 8h 8s Kc", "Ah 2d", "Qh Jd", "2c 3c")).toEqual([0]);
    expect(winners("8c 8d 8h 8s Kc", "Qh Jd", "2c 3c")).toEqual([0, 1]);
    expect(winners("8c 8d 8h 8s Ac", "Kh Kd", "2c 3c", "Ad Ah")).toEqual([0, 1, 2]);
  });

  it("board plays: everybody splits", () => {
    expect(winners("Ah Kd Qs Jc Th", "2c 3d", "4s 5h", "9c 9d", "Ac Kc")).toEqual([0, 1, 2, 3]);
    expect(winners("As Ks Qs Js Ts", "Ah Ad", "9s 8s")).toEqual([0, 1]);
  });

  it("counterfeited two pair splits; a live second pair wins", () => {
    // Hero's pair of threes is counterfeited by the board's eights and king kicker.
    expect(winners("Ac 3d 8h 8s Kc", "Ah 3c", "Ad Qs")).toEqual([0, 1]);
    expect(winners("Ac 3d 8h 8s Kc", "Ah 3c", "Ad Qs", "As Kd")).toEqual([2]);
  });

  it("flush with 6-7 suited cards uses the top five of the suit", () => {
    const seven = ev("Ah Jh 9h 6h 4h 3h 2h");
    expect(five(seven)).toBe(["Ah", "Jh", "9h", "6h", "4h"].sort().join(" "));
    expect(seven.rankValue).toBeGreaterThan(ev("Ah Jh 9h 6h 3h 2h Kc").rankValue);
    expect(five(ev("Kh Th 8h 6h 4h 2h As"))).toBe(["Kh", "Th", "8h", "6h", "4h"].sort().join(" "));
    // Board flush: a small heart does not play; a higher heart does.
    expect(winners("Kh Th 8h 6h 4h", "2h 3c", "2c 3d")).toEqual([0, 1]);
    expect(winners("Kh Th 8h 6h 4h", "2h 3c", "Ah 2c")).toEqual([1]);
  });

  it("high-card kicker chain is compared down to the fifth card", () => {
    const pairs: [string, string][] = [
      ["Ac Qd Th 8s 6c 3d 2h", "Kc Qd Th 8s 6c 3d 2h"], // 1st card: ace-high beats king-high
      ["Ac Kd 9h 7s 5c 3d 2h", "Ac Qd 9h 7s 5c 3d 2h"], // 2nd
      ["Ac Kd Qh 7s 5c 3d 2h", "Ac Kd Jh 7s 5c 3d 2h"], // 3rd
      ["Ac Kd Qh 8s 5c 3d 2h", "Ac Kd Qh 7s 5c 3d 2h"], // 4th
      ["Ac Kd Qh 8s 6c 3d 2h", "Ac Kd Qh 8s 5c 3d 2h"], // 5th
    ];
    for (const [hi, lo] of pairs) {
      expect(ev(hi).category).toBe("HIGH_CARD");
      expect(ev(hi).rankValue).toBeGreaterThan(ev(lo).rankValue);
    }
    // A sixth or seventh card never counts.
    expect(ev("Ac Kd Qh 8s 6c 4d 2h").rankValue).toBe(ev("Ac Kd Qh 8s 6c 3d 2h").rankValue);
    expect(winners("Ac Kd Qh Js 7c", "9d 2s", "8d 3s")).toEqual([0]);
    expect(winners("Ac Kd Qh Js 7c", "6d 2s", "5d 3s")).toEqual([0, 1]);
  });

  it("identical hands in different suits tie", () => {
    expect(winners("2c 7d 9h Js Kc", "Ah Qd", "As Qc")).toEqual([0, 1]);
    expect(ev("Ah Kh Qh Jh 9h 2c 3d").rankValue).toBe(ev("As Ks Qs Js 9s 2d 3c").rankValue);
  });
});
