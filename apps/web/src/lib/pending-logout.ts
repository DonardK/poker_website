import { api } from "@/lib/api";

/**
 * SECURITY (finding G4): an offline sign-out must not leave the server
 * session alive for the next reload to resume. Signing out writes this
 * marker first; while it is present the app never refreshes the session (that
 * would sign back in with the old cookie) and keeps retrying POST
 * /api/auth/logout with back-off until the server confirms. A new sign-in
 * clears it (the server also revokes the old session presented with it).
 */
const KEY = "poker-pending-logout";
/** Older markers are dropped: no session outlives its 30-day absolute expiry. */
const MAX_AGE_MS = 31 * 86_400_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

export function writePendingLogout(now = Date.now()): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, at: now }));
  } catch {
    /* storage blocked: the retry below still runs in this tab */
  }
}

export function readPendingLogout(now = Date.now()): { at: number } | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    if (parsed?.v !== 1 || typeof parsed.at !== "number" || !Number.isFinite(parsed.at) || now - parsed.at > MAX_AGE_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return { at: parsed.at };
  } catch {
    return null;
  }
}

export function clearPendingLogout(): void {
  stopRetry();
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

let timer: number | undefined;
let attempt = 0;
let running = false;
let onlineListener: (() => void) | null = null;

function stopRetry(): void {
  window.clearTimeout(timer);
  timer = undefined;
  attempt = 0;
  if (onlineListener) window.removeEventListener("online", onlineListener);
  onlineListener = null;
}

async function tryOnce(): Promise<void> {
  if (running || !readPendingLogout()) return;
  running = true;
  try {
    // Cookie only: the access token was dropped when this device signed out.
    await api<void>("/api/auth/logout", { method: "POST", keepalive: true });
    // A sign-in that happened while this was in flight cleared the marker itself.
    clearPendingLogout();
  } catch {
    if (!readPendingLogout()) return;
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 5));
    attempt++;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void tryOnce(); }, delay);
  } finally {
    running = false;
  }
}

/** Keep trying to end the server session until it answers (also as soon as the browser is back online). */
export function retryPendingLogout(): void {
  if (!readPendingLogout()) return;
  if (!onlineListener) {
    onlineListener = () => { void tryOnce(); };
    window.addEventListener("online", onlineListener);
  }
  void tryOnce();
}
