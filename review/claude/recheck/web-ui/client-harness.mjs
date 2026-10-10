/**
 * Client-side recheck harness for the web-ui group. Mounts the REAL table page
 * (apps/web/src/app/table/[id]/page.tsx) with react-dom/client on the in-memory
 * DOM in fake-dom.mjs, and feeds it REAL engine snapshots (packages/engine/dist,
 * pure, no database). socket.io-client, next/navigation, next/link and
 * framer-motion are replaced through tsconfig paths (stubs/), and fetch is
 * disabled, so nothing can reach the network or the owner's dev servers.
 *
 * Usage (repo root):
 *   TSX_TSCONFIG_PATH=review/claude/recheck/web-ui/tsconfig.json node --import tsx review/claude/recheck/web-ui/client-harness.mjs <scenario>
 * Scenarios: buyin | storage | announce | reduced | closed | watchdog | felt
 */
process.env.NODE_ENV = 'production';
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://127.0.0.1:1';
process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:1';
process.env.DATABASE_URL = 'postgresql://review:unused@127.0.0.1:1/review';
process.env.DIRECT_URL = 'postgresql://review:unused@127.0.0.1:1/review';
globalThis.fetch = async () => { throw new Error('network disabled in harness'); };

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { installDom, byText, typeInto, pressKey } from './fake-dom.mjs';

const scenario = process.argv[2] ?? 'buyin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ check: name, ok: Boolean(ok), detail: String(detail).slice(0, 140) }); };

const errors = [];
const realConsoleError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ').slice(0, 300)); };
process.on("uncaughtException", (err) => { errors.push(`uncaught: ${err?.stack ?? err}`); realConsoleError("uncaught:", err); });
process.on("unhandledRejection", (err) => { errors.push(`unhandled: ${err?.stack ?? err}`); realConsoleError("unhandled:", err); });

