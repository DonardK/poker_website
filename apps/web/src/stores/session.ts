"use client";

import type { HandHistoryLogEntry, PublicTableState, PublicUser, SessionEndReason, TableCloseReason } from "@poker/shared";
import { create } from "zustand";

/**
 * Account-security facts about the signed-in user. Login, register, MFA,
 * passkey sign-in and /me send them; a refresh does not, so the last known
 * value is kept for the same user. Undefined means unknown: no banner or
 * prompt is shown for it. `termsVersion` (the version the account last
 * accepted) not matching this build's TERMS_VERSION shows the terms update
 * prompt.
 */
export type SessionUser = PublicUser;

/** The fields `patchUser` may change without a new session. */
export type UserPatch = Partial<Pick<SessionUser,
  "email" | "emailVerified" | "twoFactorEnabled" | "passkeyCount" | "termsVersion" | "avatarHue">>;

const KEPT_FOR_SAME_USER = ["emailVerified", "twoFactorEnabled", "passkeyCount", "termsVersion"] as const;

/** A refreshed user record keeps the security facts it does not carry. */
function mergeKnownFacts(previous: SessionUser | null, next: SessionUser): SessionUser {
  if (!previous || previous.id !== next.id) return next;
  const merged: SessionUser = { ...next };
  for (const key of KEPT_FOR_SAME_USER) {
    if (merged[key] === undefined && previous[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = previous[key];
  }
  return merged;
}

/** A table the user was seated at closed and paid them out while they may not have been watching. */
export interface TableClosedNotice {
  tableId: string;
  reason: TableCloseReason;
}

/**
 * The idle-closing warning of the table this user is seated at, from
 * TABLE_IDLE_NOTICE, so they can keep it open from anywhere in the app (the
 * table's own page shows the warning from its snapshot instead).
 */
export interface TableIdleNotice {
  tableId: string;
  tableName: string;
  /** performance.now() when the table closes: arrival time plus the notice's closingInMs, never a wall-clock time. */
  deadline: number;
}

interface AuthState {
  user: SessionUser | null;
  accessToken: string | null;
  hydrated: boolean;
  apiOffline: boolean;
  /** Counts wallet updates applied in this tab: a fetch started before an update must not overwrite it. */
  walletVersion: number;
  /**
   * The newest server wallet revision (UserPatchPayload.walletVersion) applied
   * for this user, or null before any. A patch at or below it is older news
   * and is dropped, so out-of-order deliveries never move the balance back.
   */
  serverWalletVersion: number | null;
  /** Why the server ended this session (SESSION_REVOKED), shown once until dismissed or the next sign-in. */
  sessionEndedReason: SessionEndReason | null;
  /** A brief notice about a temporary server failure; the session is fine. */
  transientNotice: string | null;
  leavingTableId: string | null;
  /** Shown in the lobby until dismissed. */
  tableClosedNotice: TableClosedNotice | null;
  /**
   * The last table whose closure the user acknowledged in the closed dialog.
   * A cash-out patch for it that arrives after the click raises no notice:
   * the dialog already told them.
   */
  acknowledgedClosedTableId: string | null;
  /** Shown as a floating warning on every page except that table's own. */
  tableIdleNotice: TableIdleNotice | null;
  /**
   * The table this user holds a seat at, from AUTH_OK.activeTableId and the
   * table page; cleared by that table's cash-out. Signing out or switching
   * account asks for confirmation while it is set.
   */
  activeTableId: string | null;
  /** A sign-out message for /login (e.g. the server could not be reached). Survives clearSession; cleared by the next sign-in. */
  signOutNotice: string | null;
  /** Where the gate sends this tab after a deliberate sign-out ("/login", or "/login?switch=1"); cleared by the next sign-in. */
  exitTo: string | null;
  setActiveTableId: (tableId: string | null) => void;
  setSignOutNotice: (notice: string | null) => void;
  setExitTo: (exitTo: string | null) => void;
  /** Update account facts of the signed-in user (no-op when signed out). */
  patchUser: (patch: UserPatch) => void;
  setLeavingTableId: (tableId: string | null) => void;
  setTableClosedNotice: (notice: TableClosedNotice) => void;
  /** Clear the notice when it is about `tableId` (or any table when omitted); another table's closure is still news. */
  clearTableClosedNotice: (tableId?: string) => void;
  setTableIdleNotice: (notice: TableIdleNotice) => void;
  /** Clear the warning when it is about `tableId`: a late "warning over" for another table must not hide this one. */
  clearTableIdleNotice: (tableId: string) => void;
  setSession: (user: SessionUser, accessToken: string) => void;
  clearSession: () => void;
  markHydrated: () => void;
  setApiOffline: (apiOffline: boolean) => void;
  /**
   * Apply a wallet balance. With `serverVersion` (USER_PATCH.walletVersion) it
   * applies only when newer than the last applied revision and returns whether
   * it did; without one it always applies (callers keep their own walletVersion guard).
   */
  patchBankroll: (bankroll: number, serverVersion?: number) => boolean;
  /** The session was revoked by the server: clears it like clearSession and keeps the reason for one notice. */
  endSession: (reason: SessionEndReason) => void;
  dismissSessionEnded: () => void;
  setTransientNotice: (notice: string | null) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  hydrated: false,
  apiOffline: false,
  walletVersion: 0,
  serverWalletVersion: null,
  sessionEndedReason: null,
  transientNotice: null,
  leavingTableId: null,
  tableClosedNotice: null,
  acknowledgedClosedTableId: null,
  tableIdleNotice: null,
  activeTableId: null,
  signOutNotice: null,
  exitTo: null,
  setActiveTableId: (activeTableId) => set({ activeTableId }),
  setSignOutNotice: (signOutNotice) => set({ signOutNotice }),
  setExitTo: (exitTo) => set({ exitTo }),
  patchUser: (patch) => set((state) => (state.user ? { user: { ...state.user, ...patch } } : state)),
  setLeavingTableId: (leavingTableId) => set({ leavingTableId }),
  setTableClosedNotice: (notice) => set((state) =>
    state.acknowledgedClosedTableId === notice.tableId ? state : { tableClosedNotice: notice }),
  clearTableClosedNotice: (tableId) => set((state) => ({
    acknowledgedClosedTableId: tableId ?? state.acknowledgedClosedTableId,
    tableClosedNotice: tableId === undefined || state.tableClosedNotice?.tableId === tableId ? null : state.tableClosedNotice,
  })),
  // Idempotent: the same warning again (AUTH_OK after a reconnect repeating a
  // live TABLE_IDLE_NOTICE) keeps the stored one unless its deadline moved by
  // more than arrival jitter, so the countdown does not flicker.
  setTableIdleNotice: (tableIdleNotice) => set((state) => {
    const current = state.tableIdleNotice;
    return current && current.tableId === tableIdleNotice.tableId && current.tableName === tableIdleNotice.tableName &&
      Math.abs(current.deadline - tableIdleNotice.deadline) < 1_000 ? state : { tableIdleNotice };
  }),
  clearTableIdleNotice: (tableId) => set((state) =>
    state.tableIdleNotice?.tableId === tableId ? { tableIdleNotice: null } : state),
  setSession: (user, accessToken) => set((state) => ({ user: mergeKnownFacts(state.user, user), accessToken, hydrated: true, apiOffline: false,
    walletVersion: state.user?.id === user.id ? state.walletVersion : 0,
    exitTo: null,
    ...(state.user?.id === user.id ? {} : {
      serverWalletVersion: null, sessionEndedReason: null, transientNotice: null,
      tableClosedNotice: null, acknowledgedClosedTableId: null, tableIdleNotice: null,
      activeTableId: null, signOutNotice: null,
    }) })),
  clearSession: () => set({ user: null, accessToken: null, hydrated: true, leavingTableId: null, walletVersion: 0,
    serverWalletVersion: null, transientNotice: null, tableClosedNotice: null, acknowledgedClosedTableId: null, tableIdleNotice: null,
    activeTableId: null }),
  markHydrated: () => set({ hydrated: true }),
  setApiOffline: (apiOffline) => set({ apiOffline }),
  patchBankroll: (bankroll, serverVersion) => {
    const state = get();
    if (!state.user) return false;
    const versioned = typeof serverVersion === "number" && Number.isSafeInteger(serverVersion);
    if (versioned && state.serverWalletVersion !== null && serverVersion <= state.serverWalletVersion) return false;
    set({ user: { ...state.user, bankroll }, walletVersion: state.walletVersion + 1,
      ...(versioned ? { serverWalletVersion: serverVersion } : {}) });
    return true;
  },
  endSession: (reason) => {
    get().clearSession();
    set({ sessionEndedReason: reason });
  },
  dismissSessionEnded: () => set({ sessionEndedReason: null }),
  setTransientNotice: (transientNotice) => set({ transientNotice }),
}));

