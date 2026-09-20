import { parseCard } from "../cards.js";
import type { Card } from "@poker/shared";

export interface BoardTexture {
  wet: boolean;
  flushDraw: boolean;
  straightDraw: boolean;
  paired: boolean;
  monotone: boolean;
}

export function analyzeBoard(board: readonly Card[]): BoardTexture {
  if (board.length < 3) {
    return { wet: false, flushDraw: false, straightDraw: false, paired: false, monotone: false };
  }
  const parsed = board.map(parseCard);
  const suits = [0, 0, 0, 0];
  const ranks = new Array(13).fill(0);
  for (const p of parsed) {
    suits[p.suit] = (suits[p.suit] ?? 0) + 1;
    ranks[p.rank] = (ranks[p.rank] ?? 0) + 1;
  }
  const flushDraw = suits.some((n) => n >= 3);
  const monotone = suits.some((n) => n === board.length && board.length >= 3);
  const paired = ranks.some((n) => n >= 2);
  const present = ranks.map((n) => n > 0);
  let straightDraw = false;
  for (let high = 12; high >= 3; high -= 1) {
    let hits = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = high - i;
      if (r === -1) {
        if (present[12]) hits += 1;
      } else if (r >= 0 && present[r]) hits += 1;
    }
    if (hits >= 3) straightDraw = true;
  }
  return { wet: flushDraw || straightDraw, flushDraw, straightDraw, paired, monotone };
}

export function hasFlushBlocker(hole: [Card, Card], board: readonly Card[]): boolean {
  if (board.length < 3) return false;
  const parsedBoard = board.map(parseCard);
  const suits = [0, 0, 0, 0];
  for (const p of parsedBoard) suits[p.suit] = (suits[p.suit] ?? 0) + 1;
  const flushSuit = suits.findIndex((n) => n >= 3);
  if (flushSuit < 0) return false;
  return hole.some((c) => parseCard(c).suit === flushSuit && parseCard(c).rank >= 11);
}
