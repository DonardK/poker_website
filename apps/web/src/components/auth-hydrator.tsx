"use client";

import { useEffect } from "react";
import type { AuthResponse } from "@poker/shared";
import { refreshSession } from "@/lib/api";
import { disconnectSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

export function AuthHydrator({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);
  const markHydrated = useAuthStore((s) => s.markHydrated);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await refreshSession();
        if (!cancelled) setSession(data.user, data.accessToken);
      } catch {
        if (!cancelled) {
          disconnectSocket();
          clearSession();
        }
      } finally {
        if (!cancelled) markHydrated();
      }
    };
    void refresh();
    const interval = window.setInterval(() => { if (useAuthStore.getState().user) void refresh(); }, 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [setSession, clearSession, markHydrated]);

  return children;
}
