import type { Card, EvaluatedHand, HandCategory } from "@poker/shared";
import { makeCard, parseCard, RANK_NAME, RANK_PLURAL, type ParsedCard } from "./cards.js";

export type { EvaluatedHand };

const CAT: Record<HandCategory, number> = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
};

function pack(category: HandCategory, kickers: number[]): number {
  let value = CAT[category] << 20;
  const padded = [...kickers, 0, 0, 0, 0, 0].slice(0, 5);
  for (let i = 0; i < 5; i += 1) {
    value |= (padded[i]! & 0xf) << (16 - i * 4);
  }
  return value;
}

/** Highest straight top rank (0=2 … 12=A), or -1. Wheel is 3 (five-high). */
export function straightHigh(rankBits: number): number {
  for (let high = 12; high >= 4; high -= 1) {
    const mask = 0b11111 << (high - 4);
    if ((rankBits & mask) === mask) return high;
  }
  const wheel = (1 << 12) | 0b01111;
  if ((rankBits & wheel) === wheel) return 3;
  return -1;
}

function rankBitsFromCounts(counts: number[]): number {
  let bits = 0;
  for (let r = 0; r < 13; r += 1) if (counts[r]!) bits |= 1 << r;
  return bits;
}

function ranksByCount(counts: number[], n: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0; r -= 1) if (counts[r] === n) out.push(r);
  return out;
}

function kickers(counts: number[], exclude: number[], needed: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < needed; r -= 1) {
    if (exclude.includes(r)) continue;
    const c = counts[r]!;
    for (let i = 0; i < c && out.length < needed; i += 1) out.push(r);
  }
  return out;
}

function straightCards(high: number, suit: number | null, parsed: ParsedCard[]): Card[] {
  const needed =
    high === 3 ? [3, 2, 1, 0, 12] : [high, high - 1, high - 2, high - 3, high - 4];
  const used = new Set<string>();
  const out: Card[] = [];
  for (const rank of needed) {
    const card = parsed.find((p) => p.rank === rank && (suit === null || p.suit === suit) && !used.has(p.code));
    if (!card) throw new Error("Straight reconstruction failed");
    used.add(card.code);
    out.push(card.code);
  }
  return out;
}

function pickByRanks(parsed: ParsedCard[], ranks: number[], preferredSuit: number | null): Card[] {
  const used = new Set<string>();
  const out: Card[] = [];
  for (const rank of ranks) {
    const card =
      parsed.find((p) => p.rank === rank && !used.has(p.code) && (preferredSuit === null || p.suit === preferredSuit)) ??
      parsed.find((p) => p.rank === rank && !used.has(p.code));
    if (!card) throw new Error("Card reconstruction failed");
    used.add(card.code);
    out.push(card.code);
  }
  return out;
}

function describe(category: HandCategory, kickersList: number[]): string {
  const [a, b, c] = kickersList;
  switch (category) {
    case "ROYAL_FLUSH":
      return "Royal Flush";
    case "STRAIGHT_FLUSH":
      return a === 3 ? "Straight Flush, Five-high" : `Straight Flush, ${RANK_NAME[a!]}-high`;
    case "FOUR_OF_A_KIND":
      return `Four of a Kind, ${RANK_PLURAL[a!]}`;
    case "FULL_HOUSE":
      return `Full House, ${RANK_PLURAL[a!]} over ${RANK_PLURAL[b!]}`;
    case "FLUSH":
      return `Flush, ${RANK_NAME[a!]}-high`;
    case "STRAIGHT":
      return a === 3 ? "Straight, Five-high" : `Straight, ${RANK_NAME[a!]}-high`;
    case "THREE_OF_A_KIND":
      return `Three of a Kind, ${RANK_PLURAL[a!]}`;
    case "TWO_PAIR":
      return `Two Pair, ${RANK_PLURAL[a!]} and ${RANK_PLURAL[b!]}`;
    case "ONE_PAIR":
      return `Pair of ${RANK_PLURAL[a!]}`;
    default:
      return `${RANK_NAME[a!]}-high`;
  }
}

