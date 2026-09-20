import { RANKS, SUITS, type Card, type Rank, type Suit } from "@poker/shared";

export const RANK_INDEX: Record<Rank, number> = {
  "2": 0,
  "3": 1,
  "4": 2,
  "5": 3,
  "6": 4,
  "7": 5,
  "8": 6,
  "9": 7,
  T: 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
};

export const SUIT_INDEX: Record<Suit, number> = { c: 0, d: 1, h: 2, s: 3 };

export const INDEX_RANK: Rank[] = [...RANKS];
export const INDEX_SUIT: Suit[] = [...SUITS];

export const RANK_NAME = [
  "Deuce",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Jack",
  "Queen",
  "King",
  "Ace",
] as const;

export const RANK_PLURAL = [
  "Deuces",
  "Threes",
  "Fours",
  "Fives",
  "Sixes",
  "Sevens",
  "Eights",
  "Nines",
  "Tens",
  "Jacks",
  "Queens",
  "Kings",
  "Aces",
] as const;

export interface ParsedCard {
  code: Card;
  rank: number;
  suit: number;
}

const CARD_RE = /^([2-9TJQKA])([cdhs])$/;

export function parseCard(code: string): ParsedCard {
  const m = CARD_RE.exec(code);
  if (!m) throw new Error(`Invalid card: ${code}`);
  const rank = m[1] as Rank;
  const suit = m[2] as Suit;
  return { code: code as Card, rank: RANK_INDEX[rank], suit: SUIT_INDEX[suit] };
}

export function makeCard(rank: number, suit: number): Card {
  return `${INDEX_RANK[rank]}${INDEX_SUIT[suit]}` as Card;
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}
