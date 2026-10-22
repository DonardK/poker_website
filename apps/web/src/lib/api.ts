import type { AuthResponse, PublicUser } from "@poker/shared";
import { apiOrigin, configuredOrigin } from "@/lib/public-origin";
import { refreshSessionNow } from "@/lib/session-control";
import { useAuthStore } from "@/stores/session";

const configuredApi = configuredOrigin(process.env.NEXT_PUBLIC_API_URL);

// Stable across server and client renders: it does not read window.
// In development the usual cause is a game server that stopped while the web
// app kept running. Empty NEXT_PUBLIC_API_URL calls this page's origin
// (next dev proxies /api to wrangler). The legacy `npm run dev` server is
// http://localhost:4000 and needs that URL set.
export const API_UNAVAILABLE_MESSAGE = process.env.NODE_ENV === "development"
  ? configuredApi
    ? `Game server unavailable: nothing answers at ${configuredApi}. If npm run dev is already running, its game server has stopped; the reason is in that terminal's [server] lines. Fix it, then restart npm run dev.`
    : "Game server unavailable: nothing answers on this page's origin. next dev proxies /api and /ws to wrangler (POKER_EDGE_ORIGIN, default http://127.0.0.1:8787). For the legacy server, set NEXT_PUBLIC_API_URL to http://localhost:4000."
  : "Game server unavailable. Check your connection and try again shortly.";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Milliseconds the server asked us to wait (Retry-After), when it said. */
    readonly retryAfterMs?: number,
    /** The server said the failure was temporary (body.retryable): the session is still valid. */
    readonly retryable = false,
    /** The server's machine-readable reason (body.code, e.g. TERMS_OUTDATED), when it sent one. */
    readonly code?: string,
    /** TERMS_OUTDATED only: the terms version the server now requires (body.currentVersion). */
    readonly currentVersion?: string,
    /** The rest of the error body (e.g. REAUTH_REQUIRED's `methods` and `needs`), minus `error`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The bearer gate's own refusal (expired or revoked access token), as opposed to a wrong password (401 "Invalid credentials"). */
export function isBearerRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code === undefined && err.message === "Unauthorized";
}

/** Retry-After as delta-seconds or an HTTP date; undefined when absent or unparseable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export async function api<T>(
  path: string,
  options: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const { token, headers, ...rest } = options;
  let res: Response;
  try {
    const base = apiOrigin();
    res = await fetch(`${base}${path}`, {
      ...rest,
      signal: "signal" in rest ? rest.signal : AbortSignal.timeout(12_000),
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch {
    throw new ApiError(API_UNAVAILABLE_MESSAGE, 0);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; retryable?: unknown; code?: unknown; currentVersion?: unknown } & T;
  if (!res.ok) {
    const { error, ...details } = body as Record<string, unknown>;
    throw new ApiError(
      typeof error === "string" ? error : "Request failed", res.status, parseRetryAfter(res.headers.get("Retry-After")), body.retryable === true,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.currentVersion === "string" ? body.currentVersion : undefined,
      details,
    );
  }
  return body;
}

/**
 * A bearer request with the signed-in session's token (finding G5). A 401
 * from the bearer gate means the 15-minute access token went stale (e.g. in a
 * background tab): the session is refreshed once, through the hydrator, and
 * the request retried with the new token. A second refusal, and every other
 * error (403 REAUTH_REQUIRED for step-up included), goes to the caller.
 */
export async function authedApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  if (!token) throw new ApiError("Unauthorized", 401);
  try {
    return await api<T>(path, { ...options, token });
  } catch (err) {
    if (!isBearerRejection(err)) throw err;
    await refreshSessionNow();
    const fresh = useAuthStore.getState().accessToken;
    if (!fresh || fresh === token) throw err;
    return api<T>(path, { ...options, token: fresh });
  }
}

// ---------------------------------------------------------------------------
// Session refresh, coordinated across this browser's tabs
// ---------------------------------------------------------------------------
//
// The refresh cookie is shared by every tab of this origin and the server
// rotates it on each refresh. Two tabs refreshing at once would present the
// same cookie twice; the second would look like a replay. So one tab
// refreshes at a time (Web Locks), and the result is shared with the others
// (BroadcastChannel), which adopt it instead of refreshing. Sharing the
// access token adds no exposure: every same-origin tab can already use the
// refresh cookie, and BroadcastChannel never leaves this origin.

export interface RefreshOutcome extends AuthResponse {
  /** True when another tab refreshed and this tab took its result instead of calling the server. */
  adopted: boolean;
}

interface SessionShare {
  type: "session";
  /** Sending tab, so a tab ignores its own echo (some polyfills echo). */
  from: string;
  user: PublicUser;
  accessToken: string;
}

/** This browser signed out in another tab: every tab drops the session (the cookie is gone for all of them). */
interface SignedOutShare {
  type: "signed-out";
  from: string;
  reason: "logout" | "switch";
}

