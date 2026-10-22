/**
 * SECURITY: email-link tokens (verify, reset, email change, "This wasn't me")
 * travel in the URL fragment (`#t=...`), which browsers never send to a
 * server, so they stay out of requests, Worker logs and Referer headers. The
 * page reads the token once and removes it from the address bar at once (it
 * would otherwise sit in history and in screenshots). `#token=` and a legacy
 * `?t=` / `?token=` query are accepted too and stripped the same way.
 */
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const NAMES = ["t", "token"] as const;

function pick(params: URLSearchParams): string | null {
  for (const name of NAMES) {
    const value = params.get(name);
    if (value !== null) return TOKEN.test(value) ? value : null;
  }
  return null;
}

/** The token in a location's fragment or (legacy) query, or null. Pure; unit-tested. */
export function parseFragmentToken(hash: string, search: string): string | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  return pick(new URLSearchParams(fragment)) ?? pick(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
}

/** Whether the location carries a token parameter at all (valid or not), so it is stripped either way. */
function carriesToken(hash: string, search: string): boolean {
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return NAMES.some((name) => fragment.has(name) || query.has(name));
}

/**
 * The last token taken, so React's development double-mount (strict mode)
 * sees the same token after the first mount already cleaned the URL. Only
 * honoured for a moment and on the same path: a later visit gets nothing.
 */
let lastTaken: { path: string; token: string | null; at: number } | null = null;
const RETAKE_WINDOW_MS = 2_000;

/** Read the token from the current URL and strip it. Client only. */
export function takeFragmentToken(): string | null {
  const { pathname, hash, search } = window.location;
  if (carriesToken(hash, search)) {
    const token = parseFragmentToken(hash, search);
    lastTaken = { path: pathname, token, at: Date.now() };
    window.history.replaceState(null, "", pathname);
    return token;
  }
  if (lastTaken && lastTaken.path === pathname && Date.now() - lastTaken.at < RETAKE_WINDOW_MS) return lastTaken.token;
  return null;
}
