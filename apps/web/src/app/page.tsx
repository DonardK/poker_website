"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  SOCKET_EVENTS, TABLE_IDLE_TIMEOUT_MS, type AuthResponse, type CreateTableRequest, type PublicUser, type TableListItem, type TableStatus,
} from "@poker/shared";
import { AgeTermsGate, hasConsent, NO_CONSENT, type AgeTermsConsent } from "@/components/age-terms-gate";
import { TurnstileWidget, turnstileTokenField } from "@/components/turnstile-widget";
import { clearLiveEvidence } from "@/hooks/use-table-socket";
import { api, API_UNAVAILABLE_MESSAGE } from "@/lib/api";
import { formatChips, formatChipsWithUnit } from "@/lib/format";
import { PLAY_CHIPS_NOTICE, PLAY_MONEY_NOTICE, termsAcceptance, termsErrorMessage } from "@/lib/legal";
import { disconnectSocket, getSocket } from "@/lib/socket";
import { dropStaleClosedNotice, useAuthStore } from "@/stores/session";

/** Table list refresh while the lobby is visible and the last request succeeded. */
const POLL_INTERVAL_MS = 5_000;
/** Ceiling of the exponential back-off after consecutive failed refreshes (5 s, 10 s, 20 s, 40 s, 60 s, ...). */
const POLL_MAX_BACKOFF_MS = 60_000;

function applyLobbyPatch(tables: TableListItem[], payload: { removed?: boolean; table?: TableListItem }): TableListItem[] {
  const table = payload.table;
  if (!table) return tables;
  if (payload.removed) return tables.filter((row) => row.id !== table.id);
  const index = tables.findIndex((row) => row.id === table.id);
  if (index < 0) return [table, ...tables];
  const next = tables.slice();
  next[index] = table;
  return next;
}

const STATUS_LABELS: Record<TableStatus, string> = {
  WAITING: "Waiting for players",
  IN_HAND: "Hand in progress",
  PAUSED: "Paused",
  CLOSED: "Closed",
};