const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Math.random()}`;
let channel: BroadcastChannel | null | undefined;
/** Increments on every session another tab shares; a refresh adopts a share newer than its own start. */
let shareSeq = 0;
let lastShare: { seq: number; data: AuthResponse } | null = null;
/** Increments on every sign-out this tab learns of (forgetSharedSession). A refresh that straddles one is not shared. */
let signOutEpoch = 0;
const shareListeners = new Set<(data: AuthResponse) => void>();
const signedOutListeners = new Set<(reason: SignedOutShare["reason"]) => void>();

function isSessionShare(value: unknown): value is SessionShare {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SessionShare>;
  return v.type === "session" && typeof v.from === "string" && typeof v.accessToken === "string" && v.accessToken.length > 0 &&
    typeof v.user === "object" && v.user !== null && typeof v.user.id === "string" &&
    typeof v.user.bankroll === "number" && Number.isSafeInteger(v.user.bankroll);
}

function isSignedOutShare(value: unknown): value is SignedOutShare {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SignedOutShare>;
  return v.type === "signed-out" && typeof v.from === "string" && (v.reason === "logout" || v.reason === "switch");
}

function sessionChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return (channel = null);
  channel = new BroadcastChannel("poker-session");
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isSignedOutShare(event.data)) {
      if (event.data.from === TAB_ID) return;
      forgetSharedSession();
      for (const listener of signedOutListeners) listener(event.data.reason);
      return;
    }
    if (!isSessionShare(event.data) || event.data.from === TAB_ID) return;
    const data: AuthResponse = { user: event.data.user, accessToken: event.data.accessToken };
    lastShare = { seq: ++shareSeq, data };
    for (const listener of shareListeners) listener(data);
  };
  return channel;
}

/** Called when another tab of this browser signed out. Returns the unsubscribe function. */
export function onSignedOutElsewhere(listener: (reason: SignedOutShare["reason"]) => void): () => void {
  sessionChannel();
  signedOutListeners.add(listener);
  return () => { signedOutListeners.delete(listener); };
}

/** Tell the other tabs this browser signed out. */
export function broadcastSignedOut(reason: SignedOutShare["reason"]): void {
  try {
    sessionChannel()?.postMessage({ type: "signed-out", from: TAB_ID, reason } satisfies SignedOutShare);
  } catch {
    /* channel closed: the other tabs find out at their next refresh */
  }
}

/**
 * SECURITY (finding G3): drop the last session another tab shared, so a
 * signed-out tab never adopts the previous account's access token from
 * memory. A refresh already waiting for the lock then calls the server.
 */
export function forgetSharedSession(): void {
  lastShare = null;
  shareSeq++;
  signOutEpoch++;
}

/** Called with each session another tab refreshed. Returns the unsubscribe function. */
export function onSharedSession(listener: (data: AuthResponse) => void): () => void {
  sessionChannel();
  shareListeners.add(listener);
  return () => { shareListeners.delete(listener); };
}

/** Hand a refreshed or newly signed-in session to the other tabs, which adopt it instead of refreshing. */
export function shareSession(data: AuthResponse): void {
  try {
    sessionChannel()?.postMessage({ type: "session", from: TAB_ID, user: data.user, accessToken: data.accessToken } satisfies SessionShare);
  } catch {
    /* channel closed: the other tabs refresh on their own */
  }
}

/** How long a tab waits for another tab's refresh before refreshing without the lock. */
const LOCK_WAIT_MS = 20_000;

/**
 * Run `fn` while holding the cross-tab refresh lock. Without Web Locks, a
 * random delay spreads tabs that woke together, so the first tab's share
 * usually arrives before the others start.
 */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    let ran = false;
    try {
      return await locks.request("poker-refresh", { signal: AbortSignal.timeout(LOCK_WAIT_MS) }, () => { ran = true; return fn(); });
    } catch (err) {
      // Only giving up the wait falls through; fn's own failure is the caller's.
      if (ran) throw err;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 400));
  return fn();
}

let pendingRefresh: Promise<RefreshOutcome> | null = null;
export function refreshSession(): Promise<RefreshOutcome> {
  if (pendingRefresh) return pendingRefresh;
  sessionChannel();
  const startedAtShare = shareSeq;
  const startedAtSignOut = signOutEpoch;
  pendingRefresh = withRefreshLock(async (): Promise<RefreshOutcome> => {
    // Another tab refreshed while this one waited for the lock: its result is
    // current, and a second rotation would only spend the new cookie.
    if (lastShare && lastShare.seq > startedAtShare) return { ...lastShare.data, adopted: true };
    // A refresh may rotate the cookie on the server after a client-side timeout.
    // Let the transport fail naturally so a retry cannot invalidate that session.
    const data = await api<AuthResponse>("/api/auth/refresh", { method: "POST", signal: null });
    // SECURITY (G4): a sign-out happened while this was in flight. The other
    // tabs were told to forget the account; handing them its fresh token now
    // would sign them back in (the caller discards the result too).
    if (signOutEpoch === startedAtSignOut) shareSession(data);
    return { ...data, adopted: false };
  }).finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}
