"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { SOCKET_EVENTS } from "@poker/shared";
import { ActionBar } from "@/components/table/action-bar";
import { GameLog } from "@/components/table/game-log";
import { PokerFelt } from "@/components/table/poker-felt";
import { TableControls } from "@/components/table/table-controls";
import { useTableFx } from "@/hooks/use-table-fx";
import { useTableSocket } from "@/hooks/use-table-socket";
import { getSocket } from "@/lib/socket";
import { useAuthStore, useTableStore } from "@/stores/session";

export default function TablePage() {
  const params = useParams<{ id: string }>();
  const { accessToken, user, hydrated } = useAuthStore();
  const snapshot = useTableStore((s) => s.snapshot);
  const socketStatus = useTableStore((s) => s.socketStatus);
  const tableError = useTableStore((s) => s.tableError);
  useTableSocket(params.id, accessToken);
  useTableFx(snapshot, user?.id ?? null);

  if (!hydrated) return null;

  if (!user || !accessToken) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-[family-name:var(--font-display)] text-3xl">Sign in to sit down</h1>
        <p className="mt-3 text-emerald-100/70">You need a session before joining a live table.</p>
        <Link href="/login" className="mt-6 inline-block rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950">
          Register / login
        </Link>
      </main>
    );
  }

  const token = accessToken;
  const legal = snapshot?.actorLegal ?? null;
  const hero = snapshot?.players.find((p) => p.userId === user.id);
  const seated = Boolean(hero && !hero.empty);
  const bankroll = user.bankroll;
  const defaultBuyIn = snapshot
    ? Math.min(snapshot.maxBuyIn, bankroll, Math.max(snapshot.minBuyIn, snapshot.bigBlind * 100))
    : 0;

  function claimSeat(seatIndex: number) {
    if (!snapshot || !params.id) return;
    if (bankroll < snapshot.minBuyIn) return;
    getSocket(token).emit(SOCKET_EVENTS.SEAT_CLAIM, {
      tableId: params.id,
      seatIndex,
      buyIn: defaultBuyIn,
    });
  }

  return (
    <main className="min-h-screen px-4 py-6 lg:px-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-amber-200/80">
            ← Lobby
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl">{snapshot?.name ?? "Table"}</h1>
          <p className="text-sm text-emerald-100/70">
            {snapshot ? `${snapshot.smallBlind}/${snapshot.bigBlind}` : "connecting"} · {statusLabel(socketStatus)}
            {` · ${user.username} · $${user.bankroll.toLocaleString()}`}
          </p>
        </div>
        {snapshot && params.id ? (
          <TableControls tableId={params.id} accessToken={token} snapshot={snapshot} heroUserId={user.id} />
        ) : null}
      </div>

      {tableError ? (
        <p className="mb-4 rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{tableError}</p>
      ) : null}

      {snapshot ? (
        <PokerFelt
          snapshot={snapshot}
          heroUserId={user.id}
          canClaimSeats={!seated && user.bankroll >= snapshot.minBuyIn}
          onClaimSeat={claimSeat}
        />
      ) : (
        <p className="py-24 text-center text-emerald-100/60">Joining table…</p>
      )}

      <div className="mx-auto mt-6 grid max-w-5xl gap-4 lg:grid-cols-[2fr_1fr]">
        {legal && params.id && hero && snapshot ? (
          <ActionBar revision={snapshot.revision} tableId={params.id} accessToken={token} legal={legal} stack={hero.stack} pot={snapshot.potTotal} />
        ) : (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-emerald-100/60">
            {hero?.sittingOut
              ? "You are sitting out. Sit in to be dealt the next hand."
              : hero?.status === "ELIMINATED"
                ? "You are busted. Cash out and buy in again from the lobby."
                : snapshot?.toActSeat != null
                  ? "Waiting for an opponent to act…"
                  : "Waiting for the next hand."}
          </div>
        )}
        <GameLog entries={snapshot?.logTail ?? []} />
      </div>
    </main>
  );
}

function statusLabel(status: string): string {
  if (status === "live") return "Live";
  if (status === "connected" || status === "authenticated") return "Connecting";
  if (status === "error") return "Error";
  return status;
}
