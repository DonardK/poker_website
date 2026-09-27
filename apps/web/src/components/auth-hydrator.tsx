"use client";

import { useEffect } from "react";
import { SOCKET_EVENTS, type PublicUser, type UserPatchPayload } from "@poker/shared";
import { clearLiveEvidence } from "@/hooks/use-table-socket";
import { api, ApiError, refreshSession } from "@/lib/api";
import { disconnectSocket, getSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

export function AuthHydrator({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);
  const markHydrated = useAuthStore((s) => s.markHydrated);
  const setApiOffline = useAuthStore((s) => s.setApiOffline);
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    let cancelled = false;
    let retryOffline = false;
    let lastRefreshAt = 0;
    const refresh = async () => {
      const startedWithToken = useAuthStore.getState().accessToken;
      const startedWithWalletVersion = useAuthStore.getState().walletVersion;
      const current = () => !cancelled && useAuthStore.getState().accessToken === startedWithToken;
      try {
        const data = await refreshSession();
        lastRefreshAt = Date.now();
        retryOffline = false;
        if (current()) setApiOffline(false);
        if (current()) {
          const state = useAuthStore.getState();
          const user = state.user?.id === data.user.id && state.walletVersion !== startedWithWalletVersion
            ? { ...data.user, bankroll: state.user.bankroll } : data.user;
          setSession(user, data.accessToken);
        }
      } catch (err) {
        if (!current()) return;
        if (err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500)) {
          retryOffline = true;
          if (!cancelled) setApiOffline(true);
          return;
        }
        retryOffline = false;
        if (!cancelled) {
          setApiOffline(false);
          disconnectSocket();
          clearSession();
          clearLiveEvidence();
        }
      } finally {
        if (!cancelled) markHydrated();
      }
    };
    void refresh();
    const interval = window.setInterval(() => { if (useAuthStore.getState().user) void refresh(); }, 10 * 60_000);
    const retryInterval = window.setInterval(() => { if (retryOffline) void refresh(); }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && useAuthStore.getState().user && Date.now() - lastRefreshAt >= 5 * 60_000) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearInterval(retryInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setSession, clearSession, markHydrated, setApiOffline]);

  // Wallet updates belong to the session, including while a queued cash-out
  // finishes after navigating away from the table.
  useEffect(() => {
    if (!accessToken) return;
    const socket = getSocket(accessToken);
    let cancelled = false;
    let walletVersion = 0;
    const onPatch = (payload: UserPatchPayload) => {
      if (cancelled) return;
      walletVersion++;
      const state = useAuthStore.getState();
      state.patchBankroll(payload.bankroll);
      if (payload.cashOutTableId === state.leavingTableId) state.setLeavingTableId(null);
    };
    const onConnect = () => {
      const requestedAtVersion = walletVersion;
      void api<{ user: PublicUser }>("/api/auth/me", { token: accessToken }).then(({ user }) => {
        if (!cancelled && walletVersion === requestedAtVersion) onPatch({ bankroll: user.bankroll });
      }).catch(() => undefined);
    };
    socket.on(SOCKET_EVENTS.USER_PATCH, onPatch);
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();
    return () => {
      cancelled = true;
      socket.off(SOCKET_EVENTS.USER_PATCH, onPatch);
      socket.off("connect", onConnect);
    };
  }, [accessToken]);

  // Sign-out and session loss clear live evidence where they clear the
  // session. When another account replaces the signed-in one without a
  // sign-out, the previous account's evidence is cleared here.
  useEffect(() => useAuthStore.subscribe((state, previous) => {
    if (previous.user && state.user && state.user.id !== previous.user.id) clearLiveEvidence();
  }), []);

  return children;
}
