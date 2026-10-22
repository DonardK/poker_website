"use client";

import type { AuthResponse } from "@poker/shared";
import { turnstileScriptLoaded } from "@/components/turnstile-widget";
import { clearLiveEvidence } from "@/hooks/use-table-socket";
import { resetAccountCache } from "@/lib/account-cache";
import { api, broadcastSignedOut, forgetSharedSession, shareSession } from "@/lib/api";
import { clearPendingLogout, retryPendingLogout, writePendingLogout } from "@/lib/pending-logout";
import { rememberAccount, touchRememberedAccount } from "@/lib/remembered-accounts";
import { disconnectSocket } from "@/lib/socket";
import { useAuthStore, useTableStore } from "@/stores/session";

export const OFFLINE_SIGN_OUT_NOTICE =
  "You're signed out on this device. We couldn't reach the server to end the session; we'll finish when you're back online.";

/** The router methods these actions use (next/navigation's useRouter()). */
export interface AppRouter {
  replace: (href: string) => void;
}

/**
 * SECURITY: the one place that wipes per-account state in this tab: the
 * socket, live hand evidence, another tab's shared token, the session, the
 * table and the account caches. Synchronous and idempotent, so nothing of
 * account A is left when account B signs in.
 */
export function resetClientState(): void {
  disconnectSocket();
  clearLiveEvidence();
  forgetSharedSession();
  useAuthStore.getState().clearSession();
  useTableStore.getState().resetTable();
  resetAccountCache();
}

/**
 * Sign out of this browser. It works offline: the pending-logout marker is
 * written and this device is cleared FIRST, then every other tab is told,
 * then the server session is ended with the token captured before clearing.
 * A failed request leaves the marker, which keeps the app from signing back
 * in with the old cookie and retries until the server confirms (G4).
 * The client gate then shows /login (or the account chooser when switching).
 */
export async function signOut(opts: { reason: "logout" | "switch"; exitTo?: string }): Promise<void> {
  const before = useAuthStore.getState();
  const token = before.accessToken;
  if (before.user) touchRememberedAccount(before.user);
  writePendingLogout();
  resetClientState();
  const store = useAuthStore.getState();
  // Signed out, not "server unavailable": the gate shows the sign-in page, never a "Try again" that would refresh.
  store.setApiOffline(false);
  store.setSignOutNotice(null);
  store.setExitTo(opts.exitTo ?? (opts.reason === "switch" ? "/login?switch=1" : "/login"));
  broadcastSignedOut(opts.reason);
  try {
    await api<void>("/api/auth/logout", { method: "POST", token, keepalive: true });
    clearPendingLogout();
  } catch {
    // Still signed out here; say so unless someone has signed in since.
    if (!useAuthStore.getState().user) useAuthStore.getState().setSignOutNotice(OFFLINE_SIGN_OUT_NOTICE);
    retryPendingLogout();
  }
}

/** "Switch account": sign out, then the remembered-accounts chooser on /login. */
export function switchAccount(): Promise<void> {
  return signOut({ reason: "switch" });
}

/**
 * SECURITY (G6): go on from a sign-in page into the app. When this document
 * holds Cloudflare's Turnstile script (a third party, loaded for the sign-in
 * form), go with a full page load so the script is not left running on the
 * lobby, account or wallet pages; the new page restores the session from the
 * refresh cookie. Otherwise a client-side navigation. `next` is a safeNext path.
 */
export function leaveAuthPage(router: AppRouter, next: string): void {
  if (turnstileScriptLoaded()) {
    window.location.replace(next);
    return;
  }
  router.replace(next);
}

/**
 * A sign-in or sign-up succeeded: adopt the session, hand it to the other
 * tabs, remember the username when "Stay signed in" was ticked (never
 * otherwise), and go on.
 */
export function completeSignIn(data: AuthResponse, opts: { remember: boolean; next: string; router: AppRouter }): void {
  clearPendingLogout();
  useAuthStore.getState().setSession(data.user, data.accessToken);
  shareSession(data);
  if (opts.remember) rememberAccount(data.user);
  leaveAuthPage(opts.router, opts.next);
}
