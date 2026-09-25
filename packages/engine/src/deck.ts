import type { Card } from "@poker/shared";
import { fullDeck } from "./cards.js";
import { CsprngWordStream, uniformFromWords } from "./rng.js";

export interface DealtHand {
  /** Remaining undealt cards, top of deck at index 0. */
  deck: Card[];
  burns: Card[];
  board: Card[];
  holeCards: [Card, Card][];
}

/**
 * Fisher-Yates shuffle, Durstenfeld's in-place variant, applied to a copy.
 *
 * COMPLIANCE NOTE (unbiased shuffle): at step i (from n-1 down to 1), the
 * swap index j is drawn uniformly from [0, i], including i itself. The draw
 * sequence (j_{n-1}, ..., j_1) has n! equally likely values. Each value gives
 * a different permutation, so each of the n! permutations (52! for a deck)
 * has the same probability. The deterministic `uniformIndex` parameter lets
 * tests enumerate every draw sequence and prove this bijection. In production,
 * only `shuffle`/`shuffledDeck` call this function, and they always supply the
 * OS CSPRNG.
 */
export function durstenfeldShuffle<T>(input: readonly T[], uniformIndex: (rangeExclusive: number) => number): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = uniformIndex(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError("Shuffle index out of range");
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

/** Unbiased shuffle driven by the OS CSPRNG with explicit rejection sampling. */
export function shuffle<T>(input: readonly T[]): T[] {
  const stream = new CsprngWordStream();
  try {
    return durstenfeldShuffle(input, (range) => uniformFromWords(range, () => stream.next()));
  } finally {
    stream.dispose();
  }
}

/** A fresh, uniformly shuffled 52-card deck. The only deck source for live hands. */
export function shuffledDeck(): Card[] {
  return shuffle(fullDeck());
}

/** Order eligible seats starting immediately left of the dealer, across empty seats. */
export function dealOrderFromDealer(dealerSeat: number, maxSeats: number, eligibleSeats: readonly number[]): number[] {
  const eligible = new Set(eligibleSeats);
  const order: number[] = [];
  for (let step = 1; step <= maxSeats; step++) {
    const seat = (dealerSeat + step) % maxSeats;
    if (eligible.has(seat)) order.push(seat);
  }
  return order;
}

function take(deck: Card[]): Card {
  const card = deck.shift();
  if (!card) throw new Error("Deck exhausted");
  return card;
}

/**
 * Casino deal: two hole-card orbits from the first live seat, then
 * burn-flop, burn-turn, burn-river. Callers may deal streets later by
 * keeping the leftover deck.
 */
export function dealHoleCards(deck: Card[], liveCount: number): { holeCards: [Card, Card][]; deck: Card[] } {
  const next = deck.slice();
  const first: Card[] = [];
  const second: Card[] = [];
  for (let i = 0; i < liveCount; i += 1) first.push(take(next));
  for (let i = 0; i < liveCount; i += 1) second.push(take(next));
  return {
    deck: next,
    holeCards: first.map((c, i) => [c, second[i]!] as [Card, Card]),
  };
}

export function burnAndDealFlop(deck: Card[]): { deck: Card[]; burn: Card; flop: [Card, Card, Card] } {
  const next = deck.slice();
  const burn = take(next);
  return { deck: next, burn, flop: [take(next), take(next), take(next)] };
}

export function burnAndDealOne(deck: Card[]): { deck: Card[]; burn: Card; card: Card } {
  const next = deck.slice();
  const burn = take(next);
  return { deck: next, burn, card: take(next) };
}
