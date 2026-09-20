export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Suit = "c" | "d" | "h" | "s";
export type Card = `${Rank}${Suit}`;

export const RANKS: readonly Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const SUITS: readonly Suit[] = ["c", "d", "h", "s"];

export type HandCategory =
  | "HIGH_CARD"
  | "ONE_PAIR"
  | "TWO_PAIR"
  | "THREE_OF_A_KIND"
  | "STRAIGHT"
  | "FLUSH"
  | "FULL_HOUSE"
  | "FOUR_OF_A_KIND"
  | "STRAIGHT_FLUSH"
  | "ROYAL_FLUSH";

export interface EvaluatedHand {
  category: HandCategory;
  /** Higher is stronger. Encodes category + kickers. */
  rankValue: number;
  name: string;
  bestFive: readonly Card[];
}

export interface PotShare {
  potIndex: number;
  amount: number;
  eligibleSeatIndexes: readonly number[];
  winnerSeatIndexes: readonly number[];
  /** Casino odd-chip rule: earliest position past the blinds. */
  oddChipSeatIndex: number | null;
}
