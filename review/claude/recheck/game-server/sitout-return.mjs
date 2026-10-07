/** CR-002 re-check: after a time-out sit-out, missed blinds are recorded and Sit in waits for the big blind. Engine dist only. */
const E = await import('../../../../packages/engine/dist/index.js');
let t = E.createTable({ tableId: 'r', name: 'r', maxSeats: 4, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
for (let i = 0; i < 4; i++) t = E.sitDown(t, i, { userId: `P${i}`, username: `P${i}`, avatarHue: 0, kind: 'HUMAN', botProfile: null, buyIn: 1000 });
let now = Date.now(); const absent = 'P3'; const log = [];
const play = () => { while (!['SHOWDOWN', 'WAITING'].includes(t.phase)) {
  const a = t.players[t.toActSeat];
  if (a.userId === absent && !a.sittingOut) { now += 15_000; t = E.applyTimeout(t, now); }
  else { now += 500; const l = E.legalActions(t, t.toActSeat); t = E.applyAction(t, a.userId, { action: l.actions.includes('CHECK') ? 'CHECK' : 'CALL' }, now); }
} t = E.completeHand(t); };
for (let h = 0; h < 6; h++) { t = E.startHand(t, now); const p = t.players[3]; log.push({ hand: t.handNumber, dealt: Boolean(p.holeCards), sittingOut: p.sittingOut, missedBlind: p.missedBlind, bb: t.bbSeat }); play(); }
t = E.sitIn(t, absent, now);
const back = t.players[3];
const after = [];
for (let h = 0; h < 4; h++) { t = E.startHand(t, now); after.push({ hand: t.handNumber, dealt: Boolean(t.players[3].holeCards), bb: t.bbSeat, waitingForBigBlind: t.players[3].waitingForBigBlind }); play(); }
console.log(JSON.stringify({ whileAway: log, onSitIn: { waitingForBigBlind: back.waitingForBigBlind, missedBlind: back.missedBlind }, afterSitIn: after, stack: t.players[3].stack }, null, 1));
