/**
 * CR-003 / CR-035 recheck: port of review/claude/repro/seat-timer-skew.mjs to the
 * current SeatHud API. The snapshot is built by the REAL engine (packages/engine/dist)
 * on the real clock with 15 s left; then the VIEWER's Date.now is skewed and the real
 * SeatHud and ActionBar are server-rendered (real framer-motion). socket.io-client is
 * stubbed (tsconfig.ssr.json); nothing touches the network.
 *
 * Usage (repo root):
 *   TSX_TSCONFIG_PATH=review/claude/recheck/web-ui/tsconfig.ssr.json node --import tsx review/claude/recheck/web-ui/seat-timer-skew-v2.mjs [reduced]
 */
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://127.0.0.1:1';
globalThis.fetch = async () => { throw new Error('network disabled'); };
const reduced = process.argv[2] === 'reduced';
if (reduced) {
  // framer-motion's useReducedMotion reads window.matchMedia('(prefers-reduced-motion)').
  globalThis.window = { matchMedia: (q) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} }) };
}
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const React = await import('react');
globalThis.React = React.default ?? React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { SeatHud } = await imp('apps/web/src/components/table/seat-hud.tsx');
const { ActionBar } = await imp('apps/web/src/components/table/action-bar.tsx');
const { turnClockInput } = await imp('apps/web/src/components/table/turn-clock.tsx');
const Eng = await imp('packages/engine/dist/index.js');

const HERO = 'p0';
let t = Eng.createTable({ tableId: 'skew', name: 'Skew', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
t = Eng.sitDown(t, 0, { userId: HERO, username: 'Hero', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
t = Eng.sitDown(t, 1, { userId: 'p1', username: 'Villain', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 90 });
t = Eng.startHand(t);
// Make the hero the actor if the engine chose the other seat.
const heroView = (snap) => snap.players.find((p) => p.userId === HERO);
let snap = Eng.projectTableState(t, HERO);
if (snap.toActSeat !== heroView(snap).seatIndex) {
  const actor = t.players[t.toActSeat];
  t = Eng.applyAction(t, actor.userId, { action: 'CALL' });
  snap = Eng.projectTableState(t, HERO);
}
const realNow = Date.now;
const rows = [];
for (const skewMs of [0, 5_000, 10_000, 14_000, -10_000, -60_000, 30 * 60_000]) {
  Date.now = () => realNow() + skewMs;
  try {
    const receivedAt = performance.now();
    const clock = turnClockInput(snap, receivedAt);
    const actor = snap.players.find((p) => p.seatIndex === snap.toActSeat);
    const seatHtml = renderToStaticMarkup(React.createElement(SeatHud, { player: actor, isHero: true, isToAct: true, isWinner: false, clock, inHand: true }));
    const barHtml = renderToStaticMarkup(React.createElement(ActionBar, { tableId: 'skew', revision: snap.revision, turnId: snap.turnId, accessToken: 't', legal: snap.actorLegal, stack: actor.stack, pot: snap.potTotal, currentBet: 10, clock }));
    rows.push({
      viewerSkewS: skewMs / 1000,
      serverLeftS: Number((snap.turnRemainingMs / 1000).toFixed(2)),
      seatShows: /data-testid="turn-clock-seconds">([^<]+)</.exec(seatHtml)?.[1],
      barFill: Number(/scaleX\(([\d.]+)\)/.exec(seatHtml)?.[1]),
      stepped: seatHtml.includes('turn-clock-fill--stepped'),
      actionBarShows: /data-testid="turn-countdown"[^>]*>([^<]+(?:<!-- -->[^<]*)*)</.exec(barHtml)?.[1]?.replace(/<!-- -->/g, ''),
      oldFormulaS: Math.round((new Date(snap.turnEndsAt).getTime() - Date.now()) / 1000),
      cssDrainLeft: /timebank-drain/.test(seatHtml),
    });
  } finally {
    Date.now = realNow;
  }
}
console.log(reduced ? 'reduced motion: ON (framer useReducedMotion via matchMedia)' : 'reduced motion: off');
console.table(rows);
