/**
 * CR-027 re-check: synchronous cost of one legacy bot decision on the flop
 * (Monte Carlo branch), measured with the real engine dist. Engine only:
 * no server module, no database, no network.
 * Usage (repo root): node review/claude/recheck/game-server/bot-latency.mjs
 */
import { performance } from 'node:perf_hooks';
const E = await import('../../../../packages/engine/dist/index.js');

const out = {};
for (const profile of ['TAG', 'GTO']) {
  let t = E.createTable({ tableId: 'bots', name: 'bots', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let i = 0; i < 6; i++) t = E.sitDown(t, i, { userId: `B${i}`, username: `B${i}`, avatarHue: 0, kind: 'BOT', botProfile: profile, buyIn: 1000 });
  t = E.startHand(t);
  // Everyone calls/checks preflop to reach the flop with six contenders.
  while (t.phase === 'PREFLOP') {
    const legal = E.legalActions(t, t.toActSeat);
    t = E.applyAction(t, t.players[t.toActSeat].userId, { action: legal.actions.includes('CHECK') ? 'CHECK' : 'CALL' });
  }
  const times = [];
  for (let i = 0; i < 30; i++) { const t0 = performance.now(); E.decideBotAction(t); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  out[profile] = { phase: t.phase, opponents: 5, decisions: times.length, medianMs: +times[15].toFixed(1), p90Ms: +times[27].toFixed(1), maxMs: +times.at(-1).toFixed(1) };
}
console.log(JSON.stringify(out, null, 2));
