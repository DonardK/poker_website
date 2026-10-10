/**
 * Recheck (legal-compliance group): the published House Rules
 * (apps/web/src/app/rules/page.tsx, "Showdown") say losing hands are mucked
 * automatically and a later hand is shown only if it beats or ties the best
 * hand already shown. This plays heads-up check-down hands in the real engine
 * (packages/engine/dist, pure functions, no I/O) and asks a third-party
 * viewer's public snapshot which hole cards it reveals at showdown.
 * Usage (repository root): node review/claude/recheck/legal-compliance/showdown-muck.mjs
 */
import { applyAction, createTable, legalActions, sitDown, startHand, toPublicTableState } from '../../../../packages/engine/dist/index.js';

let showdowns = 0, firstShowerWon = 0, loserShownToSpectator = 0, example = null;
for (let n = 0; n < 200 && showdowns < 40; n++) {
  let t = createTable({ tableId: `muck-${n}`, name: 'muck', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 20_000, createdAt: Date.now() });
  t = sitDown(t, 0, { userId: 'a', username: 'A', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  t = sitDown(t, 1, { userId: 'b', username: 'B', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
  t = startHand(t);
  for (let i = 0; t.phase !== 'SHOWDOWN' && i < 50; i++) {
    const legal = legalActions(t, t.toActSeat);
    t = applyAction(t, t.players[t.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  if (t.phase !== 'SHOWDOWN' || t.board.length !== 5) continue;
  const view = toPublicTableState(t, 'spectator');
  const winners = new Set(t.awards.flatMap((a) => a.winnerSeatIndexes));
  if (winners.size !== 1) continue; // skip split pots
  showdowns++;
  const revealed = view.players.filter((p) => p && p.holeCards).map((p) => p.seatIndex);
  const losers = revealed.filter((s) => !winners.has(s));
  // Nobody bet on the river, so under the published rule the first player left of the button shows first.
  const firstToShow = [1, 2, 3, 4, 5, 6].map((k) => (t.dealerSeat + k) % 6).find((s) => s === 0 || s === 1);
  const winner = [...winners][0];
  if (winner === firstToShow) {
    firstShowerWon++;
    if (losers.length) { loserShownToSpectator++; example ??= { hand: n, dealerSeat: t.dealerSeat, firstToShow, winner, revealedToSpectator: revealed, showedCardsFlags: t.players.map((p) => p?.showedCards) }; }
  }
}
console.log(`[rules/showdown] decided heads-up check-down showdowns: ${showdowns}; first-to-show player won ${firstShowerWon} (the rule says the loser is then mucked); the losing hand was nevertheless revealed to a spectator in ${loserShownToSpectator}`);
console.log('[rules/showdown] example:', JSON.stringify(example));
