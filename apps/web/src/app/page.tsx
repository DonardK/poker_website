"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthResponse, CreateTableRequest, PublicUser, TableListItem } from "@poker/shared";
import { api, API_UNAVAILABLE_MESSAGE } from "@/lib/api";
import { disconnectSocket } from "@/lib/socket";
import { useAuthStore } from "@/stores/session";

export default function LobbyPage() {
  const router = useRouter();
  const { user, accessToken, hydrated, apiOffline, setSession, clearSession } = useAuthStore();
  const [tables, setTables] = useState<TableListItem[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [seats, setSeats] = useState(6);
  const [bots, setBots] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [buyIn, setBuyIn] = useState(1000);

  const loadTables = useCallback(async () => {
    if (!accessToken) return;
    const data = await api<{ tables: TableListItem[] }>("/api/tables", { token: accessToken });
    setTables(data.tables);
    setTablesLoaded(true);
  }, [accessToken]);

  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken) {
      setTables([]);
      setTablesLoaded(false);
      return;
    }
    void loadTables().catch((err: Error) => setError(err.message));
    const id = window.setInterval(() => {
      void loadTables().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [hydrated, accessToken, loadTables]);

  const activeTable = tables.find((table) => table.isSeated);

  async function playAsGuest() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<AuthResponse>("/api/auth/guest", { method: "POST" });
      setSession(data.user, data.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Guest login failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/logout", { method: "POST", token: accessToken });
      disconnectSocket();
      clearSession();
      setTables([]);
      setTablesLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out. Please retry.");
    } finally {
      setBusy(false);
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
      botCount: custom ? bots : 5,
      maxSeats: custom ? seats : 6,
    };
    try {
      const data = await api<{ tableId: string }>("/api/tables", {
        method: "POST",
        token: accessToken,
        body: JSON.stringify(body),
      });
      const me = await api<{ user: PublicUser }>("/api/auth/me", { token: accessToken });
      setSession(me.user, accessToken);
      router.push(`/table/${data.tableId}`);
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
          <p className="text-sm uppercase tracking-[0.28em] text-amber-200/80">No-limit Hold&apos;em</p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight sm:text-6xl">
            Hold&apos;em Live
          </h1>
          <p className="mt-3 max-w-xl text-emerald-100/80">
            Play a live hand in seconds. Take a seat with friends or challenge a table of distinct poker bots.
          </p>
        </div>
        {user ? (
          <div className="rounded-2xl border border-amber-200/20 bg-black/20 px-5 py-4">
            <p className="text-xs uppercase tracking-widest text-amber-200/70">Bankroll</p>
            <p className="text-2xl font-semibold">{user.username}</p>
            <p className="text-emerald-200">${user.bankroll.toLocaleString()}</p>
            <button
              disabled={busy}
              className="mt-3 text-sm text-amber-100/70 underline"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="relative hidden w-64 overflow-hidden rounded-3xl border border-amber-200/20 bg-emerald-950/60 p-5 shadow-2xl sm:block" aria-hidden="true">
            <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full border-[20px] border-amber-300/10" />
            <p className="relative text-xs uppercase tracking-[0.2em] text-amber-200/70">Your next hand</p>
            <div className="relative mt-7 flex items-center justify-center gap-2">
              <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-red-700 shadow-xl">A♥</span>
              <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-zinc-900 shadow-xl">K♠</span>
            </div>
            <p className="relative mt-7 text-center font-[family-name:var(--font-display)] text-xl text-amber-100">The table is yours.</p>
          </div>
        )}
      </header>

      {error ? (
        <p className="rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{error}</p>
      ) : null}
      {apiOffline && !error ? (
        <p className="rounded-xl border border-amber-300/40 bg-amber-950/40 px-4 py-3 text-amber-100" role="status">
          {API_UNAVAILABLE_MESSAGE} This page will reconnect automatically.
        </p>
      ) : null}

      {!user ? (
        <section className="flex flex-wrap gap-3">
          <button
            disabled={busy || !hydrated}
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
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3">
          <button
            disabled={busy || !tablesLoaded || (!activeTable && user.bankroll < 1000)}
            onClick={() => activeTable ? router.push(`/table/${activeTable.id}`) : void createTable()}
            className="min-h-12 rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950 transition hover:bg-amber-200 disabled:opacity-50"
          >
            {activeTable ? "Return to your table" : "Open 6-max vs 5 bots"}
          </button>
          <button type="button" onClick={() => setShowSetup((open) => !open)}
            className="min-h-12 rounded-full border border-amber-200/40 px-6 py-3 font-semibold text-amber-100 transition hover:bg-white/10"
            aria-expanded={showSetup} aria-controls="custom-table-setup">
            {showSetup ? "Hide setup" : "Custom table"}
          </button>
          {!activeTable && user.bankroll < 1000 ? (
            <p className="self-center text-sm text-amber-100/70">Need at least $1,000 to open a 100bb table.</p>
          ) : null}
        </section>
      )}

      {user && showSetup ? (
        <form id="custom-table-setup" onSubmit={(event) => { event.preventDefault(); void createTable(true); }}
          className="grid gap-4 rounded-2xl border border-amber-200/20 bg-black/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-4">
            <h2 className="font-[family-name:var(--font-display)] text-2xl">Set up a table</h2>
            <p className="text-sm text-emerald-100/70">{activeTable ? "Leave your current seat before opening another table." : "Choose 2–9 seats and fill the rest with players or bots."}</p>
          </div>
          <label className="flex flex-col gap-2 text-sm">Seats
            <select value={seats} onChange={(e) => { const next = Number(e.target.value); setSeats(next); setBots((count) => Math.min(count, next - 1)); }}
              className="min-h-11 rounded-xl border border-white/20 bg-emerald-950 px-3">
              {Array.from({ length: 8 }, (_, i) => i + 2).map((count) => <option key={count} value={count}>{count} seats</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">Bots
            <select value={bots} onChange={(e) => setBots(Number(e.target.value))}
              className="min-h-11 rounded-xl border border-white/20 bg-emerald-950 px-3">
              {Array.from({ length: seats }, (_, i) => i).map((count) => <option key={count} value={count}>{count} {count === 1 ? "bot" : "bots"}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">Blinds
            <select value={bigBlind} onChange={(e) => { const next = Number(e.target.value); setBigBlind(next); setBuyIn(next * 100); }}
              className="min-h-11 rounded-xl border border-white/20 bg-emerald-950 px-3">
              {[2, 10, 20, 50, 100].map((blind) => <option key={blind} value={blind}>{blind / 2} / {blind}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">Buy-in <span className="text-xs text-emerald-100/60">20–200 big blinds</span>
            <input type="number" min={bigBlind * 20} max={Math.min(bigBlind * 200, user.bankroll)} step={1} required
              value={buyIn} onChange={(e) => setBuyIn(Number(e.target.value))}
              className="min-h-11 rounded-xl border border-white/20 bg-emerald-950 px-3" />
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button disabled={busy || Boolean(activeTable) || !tablesLoaded || user.bankroll < bigBlind * 20 || buyIn > user.bankroll || bots >= seats}
              className="min-h-11 rounded-full bg-amber-300 px-6 font-semibold text-emerald-950 disabled:opacity-50">
              Open table
            </button>
            <p className="text-sm text-emerald-100/60">{seats - bots} human {seats - bots === 1 ? "seat" : "seats"} · {bots} {bots === 1 ? "bot" : "bots"}</p>
          </div>
        </form>
      ) : null}

      {user ? (
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-[0.2em] text-amber-200/70">Open tables</h2>
          <button className="text-xs text-amber-100/70 underline" onClick={() => void loadTables()}>
            Refresh
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {tables.length === 0 ? (
            <p className="text-emerald-100/60">No live tables yet. Open one above to get started.</p>
          ) : (
            tables.map((table) => (
              <button
                key={table.id}
                onClick={() => router.push(`/table/${table.id}`)}
                className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 text-left transition hover:border-amber-200/40 hover:bg-white/10"
              >
                <div>
                  <p className="font-semibold">{table.name}</p>
                  <p className="text-sm text-emerald-100/70">
                    {table.smallBlind}/{table.bigBlind} · {table.occupiedSeats}/{table.maxSeats} seated · {table.botCount}{" "}
                    bots · buy-in {table.minBuyIn}–{table.maxBuyIn}
                  </p>
                </div>
                <span className="shrink-0 text-xs uppercase tracking-widest text-amber-200/80">{table.isSeated ? "Your seat" : table.status}</span>
              </button>
            ))
          )}
        </div>
      </section>
      ) : null}
    </main>
  );
}
