/**
 * CR-024 recheck: does a suspended AudioContext get resumed (a) on a gesture and
 * (b) when a sound is played, and does it recover after a later suspension?
 * Uses the real apps/web/src/lib/sounds.ts and the real useTableFx hook mounted
 * on the in-memory DOM (fake-dom.mjs). The AudioContext is a fake that starts
 * "suspended" (what a browser does after a reload) and records resume() calls.
 * No network, no browser.
 *
 * Usage (repo root):
 *   TSX_TSCONFIG_PATH=review/claude/recheck/web-ui/tsconfig.json node --import tsx review/claude/recheck/web-ui/audio-unlock.mjs
 */
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://127.0.0.1:1';
process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:1';
globalThis.fetch = async () => { throw new Error('network disabled'); };
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { installDom, FakeEvent } from './fake-dom.mjs';

const win = installDom();
const log = { created: 0, resumes: [], oscillators: 0 };
class FakeAudioContext {
  constructor() { log.created += 1; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; FakeAudioContext.last = this; }
  resume() { log.resumes.push({ during: globalThis.__during ?? 'none' }); this.state = 'running'; return Promise.resolve(); }
  createOscillator() { log.oscillators += 1; return { connect() {}, frequency: { setValueAtTime() {} }, start() {}, stop() {} }; }
  createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
}
win.AudioContext = FakeAudioContext;

const root = resolve(import.meta.dirname, '../../../..');
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const React = await import('react');
globalThis.React = React.default ?? React;
const { createRoot } = await import('react-dom/client');
const { useTableFx } = await imp('apps/web/src/hooks/use-table-fx.ts');
const sounds = await imp('apps/web/src/lib/sounds.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const row = (step, extra = {}) => rows.push({ step, contexts: log.created, resumes: log.resumes.length, lastResumeDuring: log.resumes.at(-1)?.during ?? '-', state: FakeAudioContext.last?.state ?? '-', ...extra });

// Mount a component that uses the real table-page hook (installs the unlock listener).
let setSnap;
function Probe() { const [snap, s] = React.useState(null); setSnap = s; useTableFx(snap, 'hero'); return null; }
const container = document.createElement('div'); document.body.appendChild(container);
createRoot(container).render(React.createElement(Probe));
await sleep(30);
row('page loaded (reload), no gesture yet');

// A snapshot making the hero the actor: useTableFx plays the turn sound without any gesture.
const base = { tableId: 't', handNumber: 1, phase: 'PREFLOP', board: [], winners: [], toActSeat: 1, players: [{ seatIndex: 0, userId: 'hero' }, { seatIndex: 1, userId: 'v' }] };
setSnap(base); await sleep(20);
setSnap({ ...base, toActSeat: 0 }); await sleep(20);
row('turn sound from a snapshot (no gesture)', { oscillators: log.oscillators });

// Reset to suspended (e.g. the browser refused the resume above, or a phone call interrupted).
FakeAudioContext.last.state = 'suspended';
globalThis.__during = 'pointerdown';
document.body.dispatchEvent(new FakeEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
globalThis.__during = undefined;
row('pointerdown (touch) on the page');

FakeAudioContext.last.state = 'suspended';
globalThis.__during = 'keydown';
document.body.dispatchEvent(new FakeEvent('keydown', { bubbles: true, key: 'a' }));
globalThis.__during = undefined;
row('keydown on the page');

FakeAudioContext.last.state = 'suspended';
for (const type of ['pointerup', 'touchend', 'click']) {
  const before = log.resumes.length;
  globalThis.__during = type;
  document.body.dispatchEvent(new FakeEvent(type, { bubbles: true, pointerType: 'touch' }));
  globalThis.__during = undefined;
  row(`${type} on the page (no listener expected?)`, { resumedByThis: log.resumes.length > before });
}

// Sound off: a gesture does not create or resume anything.
sounds.setSoundEnabled(false);
FakeAudioContext.last.state = 'suspended';
const beforeOff = log.resumes.length;
document.body.dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
row('pointerdown with sound off', { resumedByThis: log.resumes.length > beforeOff });

console.table(rows);
process.exit(0);
