/**
 * SECURITY: email-link tokens (verify, reset, email change, "This wasn't me")
 * travel in the URL fragment (`#t=...`), which browsers never send to a
 * server, so they stay out of requests, Worker logs and Referer headers. The
 * page reads the token once and removes it from the address bar at once (it
 * would otherwise sit in history and in screenshots). `#token=` and a legacy
 * `?t=` / `?token=` query are accepted too and stripped the same way.
 *
 * A payments email's "This wasn't me" link carries its own token as `#w=`
 * (signed by the payments Worker; base64url segments joined by dots). It is
 * read only from the fragment (takeWalletNotMeToken).
 */
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const NAMES = ["t", "token"] as const;
const WALLET_TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const WALLET_NAMES = ["w"] as const;

function pick(params: URLSearchParams, names: readonly string[] = NAMES, valid: (value: string) => boolean = (v) => TOKEN.test(v)): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return valid(value) ? value : null;
  }
  return null;
}

const fragmentParams = (hash: string) => new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
const queryParams = (search: string) => new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

/** The token in a location's fragment or (legacy) query, or null. Pure; unit-tested. */
export function parseFragmentToken(hash: string, search: string): string | null {
  return pick(fragmentParams(hash)) ?? pick(queryParams(search));
}

/** The `#w=` token of a payments "This wasn't me" link, or null. Pure; unit-tested. */
export function parseWalletNotMeToken(hash: string): string | null {
  return pick(fragmentParams(hash), WALLET_NAMES, (value) => value.length >= 16 && value.length <= 1024 && WALLET_TOKEN.test(value));
}

/** Whether the location carries a token parameter at all (valid or not), so it is stripped either way. */
function carriesToken(hash: string, search: string, names: readonly string[] = NAMES, inQuery = true): boolean {
  const fragment = fragmentParams(hash);
  const query = queryParams(search);
  return names.some((name) => fragment.has(name) || (inQuery && query.has(name)));
}

/**
 * The last token taken, so React's development double-mount (strict mode)
 * sees the same token after the first mount already cleaned the URL. Only
 * honoured for a moment and on the same path: a later visit gets nothing.
 */
let lastTaken: { kind: "account" | "wallet"; path: string; token: string | null; at: number } | null = null;
const RETAKE_WINDOW_MS = 2_000;

/** Read the token from the current URL and strip it. Client only. */
export function takeFragmentToken(): string | null {
  const { pathname, hash, search } = window.location;
  if (carriesToken(hash, search)) {
    const token = parseFragmentToken(hash, search);
    lastTaken = { kind: "account", path: pathname, token, at: Date.now() };
    window.history.replaceState(null, "", pathname);
    return token;
  }
  if (lastTaken?.kind === "account" && lastTaken.path === pathname && Date.now() - lastTaken.at < RETAKE_WINDOW_MS) return lastTaken.token;
  return null;
}

/** Read a payments "This wasn't me" token (`#w=`) from the current URL and strip it. Client only. */
export function takeWalletNotMeToken(): string | null {
  const { pathname, hash, search } = window.location;
  if (carriesToken(hash, search, WALLET_NAMES, false)) {
    const token = parseWalletNotMeToken(hash);
    lastTaken = { kind: "wallet", path: pathname, token, at: Date.now() };
    window.history.replaceState(null, "", `${pathname}${search}`);
    return token;
  }
  if (lastTaken?.kind === "wallet" && lastTaken.path === pathname && Date.now() - lastTaken.at < RETAKE_WINDOW_MS) return lastTaken.token;
  return null;
}

/** Whether the current URL is a payments "This wasn't me" link (valid token or not). Client only. */
export function isWalletNotMeLink(): boolean {
  return carriesToken(window.location.hash, window.location.search, WALLET_NAMES, false)
    || (lastTaken?.kind === "wallet" && lastTaken.path === window.location.pathname && Date.now() - lastTaken.at < RETAKE_WINDOW_MS);
}
