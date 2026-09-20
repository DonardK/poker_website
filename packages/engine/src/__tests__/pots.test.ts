import { awardPots, buildSidePots, returnUncalledBets, type Contribution } from "../pots.js";
import { shuffledDeck } from "../deck.js";
import type { Card } from "@poker/shared";

function contrib(seatIndex: number, committed: number, folded = false): Contribution {
  return { seatIndex, committed, folded };
}

describe("pots — exact cases", () => {
  it("returns an uncalled all-in remainder", () => {
    const { returned, adjusted } = returnUncalledBets([
      contrib(0, 1000),
      contrib(1, 200),
      contrib(2, 200),
    ]);
    expect(returned.get(0)).toBe(800);
    expect(adjusted.find((c) => c.seatIndex === 0)?.committed).toBe(200);
    const pots = buildSidePots(adjusted);
    expect(pots).toHaveLength(1);
    expect(pots[0]?.amount).toBe(600);
  });

  it("builds main + side pots for three stack depths", () => {
    const { returned, adjusted } = returnUncalledBets([
      contrib(0, 50, true),
      contrib(1, 200),
      contrib(2, 500),
    ]);
    expect(returned.get(2)).toBe(300);
    const pots = buildSidePots(adjusted);
    expect(pots).toEqual([
      { potIndex: 0, amount: 150, eligibleSeatIndexes: [1, 2] },
      { potIndex: 1, amount: 300, eligibleSeatIndexes: [1, 2] },
    ]);
  });

  it("splits an even pot equally between tied winners", () => {
    const result = awardPots({
      contribs: [contrib(0, 100), contrib(1, 100), contrib(2, 100)],
      holeCards: {
        0: ["Ah", "Ad"] as [Card, Card],
        1: ["As", "Ac"] as [Card, Card],
        2: ["Kh", "Kd"] as [Card, Card],
      },
      board: ["2c", "3d", "4h", "8s", "9c"] as Card[],
      dealerSeat: 2,
      maxSeats: 3,
    });
    const winners = result.pots[0]?.winnerSeatIndexes ?? [];
    expect(winners.sort()).toEqual([0, 1]);
    expect((result.payouts.get(0) ?? 0) + (result.payouts.get(1) ?? 0)).toBe(300);
    const a = result.payouts.get(0)!;
    const b = result.payouts.get(1)!;
    expect(Math.abs(a - b)).toBe(0);
    expect(result.pots[0]?.oddChipSeatIndex).toBeNull();
  });

  it("awards a 100 chip pot split 3 ways with odd chip left of dealer", () => {
    const result = awardPots({
      contribs: [contrib(0, 25), contrib(1, 25), contrib(2, 25), contrib(3, 25, true)],
      holeCards: {
        0: ["Ah", "Kh"] as [Card, Card],
        1: ["Ad", "Kd"] as [Card, Card],
        2: ["Ac", "Kc"] as [Card, Card],
        3: ["2s", "7d"] as [Card, Card],
      },
      board: ["2h", "3h", "4d", "9s", "9c"] as Card[],
      dealerSeat: 2,
      maxSeats: 4,
    });
    const total = [...result.payouts.values()].reduce((s, n) => s + n, 0);
    expect(total).toBe(100);
    expect(result.pots[0]?.oddChipSeatIndex).toBe(0);
    expect(result.payouts.get(0)).toBe(34);
    expect(result.payouts.get(1)).toBe(33);
    expect(result.payouts.get(2)).toBe(33);
  });

  it("builds three-level side pots with shrinking eligibility", () => {
    const { returned, adjusted } = returnUncalledBets([
      contrib(0, 100),
      contrib(1, 200),
      contrib(2, 400),
    ]);
    expect(returned.get(2)).toBe(200);
    expect(buildSidePots(adjusted)).toEqual([
      { potIndex: 0, amount: 300, eligibleSeatIndexes: [0, 1, 2] },
      { potIndex: 1, amount: 200, eligibleSeatIndexes: [1, 2] },
    ]);
  });
});

describe("pots — fuzz zero chip leak", () => {
  it("conserves chips across 2000 random multiway all-ins", () => {
    for (let n = 0; n < 2000; n += 1) {
      const seats = 2 + (n % 8);
      const dealerSeat = n % seats;
      const contribs: Contribution[] = [];
      const stacks: Record<number, number> = {};
      const holeCards: Record<number, [Card, Card]> = {};
      const deck = shuffledDeck();
      let di = 0;
      for (let s = 0; s < seats; s += 1) {
        const committed = 1 + ((n * 17 + s * 31) % 500);
        const folded = ((n + s) % 7) === 0 && s !== 0;
        contribs.push({ seatIndex: s, committed, folded });
        stacks[s] = (n * 13 + s * 7) % 400;
        holeCards[s] = [deck[di++]!, deck[di++]!];
      }
      const board: Card[] = [deck[di++]!, deck[di++]!, deck[di++]!, deck[di++]!, deck[di++]!];
      const starting = contribs.reduce((s, c) => s + c.committed, 0) + Object.values(stacks).reduce((s, v) => s + v, 0);
      const result = awardPots({ contribs, holeCards, board, dealerSeat, maxSeats: seats });
      const paid = [...result.payouts.values()].reduce((s, v) => s + v, 0);
      const leftoverStacks = Object.values(stacks).reduce((s, v) => s + v, 0);
      expect(paid + leftoverStacks).toBe(starting);
      const potSum = result.pots.reduce((s, p) => s + p.amount, 0);
      const refund = [...result.returned.values()].reduce((s, v) => s + v, 0);
      expect(potSum + refund).toBe(contribs.reduce((s, c) => s + c.committed, 0));
    }
  });
});
