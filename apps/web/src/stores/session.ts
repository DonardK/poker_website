"use client";

import type { HandHistoryLogEntry, PublicTableState, PublicUser } from "@poker/shared";
import { create } from "zustand";

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  hydrated: boolean;
  apiOffline: boolean;
  walletVersion: number;
  leavingTableId: string | null;
  setLeavingTableId: (tableId: string | null) => void;
  setSession: (user: PublicUser, accessToken: string) => void;
  clearSession: () => void;
  markHydrated: () => void;
  setApiOffline: (apiOffline: boolean) => void;
  patchBankroll: (bankroll: number) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  hydrated: false,
  apiOffline: false,
  walletVersion: 0,
  leavingTableId: null,
  setLeavingTableId: (leavingTableId) => set({ leavingTableId }),
  setSession: (user, accessToken) => set((state) => ({ user, accessToken, hydrated: true, apiOffline: false,
    walletVersion: state.user?.id === user.id ? state.walletVersion : 0 })),
  clearSession: () => set({ user: null, accessToken: null, hydrated: true, leavingTableId: null, walletVersion: 0 }),
  markHydrated: () => set({ hydrated: true }),
  setApiOffline: (apiOffline) => set({ apiOffline }),
  patchBankroll: (bankroll) =>
    set((state) => (state.user ? { user: { ...state.user, bankroll }, walletVersion: state.walletVersion + 1 } : state)),
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
