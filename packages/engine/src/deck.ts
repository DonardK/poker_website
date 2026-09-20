import type { Card } from "@poker/shared";
import { fullDeck } from "./cards.js";
import { secureRandomInt } from "./rng.js";

export interface DealtHand {
  /** Remaining undealt cards, top of deck at index 0. */
  deck: Card[];
  burns: Card[];
  board: Card[];
  holeCards: [Card, Card][];
}

export function shuffle<T>(input: readonly T[]): T[] {
  const deck = input.slice();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    const a = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = a;
  }
  return deck;
}

export function shuffledDeck(): Card[] {
  return shuffle(fullDeck());
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
