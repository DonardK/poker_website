/**
 * Re-check (2026-10-07) of CR-023 (sign-out offline) against the REAL web
 * code: apps/web/src/components/auth-hydrator.tsx (its effects run here
 * through a minimal React hook dispatcher, no DOM library), lib/api.ts,
 * lib/socket.ts and the session store, plus the exact sign-out sequence of
 * apps/web/src/app/page.tsx signOut() (lines 176-197).
 *
 * No network: globalThis.fetch is a stub that plays the API (online: refresh
 * 200 with a session, logout 204; offline: every request fails like a dropped
 * connection). No server is started, no port is used.
 *
 * Usage (repository root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/recheck/auth-security/signout-offline.mjs
 */
import React from 'react';

// The component may compile with the classic JSX transform, which needs a React global.
globalThis.React = React;
process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_API_URL = 'http://api.invalid';
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://api.invalid';

// ---- minimal browser globals --------------------------------------------------
const win = new EventTarget();
Object.assign(win, { setTimeout, clearTimeout, setInterval, clearInterval });
globalThis.window = win;
const doc = new EventTarget(); doc.visibilityState = 'visible';
globalThis.document = doc;
const store = new Map();
globalThis.sessionStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};

// ---- the API, played by a fetch stub --------------------------------------------
let online = true;
let serverSessionLive = true;         // the server-side session behind the HttpOnly refresh cookie
let tokenSeq = 0;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, online, t: Date.now() });
  if (!online) throw new TypeError('fetch failed');
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/api/auth/refresh') {
    if (!serverSessionLive) return json(401, { error: 'Invalid refresh session' });
    tokenSeq += 1;
    return json(200, { user: { id: 'u-guest', username: 'Guest_0123456789', email: null, isGuest: true, role: 'PLAYER', kind: 'HUMAN', botProfile: null, bankroll: 10_000, avatarHue: 0 }, accessToken: `access-${tokenSeq}` });
  }
  if (path === '/api/auth/logout') { serverSessionLive = false; return new Response(null, { status: 204 }); }
  if (path === '/api/auth/me') return json(401, { error: 'Unauthorized' });
  return json(404, { error: 'not stubbed' });
};

// ---- minimal hook dispatcher: run a function component once and keep its effects --
const effects = [];
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
internals.H = {
  useEffect: (fn) => { effects.push(fn); }, useLayoutEffect: (fn) => { effects.push(fn); },
  useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f(), useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useSyncExternalStore: (_sub, get) => get(), useDebugValue: () => {}, useContext: () => undefined,
};

const { AuthHydrator } = await import('../../../../apps/web/src/components/auth-hydrator.tsx');
const { useAuthStore } = await import('../../../../apps/web/src/stores/session.ts');
const { disconnectSocket } = await import('../../../../apps/web/src/lib/socket.ts');
const { clearLiveEvidence } = await import('../../../../apps/web/src/hooks/use-table-socket.ts');
const { api } = await import('../../../../apps/web/src/lib/api.ts');

AuthHydrator({ children: null });
internals.H = null;
const cleanups = effects.map((fn) => fn()).filter((c) => typeof c === 'function');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => { const s = useAuthStore.getState(); return { signedIn: Boolean(s.user), accessToken: s.accessToken, apiOffline: s.apiOffline }; };

const log = {};
await sleep(800);
log.step1_mountedOnline = snap();

// The device loses its connection; the next session refresh fails.
online = false;
await window.__pokerSession.refresh();
log.step2_refreshFailedOffline = snap();

// The player presses "Sign out" while offline: exactly page.tsx signOut().
const token = useAuthStore.getState().accessToken;
disconnectSocket();
useAuthStore.getState().clearSession();
clearLiveEvidence();
let logoutError = null;
try { await api('/api/auth/logout', { method: 'POST', token }); } catch (err) { logoutError = err?.constructor?.name ?? 'error'; }
log.step3_signedOutOffline = { ...snap(), logoutRequestFailed: Boolean(logoutError), serverSessionStillLive: serverSessionLive };

// Connectivity returns (no reload, no click). Wait past the hydrator's retry back-off.
const signOutAt = Date.now();
online = true;
win.dispatchEvent(new Event('online'));
await sleep(5_000);
log.step4_backOnlineNoUserAction = { ...snap(), refreshCallsAfterSignOut: calls.filter((c) => c.path === '/api/auth/refresh' && c.t >= signOutAt).length,
  logoutRetriedInBackground: calls.filter((c) => c.path === '/api/auth/logout' && c.t >= signOutAt && c.online).length > 0,
  serverSessionStillLive: serverSessionLive };

console.log(JSON.stringify(log, null, 2));
for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
setTimeout(() => process.exit(0), 50);