// ---- fake socket (installed for the socket.io-client stub) ----------------------------
class FakeSocket {
  constructor(url) { this.url = url; this.connected = true; this.active = true; this.handlers = new Map(); this.emitted = []; this.ackMode = 'ok'; this.pendingAcks = []; }
  on(ev, fn) { const l = this.handlers.get(ev) ?? []; l.push(fn); this.handlers.set(ev, l); return this; }
  off(ev, fn) { const l = this.handlers.get(ev); if (l) this.handlers.set(ev, fn ? l.filter((f) => f !== fn) : []); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  emit(ev, ...args) { const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null; this.emitted.push({ ev, payload: args[0], hasAck: Boolean(ack) }); this.lastAck = ack; return this; }
  timeout() {
    return { emitWithAck: (ev, payload) => {
      this.emitted.push({ ev, payload, withAck: true });
      return this.ackMode === 'hold' ? new Promise((r) => this.pendingAcks.push(r)) : Promise.resolve({ ok: true });
    } };
  }
  connect() { this.connected = true; this.serverEmit('connect'); return this; }
  disconnect() { this.connected = false; return this; }
  serverEmit(ev, payload) { for (const fn of (this.handlers.get(ev) ?? []).slice()) fn(payload); }
  count(ev) { return this.emitted.filter((e) => e.ev === ev).length; }
}
const sockets = [];
globalThis.__makeFakeSocket = (url) => { const s = new FakeSocket(url); sockets.push(s); return s; };
globalThis.__params = { id: 'fixture-table' };
globalThis.__routerPushes = [];

// ---- environment per scenario ---------------------------------------------------------
const win = installDom({ storageThrows: scenario === 'storage', reducedMotion: scenario === 'reduced' });
globalThis.__reducedMotion = scenario === 'reduced';
if (scenario === 'storage') {
  win.AudioContext = function BrokenAudioContext() { throw new Error('No audio device'); };
}

const root = resolve(import.meta.dirname, '../../../..');
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const React = await import('react');
globalThis.React = React.default ?? React;
const { createRoot } = await import('react-dom/client');
const { useAuthStore, useTableStore } = await imp('apps/web/src/stores/session.ts');
const { default: TablePage } = await imp('apps/web/src/app/table/[id]/page.tsx');
const Eng = await imp('packages/engine/dist/index.js');
const { SOCKET_EVENTS: E } = await import('@poker/shared');

const HERO = 'fixture-player-0';
function makeTable({ mode, timeBankMs = 600_000, buyIn = 1000 }) {
  let t = Eng.createTable({ tableId: 'fixture-table', name: 'Recheck table', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs });
  for (let seat = mode === 'spectator' ? 1 : 0; seat < 3; seat++) {
    t = Eng.sitDown(t, seat, { userId: `fixture-player-${seat}`, username: `Player-${seat}`, kind: 'HUMAN', botProfile: null, buyIn, avatarHue: seat * 90 });
  }
  return Eng.startHand(t);
}
const project = (t) => Eng.projectTableState(t, HERO);

const user = (bankroll) => ({ id: HERO, username: 'Player-0', kind: 'HUMAN', role: 'PLAYER', isGuest: true, bankroll, avatarHue: 0 });
async function mount(bankroll) {
  useAuthStore.getState().setSession(user(bankroll), 'token-1');
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  createRoot(container).render(React.createElement(TablePage));
  await sleep(60);
  return sockets[sockets.length - 1];
}
async function deliver(socket, snap, wait = 120) { socket.serverEmit(E.STATE_SNAPSHOT, snap); await sleep(wait); }
const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const q = (sel) => document.querySelector(sel);

// ---- scenarios ----------------------------------------------------------------------------
if (scenario === 'buyin') {
  // CR-009: bankroll 800 at 5/10 (the review's example). Spectator: two others seated, hand running.
  const socket = await mount(800);
  check('page joined the table', socket && socket.count(E.TABLE_JOIN) === 1, `TABLE_JOIN x${socket?.count(E.TABLE_JOIN)}`);
  await deliver(socket, project(makeTable({ mode: 'spectator' })));
  const sit = q('[data-testid="seat-claim"]');
  check('"Sit here" is offered', sit && txt(sit) === 'Sit here');
  sit.focus(); sit.click(); await sleep(40); // Chrome focuses a clicked button
  const dialog = q('[role="dialog"]');
  check('"Sit here" opens the buy-in dialog, sends nothing', dialog && socket.count(E.SEAT_CLAIM) === 0, `dialog=${Boolean(dialog)} SEAT_CLAIM x${socket.count(E.SEAT_CLAIM)} title="${txt(dialog?.querySelector('h2'))}"`);
  const amount = () => dialog.querySelectorAll('input').find((i) => i.type === 'number');
  const balance = () => txt(dialog.querySelector('[data-testid="buy-in-balance"]'));
  check('default amount shown before any send (D8: whole 800 bankroll when under 100 BB)', amount()?.value === '800', `input=${amount()?.value} balance="${balance()}" desc="${txt(dialog.querySelector('p'))}"`);
  check('focus starts on the amount', document.activeElement === amount());
  pressKey(document.activeElement, 'Escape'); await sleep(40);
  check('Escape closes without sending', !q('[role="dialog"]') && socket.count(E.SEAT_CLAIM) === 0, `SEAT_CLAIM x${socket.count(E.SEAT_CLAIM)}`);
  check('focus returns to "Sit here"', document.activeElement === q('[data-testid="seat-claim"]'), `active=${document.activeElement?.tagName} ${txt(document.activeElement)}`);
  q('[data-testid="seat-claim"]').click(); await sleep(40);
  const dialog2 = q('[role="dialog"]');
  const input2 = dialog2.querySelectorAll('input').find((i) => i.type === 'number');
  typeInto(input2, '300'); await sleep(30);
  check('typed 300: bankroll after shows 500 chips, still nothing sent', txt(dialog2.querySelector('[data-testid="buy-in-balance"]')).includes('500 chips') && socket.count(E.SEAT_CLAIM) === 0,
    txt(dialog2.querySelector('[data-testid="buy-in-balance"]')));
  typeInto(input2, '5000'); await sleep(20);
  const confirm = byText(dialog2, 'Confirm buy-in').find((el) => el.localName === 'button');
  check('over the max (min(2000, bankroll 800)) is clamped in what would be sent', txt(dialog2.querySelector('[data-testid="buy-in-balance"]')).includes('0 chips'), txt(dialog2.querySelector('[data-testid="buy-in-balance"]')));
  typeInto(input2, '300'); await sleep(20);
  confirm.click(); await sleep(40);
  const claims = socket.emitted.filter((e) => e.ev === E.SEAT_CLAIM);
  check('Confirm sends exactly one SEAT_CLAIM with the chosen amount and a commandId', claims.length === 1 && claims[0].payload.buyIn === 300 && /^[0-9a-f-]{36}$/.test(claims[0].payload.commandId ?? '') && claims[0].hasAck,
    JSON.stringify(claims.map((c) => ({ ...c.payload, ack: c.hasAck }))));
  // A bankroll under the minimum: the seat button is disabled.
  useAuthStore.getState().patchBankroll(150); await sleep(30);
  check('bankroll 150 < min 200: seats not claimable', q('[data-testid="seat-claim"]') === null || q('[data-testid="seat-claim"]').disabled, `open-seat buttons=${document.querySelectorAll('[data-testid="open-seat"]').length}`);
}

if (scenario === 'storage') {
  // CR-032: localStorage/sessionStorage throw SecurityError on access, AudioContext throws.
  const socket = await mount(9000);
  await deliver(socket, project(makeTable({ mode: 'active' })));
  const call = () => q('button[data-action="CALL"]');
  check('action bar rendered for the hero', call() && /^Call 10$/.test(txt(call())), txt(call()));
  socket.ackMode = 'hold';
  call().click(); await sleep(30);
  check('click sends ACTION_INTENT once despite throwing storage/audio', socket.count(E.ACTION_INTENT) === 1, `ACTION_INTENT x${socket.count(E.ACTION_INTENT)}`);
  check('buttons disabled while the ack is pending', call().disabled === true);
  call().click(); await sleep(10);
  check('no second send while pending', socket.count(E.ACTION_INTENT) === 1);
  socket.pendingAcks.shift()?.({ ok: true }); await sleep(30);
  check('buttons re-enabled after the ack', call().disabled === false);
  socket.ackMode = 'ok';
  call().click(); await sleep(30);
  check('a later click sends again', socket.count(E.ACTION_INTENT) === 2, `ACTION_INTENT x${socket.count(E.ACTION_INTENT)}`);
  const sound = byText(document.body, /^Sound (on|off)$/).find((el) => el.localName === 'button');
  const before = txt(sound); sound.click(); await sleep(20);
  check('sound toggle still works for the tab without storage', txt(sound) !== before, `${before} -> ${txt(sound)}`);
  const focusPref = byText(document.body, 'Focus actions on my turn').find((el) => el.localName === 'button');
  focusPref.click(); await sleep(20);
  check('focus preference toggles without storage', focusPref.getAttribute('aria-pressed') === 'true');
  // Pointer gesture with blocked storage and broken audio: the unlock listener must not throw.
  document.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
  await sleep(10);
}

if (scenario === 'announce') {
  // CR-014 (and CR-003): 6.5 s to act; the device clock is 10 minutes fast for the whole client run.
  const table = makeTable({ mode: 'active', timeBankMs: 6_500 });
  const snap = project(table);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  const socket = await mount(9000);
  await deliver(socket, snap, 150);
  const announcer = q('[data-testid="turn-announcer"]');
  check('live region exists, polite and atomic', announcer && announcer.getAttribute('aria-live') === 'polite' && announcer.getAttribute('aria-atomic') === 'true');
  check('announces the hero turn with seconds', /^Your turn — [67] seconds to act$/.test(txt(announcer)), `"${txt(announcer)}"`);
  check('action bar shows a text countdown', /^[67] s left$/.test(txt(q('[data-testid="turn-countdown"]'))), `"${txt(q('[data-testid="turn-countdown"]'))}"`);
  check('seat clock shows seconds (skewed device clock ignored)', /^[67] s$/.test(txt(q('[data-testid="turn-clock-seconds"]'))), `"${txt(q('[data-testid="turn-clock-seconds"]'))}" old formula would give ${Math.round((new Date(snap.turnEndsAt).getTime() - Date.now()) / 1000)} s`);
  // Same turn, newer revision: no second announcement.
  // The server's clock is not skewed: project with the real clock.
  const fakeNow = Date.now; Date.now = realNow; const later = project(table); Date.now = fakeNow;
  await deliver(socket, { ...later, revision: snap.revision + 1 }, 200);
  check('a newer snapshot of the same turn is not re-announced', /^Your turn — [67] seconds to act$/.test(txt(announcer)), `"${txt(announcer)}"`);
  const deadline = performance.now() + 3_500;
  let warned = '';
  while (performance.now() < deadline) { await sleep(100); if (/left to act/.test(txt(announcer))) { warned = txt(announcer); break; } }
  check('announces again at 5 seconds', warned === '5 seconds left to act', `"${warned}"`);
  await sleep(1_500);
  check('no per-second ticking afterwards', txt(announcer) === '5 seconds left to act', `"${txt(announcer)}" countdown now "${txt(q('[data-testid="turn-countdown"]'))}"`);
  Date.now = realNow;
}

if (scenario === 'reduced') {
  // CR-035: reduced motion on (framer stub + matchMedia). 15 s turn.
  const socket = await mount(9000);
  await deliver(socket, project(makeTable({ mode: 'active', timeBankMs: 15_000 })), 80);
  const fill = () => q('.poker-table-hero [data-testid="turn-clock-fill"]');
  const scale = () => Number(/scaleX\(([\d.]+)\)/.exec(fill()?.style.transform ?? '')?.[1]);
  check('fill is the stepped variant (no transition class)', fill()?.className.includes('turn-clock-fill--stepped'), fill()?.className);
  const s0 = scale();
  check('bar starts full, not empty', s0 > 0.95, `scaleX=${s0}`);
  await sleep(1_300);
  const s1 = scale();
  const secs = txt(q('.poker-table-hero [data-testid="turn-clock-seconds"]'));
  check('after ~1.3 s the bar has stepped down by whole seconds', s1 < s0 && Math.abs(s1 * 15 - Math.round(s1 * 15)) < 1e-9 && s1 > 0.8, `scaleX ${s0} -> ${s1} (x15 = ${(s1 * 15).toFixed(3)}), text "${secs}"`);
}

if (scenario === 'closed') {
  // CR-039: a fresh page for a table that has closed: the server refuses the join with TABLE_CLOSED and sends no snapshot.
  const socket = await mount(9000);
  socket.serverEmit(E.SERVER_ERROR, { code: 'TABLE_CLOSED', message: 'This table has closed', tableId: 'fixture-table' });
  await sleep(80);
  const dialog = q('[role="alertdialog"]');
  check('closed dialog shown', dialog && /This table has closed/.test(txt(dialog)), txt(dialog?.querySelector('h2')));
  const verify = dialog ? byText(dialog, 'Verify hand').filter((el) => el.localName === 'button') : [];
  check('"Verify hand" reachable on a fresh closed-table visit (CR-039 acceptance)', verify.length > 0, `Verify hand buttons=${verify.length}`);
}

if (scenario === 'watchdog') {
  // CR-029 (e): no snapshot for 8 s.
  const socket = await mount(9000);
  await sleep(8_300);
  const error = txt(document.body);
  check('slow join says it is taking longer, not stalled', /taking longer than usual\. Still trying/.test(error) && !/stalled/i.test(error), useTableStore.getState().tableError);
  check('join is re-sent', socket.count(E.TABLE_JOIN) >= 2, `TABLE_JOIN x${socket.count(E.TABLE_JOIN)}`);
}

if (scenario === 'felt') {
  // CR-029 (b, c, d) and CR-010 at runtime.
  let table = makeTable({ mode: 'active' });
  const socket = await mount(9000);
  await deliver(socket, project(table));
  const felt = q('[data-testid="felt-announcer"]');
  check('felt centre is not a live region; one dedicated announcer', q('.poker-table-center')?.getAttribute('aria-live') == null && felt?.getAttribute('aria-live') === 'polite');
  check('first snapshot announces nothing', txt(felt) === '', `"${txt(felt)}"`);
  const cards = document.querySelectorAll('.poker-table-hero [role="img"]').map((el) => el.getAttribute('aria-label'));
  check('hole cards named by rank ("Ace of hearts", "Ten of clubs")', cards.length === 2 && cards.every((c) => /^(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Jack|Queen|King|Ace) of (hearts|diamonds|clubs|spades)$/.test(c)), cards.join(' | '));
  table = Eng.applyAction(table, HERO, { action: 'CALL' }); table = { ...table, revision: table.revision + 1 };
  await deliver(socket, project(table));
  check('a call (pot change only) announces nothing', txt(felt) === '', `"${txt(felt)}"`);
  for (let n = 0; table.phase === 'PREFLOP' && n < 10; n++) {
    const legal = Eng.legalActions(table, table.toActSeat);
    const actor = table.players[table.toActSeat];
    table = Eng.applyAction(table, actor.userId, legal.actions.includes('CHECK') ? { action: 'CHECK' } : { action: 'CALL' });
  }
  table = { ...table, revision: table.revision + 10 };
  await deliver(socket, project(table));
  check('the flop is announced once, by card name', /^Flop: (\w+ of \w+, ){2}\w+ of \w+\.$/.test(txt(felt)), `"${txt(felt)}"`);
  const body = txt(document.body);
  check('no "$" anywhere on the rendered table page', !body.includes('$'), body.match(/.{0,20}\$.{0,20}/)?.[0] ?? 'none');
  check('header bankroll uses the unit', /Player-0 · 9,000 chips/.test(body));
  const log = txt(byText(document.body, /^Hand log/).find((el) => el.localName === 'aside'));
  const seats = document.querySelectorAll('.poker-table-seat').map(txt).join(' | ');
  check('game log amounts use the same grouping as the UI (CR-029 b)', !/\b\d{4,}\b/.test(log), `log: "${log.slice(0, 120)}" seats: "${seats.slice(0, 80)}"`);
}


if (scenario === 'loggroup') {
  // CR-029 (b): the same amount in the hand log and on the seat. Big blind 10, stacks 2,000, hero raises to 1,200.
  let table = makeTable({ mode: 'active', buyIn: 2000 });
  const socket = await mount(9000);
  table = Eng.applyAction(table, HERO, { action: 'RAISE', amount: 1200 }); table = { ...table, revision: table.revision + 1 };
  await deliver(socket, project(table));
  const log = txt(byText(document.body, /^Hand log/).find((el) => el.localName === 'aside'));
  const hero = txt(q('.poker-table-hero'));
  check("hand log and seat show the same number the same way", !log.includes("raises to 1200") && hero.includes("Bet 1,200"), `log tail: "${log.slice(-70)}" | hero seat: "${hero}"`);
}

await sleep(50);
console.error = realConsoleError;
console.log(`scenario: ${scenario}`);
console.table(results);
if (errors.length) console.log('console.error / uncaught during run:\n  ' + errors.slice(0, 8).join('\n  '));
else console.log('no console errors or uncaught exceptions');
process.exit(0);
