// New-finding check: the engine projects the actor's personal time bank into the turn clock the
// client shows (turnRemainingMs = base + bank), but the server's turn timer
// (apps/server/src/game/manager.ts armTimers: turnStartedAt + timeBankMs - now) arms for the base
// time only and applyTimeout does not check the deadline. Engine dist only: no server import, no DB.
// Usage: node review/claude/recheck/web-ui/timebank-mismatch.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const Eng = await import(pathToFileURL(resolve(root, 'packages/engine/dist/index.js')).href);

let t = Eng.createTable({ tableId: 'tb', name: 'TB', maxSeats: 2, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000,
  extraTimeBank: { initialMs: 30_000, maxMs: 60_000, refillMs: 5_000, refillEveryHands: 10 } });
t = Eng.sitDown(t, 0, { userId: 'a', username: 'A', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
t = Eng.sitDown(t, 1, { userId: 'b', username: 'B', kind: 'HUMAN', botProfile: null, buyIn: 1000, avatarHue: 0 });
t = Eng.startHand(t);
const actor = t.players[t.toActSeat];
const view = Eng.projectTableState(t, actor.userId);
const now = Date.now();
const serverTimerDelay = Math.max(0, (t.turnStartedAt ?? now) + t.timeBankMs - now); // manager.ts armTimers formula
console.log({
  clientShowsTotalS: Math.round(view.turnRemainingMs / 1000),
  clientShowsBaseS: Math.round(view.players[t.toActSeat].baseTimeMsRemaining / 1000),
  engineDeadlineS: Math.round((Eng.turnDeadline(t) - now) / 1000),
  serverTimerFiresAfterS: Math.round(serverTimerDelay / 1000),
});
// What the timer then does at base expiry (16 s in), while the client still shows ~29 s of bank:
const atBaseExpiry = t.turnStartedAt + 16_000;
const after = Eng.applyTimeout(t, atBaseExpiry);
const p = after.players[actor.seatIndex];
console.log({ applyTimeoutAtBaseExpiry: { status: p.status, sittingOut: p.sittingOut, reason: p.sittingOutReason, lastLog: after.log.at(-2)?.text ?? after.log.at(-1)?.text } });
