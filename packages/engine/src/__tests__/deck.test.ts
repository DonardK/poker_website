import { fullDeck } from "../cards.js";
import { burnAndDealFlop, burnAndDealOne, dealHoleCards, shuffle, shuffledDeck } from "../deck.js";

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
