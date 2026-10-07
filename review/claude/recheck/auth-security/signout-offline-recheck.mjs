/**
 * Re-check (2026-10-07) of CR-023 (sign-out while the API is unreachable).
 *
 * Mounts the REAL AuthHydrator (apps/web/src/components/auth-hydrator.tsx)
 * with react-dom/client on a minimal DOM shim, with fetch mocked in memory
 * (nothing leaves the process; the socket URL is a dead loopback port). Then
 * performs exactly the statements of the lobby's signOut()
 * (apps/web/src/app/page.tsx:176-197): disconnectSocket(); clearSession();
 * clearLiveEvidence(); then POST /api/auth/logout, which fails while offline.
 *
 * Scenario 1: the hydrator had already seen the API as unreachable (a failed
 * refresh, so a retry is scheduled) when the player signs out offline.
 * Scenario 2: the network dropped but no refresh had failed yet.
 * In both, connectivity then returns while the server session (and its
 * HttpOnly cookie, which the page cannot delete) is still valid.
 *
 * Usage (repo root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/recheck/auth-security/signout-offline-recheck.mjs
 */
process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:1';
process.env.NEXT_PUBLIC_SOCKET_URL = 'http://127.0.0.1:1';

// ---- minimal DOM shim (enough for a root that renders no host elements) ----
class FakeNode extends EventTarget {
  constructor(nodeType, nodeName, ownerDocument) { super(); this.nodeType = nodeType; this.nodeName = nodeName; this.tagName = nodeName; this.ownerDocument = ownerDocument ?? null; this.childNodes = []; this.style = {}; this.parentNode = null; }
  appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); return c; }
  contains() { return true; }
  setAttribute() {} removeAttribute() {}
  get firstChild() { return this.childNodes[0] ?? null; }
}
const document = new FakeNode(9, '#document');
document.documentElement = new FakeNode(1, 'HTML', document);
document.body = new FakeNode(1, 'BODY', document);
document.activeElement = document.body;
document.visibilityState = 'visible';
document.createElement = (tag) => new FakeNode(1, String(tag).toUpperCase(), document);
document.createTextNode = (text) => Object.assign(new FakeNode(3, '#text', document), { nodeValue: text });
const win = new EventTarget();
Object.assign(win, { document, setTimeout, clearTimeout, setInterval, clearInterval, HTMLIFrameElement: class {}, location: { origin: 'http://127.0.0.1:3999', href: 'http://127.0.0.1:3999/' } });
globalThis.window = win; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = false;

// ---- fetch mock: the server's view of one guest session ----
const net = { online: true, serverSessionValid: true, calls: [] };
const user = { id: 'guest-1', username: 'Guest_0011223344', email: null, isGuest: true, role: 'PLAYER', kind: 'HUMAN', botProfile: null, bankroll: 10_000, avatarHue: 0 };
let tokenSeq = 0;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  net.calls.push(`${net.online ? 'online' : 'OFFLINE'} ${init.method ?? 'GET'} ${path}`);
  if (!net.online) throw new TypeError('fetch failed');
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/api/auth/refresh') return net.serverSessionValid ? json(200, { user, accessToken: `access-${++tokenSeq}` }) : json(401, { error: 'Invalid refresh session' });
  if (path === '/api/auth/logout') { net.serverSessionValid = false; return new Response(null, { status: 204 }); }
  if (path === '/api/auth/me') return json(200, { user });
  return json(404, { error: 'not found' });
};

const React = await import('react');
globalThis.React = React;
const { createRoot } = await import('react-dom/client');
const { AuthHydrator } = await import('@/components/auth-hydrator');
const { useAuthStore } = await import('@/stores/session');
const { api } = await import('@/lib/api');
const { disconnectSocket } = await import('@/lib/socket');
const { clearLiveEvidence } = await import('@/hooks/use-table-socket');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(20); } }
/** The lobby's signOut() (page.tsx:176-197), statement for statement. */
async function lobbySignOut() {
  const token = useAuthStore.getState().accessToken;
  disconnectSocket();
  useAuthStore.getState().clearSession();
  clearLiveEvidence();
  try { await api('/api/auth/logout', { method: 'POST', token }); return 'logout reached the server'; }
  catch { return 'logout failed: notice shown ("Reloading while that session is still valid may sign you back in")'; }
}

async function scenario(label, failRefreshFirst) {
  net.online = true; net.serverSessionValid = true; net.calls = [];
  useAuthStore.getState().clearSession();
  const container = document.createElement('div');
  const root = createRoot(container);
  root.render(React.createElement(AuthHydrator, null, null));
  await until(() => useAuthStore.getState().user !== null, 5000, 'initial sign-in');
  const signedInAs = useAuthStore.getState().user.username;
  net.online = false;
  if (failRefreshFirst) {
    // The periodic refresh (the app's dev/test hook runs the same function) fails: API seen as unreachable.
    await window.__pokerSession.refresh();
  }
  const apiOfflineAtSignOut = useAuthStore.getState().apiOffline;
  const logout = await lobbySignOut();
  const userRightAfterSignOut = useAuthStore.getState().user?.username ?? null;
  // Connectivity returns; the browser fires "online". Nobody reloads the page or touches it.
  net.online = true;
  window.dispatchEvent(new Event('online'));
  await sleep(4000);
  const state = useAuthStore.getState();
  root.unmount();
  return { label, signedInAs, apiOfflineAtSignOut, logout, userRightAfterSignOut,
    userFourSecondsAfterReconnect: state.user?.username ?? null, hasAccessToken: Boolean(state.accessToken),
    serverSessionStillValid: net.serverSessionValid, requests: net.calls };
}

const out = [];
out.push(await scenario('1: a refresh had already failed (retry pending) when the player signed out offline', true));
out.push(await scenario('2: network dropped, no refresh had failed yet', false));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
