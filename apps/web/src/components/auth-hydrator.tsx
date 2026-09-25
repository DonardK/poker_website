"use client";

import { useEffect } from "react";
import type { AuthResponse } from "@poker/shared";
import { ApiError, refreshSession } from "@/lib/api";
import { disconnectSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

export function AuthHydrator({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);
  const markHydrated = useAuthStore((s) => s.markHydrated);
  const setApiOffline = useAuthStore((s) => s.setApiOffline);

  useEffect(() => {
    let cancelled = false;
    let retryOffline = false;
    const refresh = async () => {
      try {
        const data = await refreshSession();
        retryOffline = false;
        if (!cancelled) setApiOffline(false);
        if (!cancelled) setSession(data.user, data.accessToken);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) {
          retryOffline = true;
          if (!cancelled) setApiOffline(true);
          return;
        }
        retryOffline = false;
        if (!cancelled) {
          setApiOffline(false);
          disconnectSocket();
          clearSession();
        }
      } finally {
        if (!cancelled) markHydrated();
      }
    };
    void refresh();
    const interval = window.setInterval(() => { if (useAuthStore.getState().user) void refresh(); }, 10 * 60_000);
    const retryInterval = window.setInterval(() => { if (retryOffline) void refresh(); }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearInterval(retryInterval);
    };
  }, [setSession, clearSession, markHydrated, setApiOffline]);

  return children;
}
