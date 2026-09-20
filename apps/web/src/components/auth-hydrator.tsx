"use client";

import { useEffect } from "react";
import type { AuthResponse } from "@poker/shared";
import { api } from "@/lib/api";
import { disconnectSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

export function AuthHydrator({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);
  const markHydrated = useAuthStore((s) => s.markHydrated);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<AuthResponse>("/api/auth/refresh", { method: "POST" });
        if (!cancelled) setSession(data.user, data.accessToken);
      } catch {
        if (!cancelled) {
          disconnectSocket();
          clearSession();
        }
      } finally {
        if (!cancelled) markHydrated();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession, clearSession, markHydrated]);

  return children;
}
