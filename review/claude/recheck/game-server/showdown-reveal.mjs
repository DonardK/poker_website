/**
 * CR-022 re-check: which hands does today's engine reveal to a spectator at
 * showdown? Engine dist only; no server module, database or network.
 * Usage (repo root): node review/claude/recheck/game-server/showdown-reveal.mjs
 */
const E = await import('../../../../packages/engine/dist/index.js');
let shownLosers = 0, showdowns = 0, example = null;
for (let n = 0; n < 200 && showdowns < 50; n++) {
  let t = E.createTable({ tableId: 'sd', name: 'sd', maxSeats: 4, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let i = 0; i < 3; i++) t = E.sitDown(t, i, { userId: `P${i}`, username: `P${i}`, avatarHue: 0, kind: 'HUMAN', botProfile: null, buyIn: 1000 });
  t = E.startHand(t);
  while (t.phase !== 'SHOWDOWN') {
    const legal = E.legalActions(t, t.toActSeat);
    t = E.applyAction(t, t.players[t.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  const winners = new Set(t.winners.map((w) => w.seatIndex));
  if (winners.size === 3) continue;
  showdowns++;
  const view = E.projectTableState(t, null); // a spectator
  const losersShown = view.players.filter((p, seat) => p && !winners.has(seat) && Array.isArray(p.holeCards) && p.holeCards.length === 2);
  if (losersShown.length) { shownLosers++; example ??= { winners: [...winners], losersShownToSpectator: losersShown.map((p) => p.seatIndex) }; }
}
console.log(JSON.stringify({ showdowns, showdownsWhereALosingHandWasShownToASpectator: shownLosers, example }, null, 2));
