import assert from 'node:assert/strict';
import { fullDeck, evaluate5 } from '../packages/engine/dist/index.js';
const deck = fullDeck(); const counts = {}; let total = 0;
for (let a = 0; a < 48; a++) for (let b = a + 1; b < 49; b++) for (let c = b + 1; c < 50; c++) for (let d = c + 1; d < 51; d++) for (let e = d + 1; e < 52; e++) {
  const result = evaluate5([deck[a], deck[b], deck[c], deck[d], deck[e]]);
  counts[result.category] = (counts[result.category] ?? 0) + 1; total++;
}
assert.equal(total, 2598960);
assert.deepEqual(counts, { FOUR_OF_A_KIND: 624, FULL_HOUSE: 3744, THREE_OF_A_KIND: 54912, TWO_PAIR: 123552, ONE_PAIR: 1098240, STRAIGHT_FLUSH: 36, STRAIGHT: 10200, FLUSH: 5108, HIGH_CARD: 1302540, ROYAL_FLUSH: 4 });
console.log({ totalHands: total, categories: counts, result: 'All standard five-card category counts match.' });
