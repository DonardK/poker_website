"use client";

import type { HandHistoryLogEntry, PublicTableState, PublicUser } from "@poker/shared";
import { create } from "zustand";

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  hydrated: boolean;
  setSession: (user: PublicUser, accessToken: string) => void;
  clearSession: () => void;
  markHydrated: () => void;
  patchBankroll: (bankroll: number) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  hydrated: false,
  setSession: (user, accessToken) => set({ user, accessToken, hydrated: true }),
  clearSession: () => set({ user: null, accessToken: null, hydrated: true }),
  markHydrated: () => set({ hydrated: true }),
  patchBankroll: (bankroll) =>
    set((state) => (state.user ? { user: { ...state.user, bankroll } } : state)),
}));

interface TableStore {
  snapshot: PublicTableState | null;
  socketStatus: string;
  tableError: string | null;
  setSnapshot: (snapshot: PublicTableState | null) => void;
  setSocketStatus: (socketStatus: string) => void;
  setTableError: (tableError: string | null) => void;
  appendLog: (entry: HandHistoryLogEntry) => void;
  resetTable: () => void;
}

export const useTableStore = create<TableStore>((set) => ({
  snapshot: null,
  socketStatus: "idle",
  tableError: null,
  setSnapshot: (snapshot) => set({ snapshot, tableError: null }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setTableError: (tableError) => set({ tableError }),
  resetTable: () => set({ snapshot: null, socketStatus: "idle", tableError: null }),
  appendLog: (entry) =>
    set((state) => {
      if (!state.snapshot) return state;
      const exists = state.snapshot.logTail.some((l) => l.seq === entry.seq);
      if (exists) return state;
      return {
        snapshot: { ...state.snapshot, logTail: [...state.snapshot.logTail, entry].slice(-40) },
      };
    }),
}));
