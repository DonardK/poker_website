"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SOCKET_EVENTS } from "@poker/shared";
import { ActionBar } from "@/components/table/action-bar";
import { GameLog } from "@/components/table/game-log";
import { PokerFelt } from "@/components/table/poker-felt";
import { TableControls } from "@/components/table/table-controls";
import { useTableFx } from "@/hooks/use-table-fx";
import { useTableSocket } from "@/hooks/use-table-socket";
import { getSocket } from "@/lib/socket";
import { useAuthStore, useTableStore } from "@/stores/session";
import { API_UNAVAILABLE_MESSAGE } from "@/lib/api";

export default function TablePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const { accessToken, user, hydrated, apiOffline } = useAuthStore();
  const snapshot = useTableStore((s) => s.snapshot);
  const socketStatus = useTableStore((s) => s.socketStatus);
  const tableError = useTableStore((s) => s.tableError);
  useTableSocket(params.id, accessToken);
  useTableFx(snapshot, user?.id ?? null);

  if (!hydrated) return null;

  if (!user || !accessToken) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-[family-name:var(--font-display)] text-3xl">{apiOffline ? "Game server unavailable" : "Sign in to sit down"}</h1>
        <p className="mt-3 text-emerald-100/70">{apiOffline ? API_UNAVAILABLE_MESSAGE : "You need a session before joining a live table."}</p>
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
  const disconnected = socketStatus !== "live" && socketStatus !== "cards verified";
  const bankroll = user.bankroll;
  const defaultBuyIn = snapshot
    ? Math.min(snapshot.maxBuyIn, bankroll, Math.max(snapshot.minBuyIn, snapshot.bigBlind * 100))
    : 0;

  function claimSeat(seatIndex: number) {
    if (!snapshot || !params.id || disconnected) return;
    if (bankroll < snapshot.minBuyIn) return;
    getSocket(token).emit(SOCKET_EVENTS.SEAT_CLAIM, {
      tableId: params.id,
      seatIndex,
      buyIn: defaultBuyIn,
    });
  }

  async function leaveTable() {
    if (leaving) return;
    const socket = getSocket(token);
    if (!socket.connected) {
      useTableStore.getState().setTableError("Reconnect before leaving so we can confirm your cash-out.");
      return;
    }
    setLeaving(true);
    useTableStore.getState().setTableError(null);
    // Set before sending: settlement can arrive before the acknowledgement.
    useAuthStore.getState().setLeavingTableId(params.id);
    try {
      const reply = await socket.timeout(10_000).emitWithAck(SOCKET_EVENTS.STAND_UP, { tableId: params.id });
      if (!reply.ok) throw new Error(reply.message);
      if (!reply.pendingLeave) useAuthStore.getState().setLeavingTableId(null);
      router.push("/");
    } catch (err) {
      useAuthStore.getState().setLeavingTableId(null);
      useTableStore.getState().setTableError(err instanceof Error && err.message !== "operation has timed out"
        ? err.message : "Leave confirmation timed out. Checking your seat; you can safely retry.");
      if (socket.connected) socket.emit(SOCKET_EVENTS.REHYDRATE, { tableId: params.id });
    } finally {
      setLeaving(false);
    }
  }

  return (
    <main className={`mx-auto min-h-screen max-w-[1600px] px-3 py-4 sm:px-6 sm:py-6 lg:px-8 ${legal ? "table-page-with-actions" : ""}`}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap gap-4">
            {seated ? (
              <button type="button" disabled={leaving || disconnected} onClick={() => void leaveTable()}
                className="text-sm text-amber-200/80 disabled:opacity-50">{leaving ? "Leaving…" : "← Leave table"}</button>
            ) : <Link href="/" className="text-sm text-amber-200/80">← Lobby</Link>}
            {seated ? <Link href="/" className="text-sm text-emerald-100/60">Lobby (keep seat)</Link> : null}
          </div>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl sm:text-3xl">{snapshot?.name ?? "Table"}</h1>
          <p className="text-sm text-emerald-100/70">
            {snapshot ? `${snapshot.smallBlind}/${snapshot.bigBlind}` : "connecting"} · {statusLabel(socketStatus)}
            {` · ${user.username} · $${user.bankroll.toLocaleString()}`}
          </p>
        </div>
        {snapshot && params.id ? (
          <TableControls tableId={params.id} accessToken={token} snapshot={snapshot} heroUserId={user.id}
            onLeave={() => void leaveTable()} leaving={leaving} disconnected={disconnected} />
        ) : null}
      </div>

      {tableError ? (
        <p className="mb-4 rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{tableError}</p>
      ) : null}

      {snapshot ? (
        <PokerFelt
          snapshot={snapshot}
          heroUserId={user.id}
          canClaimSeats={!seated && !disconnected && user.bankroll >= snapshot.minBuyIn}
          onClaimSeat={claimSeat}
        />
      ) : (
        <p className="py-24 text-center text-emerald-100/60">Joining table…</p>
      )}

      <div className="mx-auto mt-5 grid max-w-6xl items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        {legal && params.id && hero && snapshot ? (
          <div className="table-action-dock lg:static">
            <ActionBar revision={snapshot.revision} tableId={params.id} accessToken={token} legal={legal} stack={hero.stack}
              pot={snapshot.potTotal} currentBet={Math.max(0, ...snapshot.players.map((player) => player.committedThisStreet))}
              disconnected={disconnected || leaving || Boolean(hero.pendingLeave)} />
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-emerald-100/70" role="status">
            {hero?.pendingLeave
              ? "Leaving after this hand. Your remaining chips will return automatically."
              : hero?.sittingOut
              ? "You are sitting out. Sit in to play again; if you missed a blind while out, you may wait for the big blind."
              : hero?.status === "ELIMINATED"
                ? "You are busted. Cash out and buy in again from the lobby."
              : hero?.waitingForBigBlind
                  ? "You will be dealt in when the big blind reaches you."
                  : snapshot?.phase === "WAITING"
                    ? "Waiting for another person to take a seat. Share this table's link or ask them to join from the lobby."
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
  if (status === "cards verified") return "Cards verified";
  if (status === "disconnected") return "Reconnecting";
  if (status === "connected" || status === "authenticated") return "Connecting";
  if (status === "error") return "Error";
  return status;
}
