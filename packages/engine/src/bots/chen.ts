import { parseCard } from "../cards.js";
import type { Card } from "@poker/shared";

const CHEN_FACE = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10];

export function chenScore(hole: [Card, Card]): number {
  const a = parseCard(hole[0]);
  const b = parseCard(hole[1]);
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  let score = CHEN_FACE[high]!;
  if (a.rank === b.rank) {
    score = Math.max(5, score * 2);
    return score;
  }
  if (a.suit === b.suit) score += 2;
  const gap = high - low - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;
  if (gap < 2 && high < 10) score += 1;
  return score;
}
