import type { AuthResponse, PublicUser } from "@poker/shared";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

export const API_UNAVAILABLE_MESSAGE = process.env.NODE_ENV === "development"
  ? "Game server unavailable. Start both services with npm run dev, then retry."
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
  ) {
    super(message);
  }
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
    res = await fetch(`${API_URL}${path}`, {
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
    throw new ApiError(
      body.error ?? "Request failed", res.status, parseRetryAfter(res.headers.get("Retry-After")), body.retryable === true,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.currentVersion === "string" ? body.currentVersion : undefined,
    );
  }
  return body;
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

const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Math.random()}`;
let channel: BroadcastChannel | null | undefined;
/** Increments on every session another tab shares; a refresh adopts a share newer than its own start. */
let shareSeq = 0;
let lastShare: { seq: number; data: AuthResponse } | null = null;
const shareListeners = new Set<(data: AuthResponse) => void>();

function isSessionShare(value: unknown): value is SessionShare {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SessionShare>;
  return v.type === "session" && typeof v.from === "string" && typeof v.accessToken === "string" && v.accessToken.length > 0 &&
    typeof v.user === "object" && v.user !== null && typeof v.user.id === "string" &&
    typeof v.user.bankroll === "number" && Number.isSafeInteger(v.user.bankroll);
}

function sessionChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return (channel = null);
  channel = new BroadcastChannel("poker-session");
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isSessionShare(event.data) || event.data.from === TAB_ID) return;
    const data: AuthResponse = { user: event.data.user, accessToken: event.data.accessToken };
    lastShare = { seq: ++shareSeq, data };
    for (const listener of shareListeners) listener(data);
  };
  return channel;
}

/** Called with each session another tab refreshed. Returns the unsubscribe function. */
export function onSharedSession(listener: (data: AuthResponse) => void): () => void {
  sessionChannel();
  shareListeners.add(listener);
  return () => { shareListeners.delete(listener); };
}

function shareSession(data: AuthResponse): void {
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
  pendingRefresh = withRefreshLock(async (): Promise<RefreshOutcome> => {
    // Another tab refreshed while this one waited for the lock: its result is
    // current, and a second rotation would only spend the new cookie.
    if (lastShare && lastShare.seq > startedAtShare) return { ...lastShare.data, adopted: true };
    // A refresh may rotate the cookie on the server after a client-side timeout.
    // Let the transport fail naturally so a retry cannot invalidate that session.
    const data = await api<AuthResponse>("/api/auth/refresh", { method: "POST", signal: null });
    shareSession(data);
    return { ...data, adopted: false };
  }).finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}
