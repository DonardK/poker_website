"use client";

import { useEffect, useRef } from "react";
import {
  SOCKET_EVENTS,
  type AuthOkPayload,
  type AuthResponse,
  type PublicUser,
  type SessionEndReason,
  type SessionRevokedPayload,
  type SocketErrorPayload,
  type TableIdleNoticePayload,
  type UserPatchPayload,
} from "@poker/shared";
import { clearLiveEvidence } from "@/hooks/use-table-socket";
import { api, ApiError, onSharedSession, onSignedOutElsewhere, refreshSession, type RefreshOutcome } from "@/lib/api";
import { readPendingLogout, retryPendingLogout } from "@/lib/pending-logout";
import { touchRememberedAccount } from "@/lib/remembered-accounts";
import { resetClientState } from "@/lib/session-actions";
import { registerSessionControl } from "@/lib/session-control";
import { disconnectSocket, getSocket, renewSocketSession, resumeSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

const REFRESH_EVERY_MS = 10 * 60_000;
/** Back in a tab that was hidden at least this long, refresh at once: its timers may have been throttled. */
const VISIBLE_REFRESH_AFTER_MS = 5 * 60_000;
/**
 * A 401 is re-checked once after this pause before signing out: another tab
 * may have rotated the shared refresh cookie just before this request used
 * it, and the server accepts the newest cookie (or its predecessor briefly).
 */
const UNAUTHORIZED_RECHECK_MS = 1_000;
/** How long the temporary-failure notice stays up. */
const TRANSIENT_NOTICE_MS = 5_000;

/**
 * Delay before retrying a refresh the service could not answer. The server's
 * Retry-After wins when it sent one (kept within 1 s..5 min); otherwise
 * exponential back-off from 2 s to 60 s with ±20% jitter, so tabs and
 * devices that failed together do not all come back in the same instant.
 */
function offlineRetryDelay(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 1_000), 5 * 60_000);
  return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4);
}

const SESSION_ENDED_MESSAGES: Record<SessionEndReason, string> = {
  LOGOUT: "You were signed out.",
  LOGOUT_ALL: "You were signed out on all devices.",
  SESSION_REVOKED: "This session was ended. Sign in again to keep playing.",
  PASSWORD_CHANGED: "Your password was changed. Sign in again with the new password.",
  REFRESH_REUSE: "For your security this session was ended because it was used from somewhere else. Sign in again.",
  EXPIRED: "Your session expired. Sign in again to keep playing.",
  ACCOUNT_RESTRICTED: "Your account has been restricted. Contact support for help.",
  GUEST_RETIRED: "Guest play has ended. Create an account to keep playing.",
  SECURITY_LOCKDOWN: "You were signed out everywhere because a sign-in or change was reported as not you. Set a new password to continue.",
};

const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** What the session effect offers the socket effect. */
interface SessionControl {
  /** The server closed the socket or refused its reconnect: refresh, then reconnect the same socket if the session is valid. */
  socketClosedByServer: () => void;
  /** The socket is connected again: the reconnect back-off starts over. */
  socketConnected: () => void;
}

/** The account facts /me carries and a refresh does not (PublicUser's optional security fields). */
function securityFacts(user: PublicUser): Partial<PublicUser> {
  const facts: Partial<PublicUser> = {};
  if (user.emailVerified !== undefined) facts.emailVerified = user.emailVerified;
  if (user.twoFactorEnabled !== undefined) facts.twoFactorEnabled = user.twoFactorEnabled;
  if (user.passkeyCount !== undefined) facts.passkeyCount = user.passkeyCount;
  return facts;
}

