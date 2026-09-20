"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthResponse, CreateTableRequest, PublicUser, TableListItem } from "@poker/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/session";

export default function LobbyPage() {
  const router = useRouter();
  const { user, accessToken, hydrated, setSession, clearSession } = useAuthStore();
  const [tables, setTables] = useState<TableListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTables = useCallback(async () => {
    if (!accessToken) return;
    const data = await api<{ tables: TableListItem[] }>("/api/tables", { token: accessToken });
    setTables(data.tables);
  }, [accessToken]);

  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken) {
      setTables([]);
      return;
    }
    void loadTables().catch((err: Error) => setError(err.message));
    const id = window.setInterval(() => {
      void loadTables().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [hydrated, accessToken, loadTables]);

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

  async function createTable() {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    const body: CreateTableRequest = {
      smallBlind: 5,
      bigBlind: 10,
      buyIn: 1000,
      botCount: 5,
      maxSeats: 6,
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
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-12">
      <header className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div>
          <p className="text-sm uppercase tracking-[0.28em] text-amber-200/80">No-limit Hold&apos;em</p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight">
            Hold&apos;em Live
          </h1>
          <p className="mt-3 max-w-xl text-emerald-100/80">
            Authoritative real-time Texas Hold&apos;em. Spin up a six-max table and sit against TAG, calling-station,
            maniac, and GTO bots.
          </p>
        </div>
        {user ? (
          <div className="rounded-2xl border border-amber-200/20 bg-black/20 px-5 py-4">
            <p className="text-xs uppercase tracking-widest text-amber-200/70">Bankroll</p>
            <p className="text-2xl font-semibold">{user.username}</p>
            <p className="text-emerald-200">${user.bankroll.toLocaleString()}</p>
            <button
              className="mt-3 text-sm text-amber-100/70 underline"
              onClick={() => {
                void api("/api/auth/logout", { method: "POST", token: accessToken });
                clearSession();
                setTables([]);
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      {error ? (
        <p className="rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{error}</p>
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
        <section className="flex flex-wrap gap-3">
          <button
            disabled={busy || user.bankroll < 1000}
            onClick={() => void createTable()}
            className="rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950 disabled:opacity-50"
          >
            Open 6-max vs 5 bots
          </button>
          {user.bankroll < 1000 ? (
            <p className="self-center text-sm text-amber-100/70">Need at least $1,000 to open a 100bb table.</p>
          ) : null}
        </section>
      )}

      {user ? (
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-[0.2em] text-amber-200/70">Open tables</h2>
          <button className="text-xs text-amber-100/70 underline" onClick={() => void loadTables()}>
            Refresh
          </button>
        </div>
        <div className="grid gap-3">
          {tables.length === 0 ? (
            <p className="text-emerald-100/60">No live tables yet.</p>
          ) : (
            tables.map((table) => (
              <button
                key={table.id}
                onClick={() => router.push(`/table/${table.id}`)}
                className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-5 py-4 text-left hover:border-amber-200/40"
              >
                <div>
                  <p className="font-semibold">{table.name}</p>
                  <p className="text-sm text-emerald-100/70">
                    {table.smallBlind}/{table.bigBlind} · {table.occupiedSeats}/{table.maxSeats} seated · {table.botCount}{" "}
                    bots · buy-in {table.minBuyIn}–{table.maxBuyIn}
                  </p>
                </div>
                <span className="text-xs uppercase tracking-widest text-amber-200/80">{table.status}</span>
              </button>
            ))
          )}
        </div>
      </section>
      ) : null}
    </main>
  );
}
