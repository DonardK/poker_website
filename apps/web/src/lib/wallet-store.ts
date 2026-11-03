"use client";

import { useCallback, useEffect } from "react";
import type { WalletSummary } from "@poker/shared";
import { create } from "zustand";
import { walletErrorMessage } from "@/lib/wallet-copy";
import { fetchWalletSummary } from "@/lib/wallet-api";
import { useAuthStore } from "@/stores/session";

/**
 * GET /api/wallet, shared by the wallet pages so moving between them costs no
 * extra request. Scoped to the user it was loaded for and wiped by
 * resetClientState (a balance never shows under another account), and a
 * response for an older generation is dropped.
 *
 * `flash` is a one-shot notice for the overview after a flow ends elsewhere
 * (e.g. "Withdrawal requested"), shown once and then cleared.
 */
interface WalletCache {
  userId: string | null;
  summary: WalletSummary | null;
  error: string | null;
  loading: boolean;
  generation: number;
  flash: string | null;
}

const useWalletCache = create<WalletCache>(() => ({ userId: null, summary: null, error: null, loading: false, generation: 0, flash: null }));

export function resetWalletCache(): void {
  useWalletCache.setState((state) => ({ userId: null, summary: null, error: null, loading: false, generation: state.generation + 1, flash: null }));
}

async function load(userId: string): Promise<WalletSummary | null> {
  const generation = useWalletCache.getState().generation;
  useWalletCache.setState((state) => ({ loading: true, error: null, userId, summary: state.userId === userId ? state.summary : null }));
  try {
    const summary = await fetchWalletSummary(useAuthStore.getState().user?.bankroll ?? 0);
    if (useWalletCache.getState().generation !== generation || useAuthStore.getState().user?.id !== userId) return null;
    useWalletCache.setState({ summary, loading: false, userId });
    return summary;
  } catch (err) {
    if (useWalletCache.getState().generation !== generation) return null;
    useWalletCache.setState({ error: walletErrorMessage(err), loading: false });
    return null;
  }
}

export function setWalletFlash(flash: string | null): void {
  useWalletCache.setState({ flash });
}

export interface WalletState {
  summary: WalletSummary | null;
  error: string | null;
  loading: boolean;
  /** Load again (after a money action, or while waiting for a status to change). Resolves with the new summary, or null. */
  reload: () => Promise<WalletSummary | null>;
  flash: string | null;
}

/** The signed-in user's wallet summary, loaded on first use. */
export function useWalletSummary(): WalletState {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const cache = useWalletCache();
  const current = cache.userId === userId;
  useEffect(() => {
    if (!userId) return;
    const state = useWalletCache.getState();
    if (state.userId === userId && (state.summary || state.loading)) return;
    void load(userId);
  }, [userId]);
  const reload = useCallback(async () => (userId ? load(userId) : null), [userId]);
  return {
    summary: current ? cache.summary : null,
    error: current ? cache.error : null,
    loading: !current || cache.loading,
    reload,
    flash: current ? cache.flash : null,
  };
}