export function AuthHydrator({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const markHydrated = useAuthStore((s) => s.markHydrated);
  const setApiOffline = useAuthStore((s) => s.setApiOffline);
  // The socket belongs to the user, not to an access token: a refresh must not re-run the socket effect.
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const sessionEndedReason = useAuthStore((s) => s.sessionEndedReason);
  const transientNotice = useAuthStore((s) => s.transientNotice);
  const control = useRef<SessionControl | null>(null);

  useEffect(() => {
    let cancelled = false;
    let lastRefreshAt = 0;
    let offlineAttempt = 0;
    let retryTimer: number | undefined;
    // A socket the server closed waits for a valid session before reconnecting.
    let resumePending = false;
    let resumeAttempt = 0;
    let resumeTimer: number | undefined;

    const signOut = () => {
      resumePending = false;
      window.clearTimeout(retryTimer);
      setApiOffline(false);
      resetClientState();
    };

    const renewSocket = async (token: string) => {
      const outcome = await renewSocketSession(token);
      // A newer token or a sign-out replaced this one meanwhile: its outcome is moot.
      if (cancelled || useAuthStore.getState().accessToken !== token) return;
      if (outcome === "unauthorized") signOut();
    };

    const resume = () => {
      if (!resumePending) return;
      resumePending = false;
      window.clearTimeout(resumeTimer);
      // A server that closes the socket again after every valid refresh is not hammered.
      const delay = resumeAttempt === 0 ? 0 : Math.min(30_000, 1_000 * 2 ** resumeAttempt);
      resumeAttempt++;
      resumeTimer = window.setTimeout(() => { if (!cancelled) resumeSocket(); }, delay);
    };

    /**
     * Adopt a refreshed session. `startedWalletVersion` is the tab's wallet
     * counter when the refresh was sent; null for another tab's result, whose
     * balance may be older than this tab's own wallet updates. Either way a
     * balance read before this tab's latest wallet update never replaces it.
     */
    const apply = (data: AuthResponse, startedWalletVersion: number | null) => {
      const state = useAuthStore.getState();
      const sameUser = state.user?.id === data.user.id;
      const keepBalance = sameUser && state.user !== null &&
        (startedWalletVersion === null || state.walletVersion !== startedWalletVersion);
      const user: PublicUser = keepBalance && state.user ? { ...data.user, bankroll: state.user.bankroll } : data.user;
      const tokenChanged = state.accessToken !== data.accessToken;
      setSession(user, data.accessToken);
      // Same user, new token: hand it to the live socket. (Another user gets a new socket from the socket effect.)
      if (sameUser && tokenChanged) void renewSocket(data.accessToken);
      resume();
    };

    const scheduleRetry = (retryAfterMs: number | undefined) => {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { if (!cancelled) void refresh(); }, offlineRetryDelay(offlineAttempt, retryAfterMs));
      offlineAttempt++;
    };

    const refresh = async (): Promise<void> => {
      window.clearTimeout(retryTimer);
      // SECURITY (G4): every trigger comes through here (interval, visibility,
      // back online, "Try again", a socket the server closed). While this
      // browser's sign-out is pending, refreshing would sign back in with the
      // old cookie: this browser is signed out, so finish the sign-out instead.
      if (readPendingLogout()) {
        signOut();
        retryPendingLogout();
        return;
      }
      const startedWithToken = useAuthStore.getState().accessToken;
      const startedWithWalletVersion = useAuthStore.getState().walletVersion;
      // Another tab's result, a sign-in or a sign-out replaced the session meanwhile: this outcome is not newer.
      const current = () => !cancelled && useAuthStore.getState().accessToken === startedWithToken;
      try {
        let data: RefreshOutcome;
        try {
          data = await refreshSession();
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 401)) throw err;
          // Nothing signed in to keep: show the signed-out page now rather than after the re-check.
          if (!useAuthStore.getState().user && !cancelled) markHydrated();
          await sleep(UNAUTHORIZED_RECHECK_MS);
          if (!current()) return;
          data = await refreshSession();
        }
        lastRefreshAt = Date.now();
        offlineAttempt = 0;
        if (!current()) return;
        setApiOffline(false);
        apply(data, data.adopted ? null : startedWithWalletVersion);
        touchRememberedAccount(data.user);
      } catch (err) {
        if (!current()) return;
        // Only the server saying the session is invalid ends it. A network
        // failure, 429, 503 or any other answer is about the service: the
        // session is kept and the refresh retried.
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          return;
        }
        setApiOffline(true);
        scheduleRetry(err instanceof ApiError ? err.retryAfterMs : undefined);
      } finally {
        if (!cancelled) markHydrated();
      }
    };

    // Another tab refreshed: take its session instead of rotating the cookie again.
    const unsubscribeShared = onSharedSession((data) => {
      // SECURITY (G4): while this browser's sign-out is pending, no tab adopts a session (a real sign-in clears the marker first).
      if (cancelled || readPendingLogout()) return;
      lastRefreshAt = Date.now();
      offlineAttempt = 0;
      window.clearTimeout(retryTimer);
      setApiOffline(false);
      apply(data, null);
      markHydrated();
    });

    control.current = {
      socketClosedByServer: () => {
        resumePending = true;
        // Jittered: a server shedding connections is not met by every client at once.
        window.setTimeout(() => { if (!cancelled && resumePending) void refresh(); }, 500 + Math.random() * 1_000);
      },
      socketConnected: () => { resumeAttempt = 0; },
    };

    // Another tab signed out: this one is signed out too (the shared cookie is gone). The gate then shows /login.
    const unsubscribeSignedOut = onSignedOutElsewhere(() => {
      if (cancelled) return;
      resumePending = false;
      window.clearTimeout(retryTimer);
      setApiOffline(false);
      resetClientState();
    });
    const unregisterControl = registerSessionControl({ refresh: () => refresh() });

    // SECURITY (G4): a sign-out that never reached the server must not be
    // undone by refreshing with the old cookie. Finish it instead; the user
    // stays signed out until they sign in again.
    if (readPendingLogout()) {
      markHydrated();
      retryPendingLogout();
    } else {
      void refresh();
    }
    // Like mount and pageshow: never refresh with the old cookie while a sign-out is pending (G4).
    const interval = window.setInterval(() => { if (useAuthStore.getState().user && !readPendingLogout()) void refresh(); }, REFRESH_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && useAuthStore.getState().user && !readPendingLogout() && Date.now() - lastRefreshAt >= VISIBLE_REFRESH_AFTER_MS) void refresh();
    };
    const onOnline = () => { if (useAuthStore.getState().apiOffline) void refresh(); };
    // A page restored from the back-forward cache may hold a session that was revoked meanwhile.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && useAuthStore.getState().user && !readPendingLogout()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    // Browser tests trigger the periodic refresh without faking timers (that would also fire the socket's heartbeat timeout).
    const testHook = process.env.NODE_ENV !== "production" ? (window as unknown as { __pokerSession?: { refresh: () => Promise<void> } }) : null;
    if (testHook) testHook.__pokerSession = { refresh };
    return () => {
      cancelled = true;
      control.current = null;
      unsubscribeShared();
      unsubscribeSignedOut();
      unregisterControl();
      window.clearInterval(interval);
      window.clearTimeout(retryTimer);
      window.clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
      if (testHook) delete testHook.__pokerSession;
    };
  }, [setSession, markHydrated, setApiOffline]);

  // Wallet updates, idle warnings and the session's own fate arrive on the
  // session's socket, including while a queued cash-out finishes after
  // navigating away from the table. Keyed on the user: a token refresh keeps
  // the same socket and these listeners.
  useEffect(() => {
    if (!userId) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    const socket = getSocket(token);
    let cancelled = false;
    const onPatch = (payload: UserPatchPayload) => {
      if (cancelled || typeof payload?.bankroll !== "number") return;
      const state = useAuthStore.getState();
      // A patch older than one already applied (walletVersion) leaves the
      // balance alone; what it says about a cash-out is still true.
      state.patchBankroll(payload.bankroll, payload.walletVersion);
      if (payload.cashOutTableId && payload.cashOutTableId === state.leavingTableId) state.setLeavingTableId(null);
      // Cashed out of the table they held a seat at: no longer seated anywhere.
      if (payload.cashOutTableId && payload.cashOutTableId === state.activeTableId) state.setActiveTableId(null);
      // The table closed for inactivity and paid this player out. They may be
      // in the lobby (seat kept) or another tab, so the lobby says why the
      // chips came back until they dismiss it.
      if (payload.tableClosedReason && payload.cashOutTableId) {
        state.setTableClosedNotice({ tableId: payload.cashOutTableId, reason: payload.tableClosedReason });
      }
      // Cashed out of that table (it closed, or this player left): its idle
      // warning is no longer theirs to answer.
      if (payload.cashOutTableId) state.clearTableIdleNotice(payload.cashOutTableId);
    };
    // The idle warning of the table this player is seated at, sent to their
    // own room wherever they are in the app. The countdown runs from arrival
    // (performance.now()), never from a server or wall-clock timestamp.
    const onIdleNotice = (payload: TableIdleNoticePayload) => {
      if (cancelled || typeof payload?.tableId !== "string") return;
      const state = useAuthStore.getState();
      if (typeof payload.closingInMs !== "number" || !Number.isFinite(payload.closingInMs)) {
        // Only that table's warning ends: a late "over" for another table leaves this one.
        state.clearTableIdleNotice(payload.tableId);
        return;
      }
      state.setTableIdleNotice({
        tableId: payload.tableId,
        tableName: typeof payload.tableName === "string" ? payload.tableName : "Your table",
        deadline: performance.now() + Math.max(0, payload.closingInMs),
      });
    };
    // A reconnecting or reloading player may have missed the warning's start
    // (or end) while away; AUTH_OK carries the one counting down now.
    const onAuthOk = (payload: AuthOkPayload) => {
      if (cancelled || !payload) return;
      // The seat this user holds (the seated guard on sign-out and switch account reads it).
      if ("activeTableId" in payload) {
        useAuthStore.getState().setActiveTableId(typeof payload.activeTableId === "string" ? payload.activeTableId : null);
      }
      if (!("idleNotice" in payload)) return;
      const notice = payload.idleNotice;
      if (notice && typeof notice === "object") onIdleNotice(notice);
      // Explicit null: the server says no table of this player is warning now,
      // so a warning whose end was missed while disconnected is stale.
      else if (notice === null) {
        const current = useAuthStore.getState().tableIdleNotice;
        if (current) useAuthStore.getState().clearTableIdleNotice(current.tableId);
      }
    };
    const onConnect = () => {
      control.current?.socketConnected();
      const state = useAuthStore.getState();
      const requestedAtVersion = state.walletVersion;
      void api<{ user: PublicUser }>("/api/auth/me", { token: state.accessToken }).then(({ user }) => {
        if (cancelled || useAuthStore.getState().user?.id !== user.id) return;
        // /me carries the account-security facts a refresh leaves out (email verified, 2FA, passkeys).
        useAuthStore.getState().patchUser(securityFacts(user));
        if (useAuthStore.getState().walletVersion === requestedAtVersion) onPatch({ bankroll: user.bankroll });
      }).catch(() => undefined);
    };
    const onDisconnect = (reason: string) => {
      // Network drops reconnect by themselves; a server-closed socket never does.
      if (!cancelled && reason === "io server disconnect") control.current?.socketClosedByServer();
    };
    const onConnectError = () => {
      // Refused by the server's auth (e.g. an access token that expired while
      // offline): socket.io gives up. A fresh token may be accepted.
      if (!cancelled && !socket.active) control.current?.socketClosedByServer();
    };
    const onRevoked = (payload: SessionRevokedPayload) => {
      if (cancelled) return;
      const reason = payload && payload.reason in SESSION_ENDED_MESSAGES ? payload.reason : "SESSION_REVOKED";
      resetClientState();
      useAuthStore.getState().endSession(reason);
    };
    const onServerError = (payload: SocketErrorPayload) => {
      // Temporary (e.g. SERVICE_UNAVAILABLE): the request may be retried and the session is fine.
      if (!cancelled && payload?.retryable === true) {
        useAuthStore.getState().setTransientNotice("The game server is busy for a moment. Retrying…");
      }
    };
    socket.on(SOCKET_EVENTS.USER_PATCH, onPatch);
    socket.on(SOCKET_EVENTS.TABLE_IDLE_NOTICE, onIdleNotice);
    socket.on(SOCKET_EVENTS.AUTH_OK, onAuthOk);
    socket.on(SOCKET_EVENTS.SESSION_REVOKED, onRevoked);
    socket.on(SOCKET_EVENTS.SERVER_ERROR, onServerError);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    if (socket.connected) onConnect();
    return () => {
      cancelled = true;
      socket.off(SOCKET_EVENTS.USER_PATCH, onPatch);
      socket.off(SOCKET_EVENTS.TABLE_IDLE_NOTICE, onIdleNotice);
      socket.off(SOCKET_EVENTS.AUTH_OK, onAuthOk);
      socket.off(SOCKET_EVENTS.SESSION_REVOKED, onRevoked);
      socket.off(SOCKET_EVENTS.SERVER_ERROR, onServerError);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, [userId]);

  useEffect(() => {
    if (!transientNotice) return;
    const id = window.setTimeout(() => useAuthStore.getState().setTransientNotice(null), TRANSIENT_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [transientNotice]);

  // Sign-out and session loss clear live evidence where they clear the
  // session. When another account replaces the signed-in one without a
  // sign-out, the previous account's evidence is cleared here, and its socket
  // closed: the next account never inherits its rooms or listeners.
  useEffect(() => useAuthStore.subscribe((state, previous) => {
    if (previous.user && state.user?.id !== previous.user.id) {
      disconnectSocket();
      if (state.user) clearLiveEvidence();
    }
  }), []);

  return (
    <>
      {children}
      {sessionEndedReason ? (
        <div role="alert" className="fixed inset-x-3 top-3 z-[70] mx-auto flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/50 bg-emerald-950/95 px-4 py-3 text-amber-100 shadow-xl">
          <span>{SESSION_ENDED_MESSAGES[sessionEndedReason]}</span>
          <button type="button" className="text-sm font-semibold underline" onClick={() => useAuthStore.getState().dismissSessionEnded()}>
            Dismiss
          </button>
        </div>
      ) : null}
      {transientNotice && !sessionEndedReason ? (
        <p role="status" className="pointer-events-none fixed inset-x-3 top-3 z-[70] mx-auto max-w-md rounded-xl border border-amber-300/40 bg-emerald-950/90 px-4 py-2 text-center text-sm text-amber-100 shadow-lg">
          {transientNotice}
        </p>
      ) : null}
    </>
  );
}
