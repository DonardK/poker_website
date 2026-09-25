import { fullDeck } from "../cards.js";
import { burnAndDealFlop, burnAndDealOne, dealHoleCards, dealOrderFromDealer, shuffle, shuffledDeck } from "../deck.js";

describe("deck", () => {
  it("is a 52-card unique deck", () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it("Fisher–Yates permutes all 52 cards", () => {
    const shuffled = shuffledDeck();
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled).size).toBe(52);
  });

  it("shuffle of a copy does not mutate the original", () => {
    const original = fullDeck();
    const snapshot = original.slice();
    shuffle(original);
    expect(original).toEqual(snapshot);
  });

  it("deals from the seat left of the button across gaps", () => {
    expect(dealOrderFromDealer(2, 6, [0, 1, 3, 4])).toEqual([3, 4, 0, 1]);
    expect(dealOrderFromDealer(4, 6, [0, 1, 3, 4])).toEqual([0, 1, 3, 4]);
  });

  it("gives every deal position the same chance of a pocket pair", () => {
    const pairCounts = Array.from({ length: 9 }, () => 0);
    const hands = 10_000;
    for (let hand = 0; hand < hands; hand++) {
      const dealt = dealHoleCards(shuffledDeck(), 9);
      expect(new Set(dealt.holeCards.flat()).size).toBe(18);
      dealt.holeCards.forEach(([first, second], seat) => {
        if (first[0] === second[0]) pairCounts[seat]! += 1;
      });
    }
    // Every seat has probability 3/51 of a pair. These wide bounds catch
    // substantial positional bias without treating normal variance as failure.
    for (const count of pairCounts) {
      expect(count).toBeGreaterThan(440);
      expect(count).toBeLessThan(740);
    }
  });

  it("burns before flop, turn, and river", () => {
    let deck = shuffledDeck();
    const dealt = dealHoleCards(deck, 6);
    deck = dealt.deck;
    expect(dealt.holeCards).toHaveLength(6);
    const flop = burnAndDealFlop(deck);
    const turn = burnAndDealOne(flop.deck);
    const river = burnAndDealOne(turn.deck);
    expect(flop.flop).toHaveLength(3);
    const used = [
      ...dealt.holeCards.flat(),
      flop.burn,
      ...flop.flop,
      turn.burn,
      turn.card,
      river.burn,
      river.card,
    ];
    expect(new Set(used).size).toBe(used.length);
    expect(used).toHaveLength(6 * 2 + 3 + 1 + 1 + 3);
  });
});
