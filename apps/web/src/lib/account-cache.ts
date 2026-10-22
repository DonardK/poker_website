"use client";

import { useCallback, useEffect } from "react";
import type { AccountSecurity } from "@poker/shared";
import { create } from "zustand";
import { fetchAccountSecurity, messageOf } from "@/lib/auth-api";
import { useAuthStore } from "@/stores/session";

/**
 * GET /api/account/security, shared by the account pages and the welcome
 * screen so a visit costs one request. Scoped to the user it was loaded for
 * and wiped by resetClientState, so nothing carries over to another account.
 */
interface AccountCache {
  userId: string | null;
  security: AccountSecurity | null;
  error: string | null;
  loading: boolean;
  /** Bumped by reset: a response for an older generation is dropped. */
  generation: number;
}

const useAccountCache = create<AccountCache>(() => ({ userId: null, security: null, error: null, loading: false, generation: 0 }));

export function resetAccountCache(): void {
  useAccountCache.setState((state) => ({ userId: null, security: null, error: null, loading: false, generation: state.generation + 1 }));
}

async function load(userId: string): Promise<void> {
  const generation = useAccountCache.getState().generation;
  useAccountCache.setState({ loading: true, error: null, userId });
  try {
    const security = await fetchAccountSecurity();
    if (useAccountCache.getState().generation !== generation || useAuthStore.getState().user?.id !== userId) return;
    useAccountCache.setState({ security, loading: false, userId });
    // The overview is the freshest word on these facts: banners and the menu follow it.
    useAuthStore.getState().patchUser({
      emailVerified: security.emailVerified,
      twoFactorEnabled: security.totp.enabled,
      passkeyCount: security.passkeys.length,
      email: security.email,
    });
  } catch (err) {
    if (useAccountCache.getState().generation !== generation) return;
    useAccountCache.setState({ error: messageOf(err, "Could not load your security settings."), loading: false });
  }
}

/** The signed-in user's security overview, loaded on first use; `reload` after any change. */
export function useAccountSecurity(): { security: AccountSecurity | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const cache = useAccountCache();
  const current = cache.userId === userId;
  useEffect(() => {
    if (!userId) return;
    const state = useAccountCache.getState();
    if (state.userId === userId && (state.security || state.loading)) return;
    void load(userId);
  }, [userId]);
  const reload = useCallback(async () => { if (userId) await load(userId); }, [userId]);
  return {
    security: current ? cache.security : null,
    error: current ? cache.error : null,
    loading: !current || cache.loading,
    reload,
  };
}
