import type { Card } from "@poker/shared";
import { fullDeck } from "../cards.js";
import { evaluate } from "../evaluate.js";
import { shuffle } from "../deck.js";

export function monteCarloEquity(
  hero: [Card, Card],
  board: readonly Card[],
  opponents: number,
  iterations = 250,
): number {
  const used = new Set<Card>([...hero, ...board]);
  const live = fullDeck().filter((c) => !used.has(c));
  if (opponents < 1) return 1;
  const need = 5 - board.length + opponents * 2;
  if (live.length < need) return 0.5;

  let wins = 0;
  let ties = 0;
  for (let i = 0; i < iterations; i += 1) {
    const deck = shuffle(live);
    let idx = 0;
    const villains: [Card, Card][] = [];
    for (let v = 0; v < opponents; v += 1) {
      villains.push([deck[idx++]!, deck[idx++]!]);
    }
    const fill: Card[] = [...board];
    while (fill.length < 5) fill.push(deck[idx++]!);
    const heroRank = evaluate([...hero, ...fill]).rankValue;
    let bestV = -1;
    let vWins = 0;
    for (const v of villains) {
      const r = evaluate([...v, ...fill]).rankValue;
      if (r > bestV) {
        bestV = r;
        vWins = 1;
      } else if (r === bestV) vWins += 1;
    }
    if (heroRank > bestV) wins += 1;
    else if (heroRank === bestV) ties += 1 / (vWins + 1);
  }
  return (wins + ties) / iterations;
}