export default function LobbyPage() {
  const router = useRouter();
  const { user, accessToken, hydrated, apiOffline, leavingTableId, tableClosedNotice, setSession } = useAuthStore();
  const [tables, setTables] = useState<TableListItem[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last table-list refresh failed; cleared by the next successful one. */
  const [listError, setListError] = useState<string | null>(null);
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  const [consent, setConsent] = useState<AgeTermsConsent>(NO_CONSENT);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [tableName, setTableName] = useState("");
  const [seats, setSeats] = useState(6);
  const [bigBlind, setBigBlind] = useState(10);
  const [buyIn, setBuyIn] = useState(1000);

  const loadTables = useCallback(async () => {
    if (!accessToken) return;
    let data: { tables: TableListItem[] };
    try {
      data = await api<{ tables: TableListItem[] }>("/api/tables", { token: accessToken });
    } catch (err) {
      if (useAuthStore.getState().accessToken === accessToken) {
        setListError(err instanceof Error ? err.message : "Request failed");
      }
      throw err;
    }
    if (useAuthStore.getState().accessToken !== accessToken) return;
    setTables(data.tables);
    setTablesLoaded(true);
    setListError(null);
    const state = useAuthStore.getState();
    if (state.leavingTableId && !data.tables.some((table) => table.id === state.leavingTableId && table.isSeated)) {
      state.setLeavingTableId(null);
      // The cash-out's USER_PATCH may arrive while this request is in flight.
      // That patch is newer than anything this response can say, so the
      // response only applies if no wallet update landed in between.
      const walletVersion = state.walletVersion;
      void api<{ user: PublicUser }>("/api/auth/me", { token: accessToken }).then(({ user: latest }) => {
        const now = useAuthStore.getState();
        if (now.accessToken === accessToken && now.walletVersion === walletVersion) now.patchBankroll(latest.bankroll);
      }).catch(() => undefined);
    }
  }, [accessToken]);

  // Single flight: at most one table-list request at a time. A poll that
  // finds one running just waits for it; an explicit refresh (button, table
  // closed) asks for one more run after it, so it sees state newer than its
  // own trigger. The loop always uses the latest loadTables (current token).
  const loadRef = useRef(loadTables);
  loadRef.current = loadTables;
  const inFlight = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const refreshTables = useCallback((options: { fresh: boolean }): Promise<void> => {
    if (inFlight.current) {
      if (options.fresh) rerun.current = true;
      return inFlight.current;
    }
    const run = async () => {
      try {
        do {
          rerun.current = false;
          await loadRef.current();
        } while (rerun.current);
      } finally {
        inFlight.current = null;
        rerun.current = false;
      }
    };
    inFlight.current = run();
    return inFlight.current;
  }, []);

  // Poll only while the page is visible, never overlapping, backing off
  // exponentially while requests fail, and catching up at once when the tab
  // becomes visible again.
  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken) {
      setTables([]);
      setTablesLoaded(false);
      setListError(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const visible = () => document.visibilityState === "visible";
    const schedule = () => {
      window.clearTimeout(timer);
      if (cancelled || !visible()) return;
      timer = window.setTimeout(tick, Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_MAX_BACKOFF_MS));
    };
    function tick() {
      if (cancelled || !visible()) return;
      void refreshTables({ fresh: false })
        .then(() => { failures = 0; }, () => { failures = Math.min(failures + 1, 8); })
        .finally(schedule);
    }
    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (visible()) tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hydrated, accessToken, refreshTables]);

  // The lobby socket pushes seat and status changes. The poll remains the
  // fallback when that socket is down.
  useEffect(() => {
    if (!hydrated || !accessToken) return;
    const socket = getSocket(accessToken);
    const onPatch = (payload: { removed?: boolean; table?: TableListItem }) => {
      setTables((current) => applyLobbyPatch(current, payload));
      setTablesLoaded(true);
    };
    const onSnapshot = (payload: { tables?: TableListItem[] }) => {
      if (!Array.isArray(payload?.tables)) return;
      setTables(payload.tables);
      setTablesLoaded(true);
    };
    socket.on(SOCKET_EVENTS.LOBBY_PATCH, onPatch);
    socket.on(SOCKET_EVENTS.LOBBY_SNAPSHOT, onSnapshot);
    return () => {
      socket.off(SOCKET_EVENTS.LOBBY_PATCH, onPatch);
      socket.off(SOCKET_EVENTS.LOBBY_SNAPSHOT, onSnapshot);
    };
  }, [hydrated, accessToken]);

  // A table this player sat at has just closed and paid them out. Reload now
  // rather than at the next poll, so the lobby never offers "Return to your
  // table" for a table that no longer exists.
  const closedTableId = tableClosedNotice?.tableId ?? null;
  useEffect(() => {
    if (hydrated && closedTableId) void refreshTables({ fresh: true }).catch(() => undefined);
  }, [hydrated, closedTableId, refreshTables]);

  const activeTable = tables.find((table) => table.isSeated);
  const consented = hasConsent(consent);

  async function playAsGuest() {
    // A guest account is an account: never created without the 18+ confirmation and terms acceptance.
    if (!consented) return;
    setBusy(true);
    setError(null);
    setSignOutNotice(null);
    try {
      const data = await api<AuthResponse>("/api/auth/guest", {
        method: "POST",
        body: JSON.stringify({ ...termsAcceptance(), ...turnstileTokenField(turnstileToken) }),
      });
      setSession(data.user, data.accessToken);
    } catch (err) {
      setError(termsErrorMessage(err) ?? (err instanceof Error ? err.message : "Guest login failed"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * SECURITY: signing out must work offline. This device's session, socket
   * and stored hand evidence are cleared FIRST, so a failed or slow request
   * can never leave the account signed in here. Ending the server session
   * (and clearing the refresh cookie) is then attempted best-effort with the
   * token captured before clearing.
   */
  async function signOut() {
    const token = accessToken;
    if (!token) return;
    setError(null);
    disconnectSocket();
    useAuthStore.getState().clearSession();
    clearLiveEvidence();
    setTables([]);
    setTablesLoaded(false);
    setConsent(NO_CONSENT);
    setSignOutNotice(null);
    try {
      await api("/api/auth/logout", { method: "POST", token });
    } catch {
      // Still signed out here. The server session (and its refresh cookie)
      // may outlive this until it expires; say so, for shared devices.
      if (!useAuthStore.getState().accessToken) {
        setSignOutNotice("You are signed out on this device, but the server could not be reached to end the session. "
          + "Reloading while that session is still valid may sign you back in; on a shared device, sign out again once you are back online.");
      }
    }
  }

  async function createTable(custom = false) {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    const body: CreateTableRequest = {
      smallBlind: custom ? Math.floor(bigBlind / 2) : 5,
      bigBlind: custom ? bigBlind : 10,
      buyIn: custom ? buyIn : 1000,
      botCount: 0,
      maxSeats: custom ? seats : 6,
      ...(custom && tableName.trim() ? { name: tableName.trim() } : {}),
    };
    try {
      const data = await api<{ tableId: string }>("/api/tables", {
        method: "POST",
        token: accessToken,
        body: JSON.stringify(body),
      });
      // A new table: the notice about the one that closed is old news.
      dropStaleClosedNotice();
      router.push(`/table/${data.tableId}`);
      const walletVersion = useAuthStore.getState().walletVersion;
      void api<{ user: PublicUser }>("/api/auth/me", { token: accessToken }).then(({ user: latest }) => {
        const state = useAuthStore.getState();
        if (state.accessToken === accessToken && state.walletVersion === walletVersion) state.patchBankroll(latest.bankroll);
      }).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a table");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-9 px-4 py-7 sm:px-8 sm:py-12">
      <header className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div>
          <p className="text-sm uppercase tracking-[0.28em] text-amber-200">No-limit Hold&apos;em · play chips</p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight sm:text-6xl">
            Hold&apos;em Live
          </h1>
          <p className="mt-3 max-w-xl text-emerald-50/90">
            Create a table for friends or join an open one. A hand starts when at least two people are seated.
          </p>
        </div>
        {user ? (
          <div className="max-w-xs rounded-2xl border border-amber-200/30 bg-black/30 px-5 py-4">
            <p className="text-xs uppercase tracking-widest text-amber-200">Play-chip balance</p>
            <p className="text-2xl font-semibold">{user.username}</p>
            <p className="text-lg text-emerald-100">{formatChipsWithUnit(user.bankroll)}</p>
            <p className="mt-1 text-xs text-emerald-50">{PLAY_MONEY_NOTICE}. {PLAY_CHIPS_NOTICE}</p>
            {user.isGuest ? (
              <p className="mt-2 text-xs text-amber-100">Guest account: it cannot be recovered on another device or after clearing this browser&apos;s data.</p>
            ) : null}
            <button
              type="button"
              className="mt-3 text-sm text-amber-100 underline underline-offset-4"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="relative hidden w-64 overflow-hidden rounded-3xl border border-amber-200/20 bg-emerald-950/60 p-5 shadow-2xl sm:block" aria-hidden="true">
            <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full border-[20px] border-amber-300/10" />
            <p className="relative text-xs uppercase tracking-[0.2em] text-amber-200">Your next hand</p>
            <div className="relative mt-7 flex items-center justify-center gap-2">
              <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-red-700 shadow-xl">A♥</span>
              <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-zinc-900 shadow-xl">K♠</span>
            </div>
            <p className="relative mt-7 text-center font-[family-name:var(--font-display)] text-xl text-amber-100">The table is yours.</p>
          </div>
        )}
      </header>

      {signOutNotice ? (
        <p role="status" className="rounded-xl border border-amber-300/40 bg-amber-950/60 px-4 py-3 text-amber-50">{signOutNotice}</p>
      ) : null}
      {leavingTableId ? (
        <p role="status" className="rounded-xl border border-amber-300/40 bg-amber-950/40 px-4 py-3 text-amber-100">
          You have left the table. The current hand is finishing; your remaining chips will return automatically. You can join another table once it settles.
        </p>
      ) : null}
      {tableClosedNotice ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-amber-300/40 bg-amber-950/40 px-4 py-3 text-amber-100">
          <p role="status" className="min-w-0 flex-1 basis-64">
            {tableClosedNotice.reason === "IDLE"
              ? `Your table closed after ${TABLE_IDLE_TIMEOUT_MS / 60_000} minutes without activity. Your chips were returned to your chip balance.`
              : "Your table closed. Your chips were returned to your chip balance."}
          </p>
          <button type="button" onClick={() => useAuthStore.getState().clearTableClosedNotice(tableClosedNotice.tableId)}
            className="min-h-10 shrink-0 rounded-full border border-amber-200/40 px-4 text-sm font-semibold transition hover:bg-white/10">
            Dismiss
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{error}</p>
      ) : null}
      {listError && !error && !apiOffline ? (
        <p role="alert" className="rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">
          Could not refresh the table list ({listError}). Retrying automatically.
        </p>
      ) : null}
      {apiOffline && !error ? (
        <p className="rounded-xl border border-amber-300/40 bg-amber-950/40 px-4 py-3 text-amber-100" role="status">
          {API_UNAVAILABLE_MESSAGE} This page will reconnect automatically.
        </p>
      ) : null}

      {!user ? (
        <section aria-labelledby="start-heading" className="flex max-w-xl flex-col gap-4">
          <h2 id="start-heading" className="sr-only">Start playing</h2>
          <AgeTermsGate value={consent} onChange={setConsent} disabled={busy} />
          <TurnstileWidget onToken={setTurnstileToken} />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy || !hydrated || !consented}
              onClick={() => void playAsGuest()}
              className="rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950 disabled:opacity-50"
            >
              Play as guest
            </button>
            <Link
              href="/login"
              className="rounded-full border border-amber-200/40 px-6 py-3 font-semibold text-amber-100"
            >
              Register / login
            </Link>
          </div>
          <p className="text-sm text-emerald-50/90">
            A guest account has no username or password of your choosing, so it cannot be recovered: it is lost if you sign
            out, clear this browser&apos;s data or switch device, together with its play chips. Register to keep your account.
          </p>
          <p className="text-sm text-emerald-50">{PLAY_MONEY_NOTICE}. {PLAY_CHIPS_NOTICE}</p>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3">
          <button
            disabled={busy || !tablesLoaded || (!activeTable && user.bankroll < 1000)}
            onClick={() => activeTable ? router.push(`/table/${activeTable.id}`) : void createTable()}
            className="min-h-12 rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950 transition hover:bg-amber-200 disabled:opacity-50"
          >
            {activeTable ? "Return to your table" : "Open 6-seat table"}
          </button>
          <button type="button" onClick={() => setShowSetup((open) => !open)}
            className="min-h-12 rounded-full border border-amber-200/40 px-6 py-3 font-semibold text-amber-100 transition hover:bg-white/10"
            aria-expanded={showSetup} aria-controls="custom-table-setup">
            {showSetup ? "Hide setup" : "Custom table"}
          </button>
          {!activeTable && user.bankroll < 1000 ? (
            <p className="self-center text-sm text-amber-100">Need at least {formatChipsWithUnit(1000)} to open a 100-big-blind table.</p>
          ) : null}
        </section>
      )}

      {user && showSetup ? (
        <form id="custom-table-setup" onSubmit={(event) => { event.preventDefault(); void createTable(true); }}
          className="grid gap-4 rounded-2xl border border-amber-200/20 bg-black/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-4">
            <h2 className="font-[family-name:var(--font-display)] text-2xl">Set up a table</h2>
            <p className="text-sm text-emerald-50/90">{activeTable ? "Leave your current seat before opening another table." : "Choose the seats and buy-in. Other people can join from the lobby."}</p>
          </div>
          <label className="flex flex-col gap-2 text-sm sm:col-span-2 lg:col-span-4">Table name
            <input type="text" maxLength={40} value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="My poker table"
              className="min-h-11 rounded-xl border border-white/25 bg-emerald-950 px-3" />
          </label>
          <label className="flex flex-col gap-2 text-sm">Seats
            <select value={seats} onChange={(e) => setSeats(Number(e.target.value))}
              className="min-h-11 rounded-xl border border-white/25 bg-emerald-950 px-3">
              {Array.from({ length: 8 }, (_, i) => i + 2).map((count) => <option key={count} value={count}>{count} seats</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">Blinds
            <select value={bigBlind} onChange={(e) => { const next = Number(e.target.value); setBigBlind(next); setBuyIn(next * 100); }}
              className="min-h-11 rounded-xl border border-white/25 bg-emerald-950 px-3">
              {[2, 10, 20, 50, 100].map((blind) => <option key={blind} value={blind}>{formatChips(blind / 2)} / {formatChips(blind)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">Buy-in <span className="text-xs text-emerald-50/90">20–200 big blinds ({formatChips(bigBlind * 20)}–{formatChips(bigBlind * 200)} chips)</span>
            <input type="number" min={bigBlind * 20} max={Math.min(bigBlind * 200, user.bankroll)} step={1} required
              value={buyIn} onChange={(e) => setBuyIn(Number(e.target.value))}
              className="min-h-11 rounded-xl border border-white/25 bg-emerald-950 px-3" />
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button disabled={busy || Boolean(activeTable) || !tablesLoaded || user.bankroll < bigBlind * 20 || buyIn > user.bankroll}
              className="min-h-11 rounded-full bg-amber-300 px-6 font-semibold text-emerald-950 disabled:opacity-50">
              Open table
            </button>
            <p className="text-sm text-emerald-50/90">{seats} seats for people · waits for a second player</p>
          </div>
        </form>
      ) : null}

      {user ? (
      <section aria-busy={!tablesLoaded}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-[0.2em] text-amber-200">Open tables</h2>
          <button type="button" className="text-sm text-amber-100 underline underline-offset-4" onClick={() => void refreshTables({ fresh: true }).catch(() => undefined)}>
            Refresh
          </button>
        </div>
        {!tablesLoaded ? <p className="sr-only" aria-live="polite">Loading tables</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {!tablesLoaded ? (
            [0, 1, 2, 3].map((slot) => (
              <div key={slot} aria-hidden="true" className="h-[4.5rem] animate-pulse rounded-2xl border border-white/10 bg-white/5" />
            ))
          ) : tables.length === 0 ? (
            <p className="text-emerald-50">No live tables yet. Open one above to get started.</p>
          ) : (
            tables.map((table) => (
              <button
                key={table.id}
                onClick={() => router.push(`/table/${table.id}`)}
                className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-white/15 bg-white/5 px-5 py-4 text-left transition hover:border-amber-200/40 hover:bg-white/10"
              >
                <div>
                  <p className="font-semibold">{table.name}</p>
                  <p className="text-sm text-emerald-50/90">
                    Blinds {formatChips(table.smallBlind)}/{formatChips(table.bigBlind)} · {table.occupiedSeats}/{table.maxSeats} seated
                    {table.botCount ? ` · ${table.botCount} legacy bots` : ""} · buy-in {formatChips(table.minBuyIn)}–{formatChips(table.maxBuyIn)}
                  </p>
                </div>
                <span className="shrink-0 text-xs uppercase tracking-widest text-amber-200">{table.isSeated ? "Your seat" : STATUS_LABELS[table.status] ?? "Open"}</span>
              </button>
            ))
          )}
        </div>
      </section>
      ) : null}
    </main>
  );
}