export function evaluate5(cards: readonly Card[]): EvaluatedHand {
  if (cards.length !== 5) throw new Error("evaluate5 requires exactly 5 cards");
  const parsed = cards.map(parseCard);
  const counts = new Array<number>(13).fill(0);
  const suitCounts = new Array<number>(4).fill(0);
  for (const p of parsed) {
    counts[p.rank] = (counts[p.rank] ?? 0) + 1;
    suitCounts[p.suit] = (suitCounts[p.suit] ?? 0) + 1;
  }
  const flushSuit = suitCounts.findIndex((n) => n === 5);
  const isFlush = flushSuit >= 0;
  const sHigh = straightHigh(rankBitsFromCounts(counts));
  const isStraight = sHigh >= 0;

  let category: HandCategory;
  let kick: number[];
  let bestFive: Card[];

  if (isFlush && isStraight) {
    category = sHigh === 12 ? "ROYAL_FLUSH" : "STRAIGHT_FLUSH";
    kick = [sHigh];
    bestFive = straightCards(sHigh, flushSuit, parsed);
  } else {
    const quads = ranksByCount(counts, 4);
    const trips = ranksByCount(counts, 3);
    const pairs = ranksByCount(counts, 2);
    if (quads.length) {
      category = "FOUR_OF_A_KIND";
      kick = [quads[0]!, ...kickers(counts, [quads[0]!], 1)];
      bestFive = pickByRanks(parsed, [quads[0]!, quads[0]!, quads[0]!, quads[0]!, kick[1]!], null);
    } else if (trips.length && (pairs.length || trips.length > 1)) {
      category = "FULL_HOUSE";
      const trip = trips[0]!;
      const pair = pairs[0] ?? trips[1]!;
      kick = [trip, pair];
      bestFive = pickByRanks(parsed, [trip, trip, trip, pair, pair], null);
    } else if (isFlush) {
      category = "FLUSH";
      kick = [...parsed.map((p) => p.rank)].sort((a, b) => b - a);
      bestFive = pickByRanks(parsed, kick, flushSuit);
    } else if (isStraight) {
      category = "STRAIGHT";
      kick = [sHigh];
      bestFive = straightCards(sHigh, null, parsed);
    } else if (trips.length) {
      category = "THREE_OF_A_KIND";
      kick = [trips[0]!, ...kickers(counts, [trips[0]!], 2)];
      bestFive = pickByRanks(parsed, [trips[0]!, trips[0]!, trips[0]!, kick[1]!, kick[2]!], null);
    } else if (pairs.length >= 2) {
      category = "TWO_PAIR";
      const k = kickers(counts, [pairs[0]!, pairs[1]!], 1)[0]!;
      kick = [pairs[0]!, pairs[1]!, k];
      bestFive = pickByRanks(parsed, [pairs[0]!, pairs[0]!, pairs[1]!, pairs[1]!, k], null);
    } else if (pairs.length === 1) {
      category = "ONE_PAIR";
      kick = [pairs[0]!, ...kickers(counts, [pairs[0]!], 3)];
      bestFive = pickByRanks(parsed, [pairs[0]!, pairs[0]!, kick[1]!, kick[2]!, kick[3]!], null);
    } else {
      category = "HIGH_CARD";
      kick = [...parsed.map((p) => p.rank)].sort((a, b) => b - a);
      bestFive = pickByRanks(parsed, kick, null);
    }
  }

  return {
    category,
    rankValue: pack(category, kick),
    name: describe(category, kick),
    bestFive,
  };
}

function kCombinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const n = items.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  const take = () => idx.map((i) => items[i]!);
  for (;;) {
    out.push(take());
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) break;
    idx[i] = (idx[i] ?? 0) + 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1]! + 1;
  }
  return out;
}

/**
 * Best 5-card poker hand from 5–7 cards. 7-card path enumerates C(7,5)=21
 * combinations (well under a microsecond) so kickers are exact.
 */
export function evaluate(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error("evaluate requires 5–7 cards");
  }
  if (cards.length === 5) return evaluate5(cards);
  let best: EvaluatedHand | null = null;
  for (const combo of kCombinations(cards, 5)) {
    const hand = evaluate5(combo);
    if (!best || hand.rankValue > best.rankValue) best = hand;
  }
  return best!;
}

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  return a.rankValue - b.rankValue;
}

/** Unused helper kept for tests / debugging of encoded values. */
export function royalFlushOf(suit: number): Card[] {
  return [12, 11, 10, 9, 8].map((r) => makeCard(r, suit));
}