/**
 * The player has moved on (opened another table's page, opened a table or
 * taken a seat), so the lobby's "your table closed" notice is stale. It is
 * acknowledged, not just hidden: a late cash-out patch for that table raises
 * no new notice. A notice about `currentTableId` itself is kept.
 */
export function dropStaleClosedNotice(currentTableId?: string): void {
  const state = useAuthStore.getState();
  const notice = state.tableClosedNotice;
  if (notice && notice.tableId !== currentTableId) state.clearTableClosedNotice(notice.tableId);
}

interface TableStore {
  snapshot: PublicTableState | null;
  /**
   * performance.now() when `snapshot` arrived on the socket. The idle-closing
   * countdown runs from here plus the snapshot's closingInMs, so it never
   * depends on the server's clock or this device's wall clock.
   */
  snapshotReceivedAt: number;
  socketStatus: string;
  tableError: string | null;
  /**
   * The server refused this table because it has closed (SERVER_ERROR
   * TABLE_CLOSED on join, reconnect or a command). Sticky until the next
   * resetTable: no later error or empty reply can reopen the table.
   */
  tableClosed: boolean;
  setSnapshot: (snapshot: PublicTableState | null, receivedAt?: number) => void;
  setSocketStatus: (socketStatus: string) => void;
  setTableError: (tableError: string | null) => void;
  markTableClosed: () => void;
  appendLog: (entry: HandHistoryLogEntry) => void;
  resetTable: () => void;
}

export const useTableStore = create<TableStore>((set) => ({
  snapshot: null,
  snapshotReceivedAt: 0,
  socketStatus: "idle",
  tableError: null,
  tableClosed: false,
  setSnapshot: (snapshot, receivedAt) => set({ snapshot, snapshotReceivedAt: receivedAt ?? performance.now(), tableError: null }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setTableError: (tableError) => set({ tableError }),
  markTableClosed: () => set({ tableClosed: true, tableError: null, socketStatus: "closed" }),
  resetTable: () => set({ snapshot: null, snapshotReceivedAt: 0, socketStatus: "idle", tableError: null, tableClosed: false }),
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
