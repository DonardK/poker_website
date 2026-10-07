"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SOCKET_EVENTS } from "@poker/shared";
import { ActionBar } from "@/components/table/action-bar";
import { BuyInDialog } from "@/components/table/buy-in-dialog";
import { ConnectionStatus, isLiveStatus } from "@/components/table/connection-status";
import { GameLog } from "@/components/table/game-log";
import { IdleCloseDialog, IdleWarningPanel, tableClosure } from "@/components/table/idle-close-dialog";
import { PokerFelt } from "@/components/table/poker-felt";
import { TableControls } from "@/components/table/table-controls";
import { TurnAnnouncer } from "@/components/table/turn-announcer";
import { turnClockInput } from "@/components/table/turn-clock";
import { useTableFx } from "@/hooks/use-table-fx";
import { useTableSocket } from "@/hooks/use-table-socket";
import { getSocket } from "@/lib/socket";
import { dropStaleClosedNotice, useAuthStore, useTableStore } from "@/stores/session";
import { API_UNAVAILABLE_MESSAGE } from "@/lib/api";
import { formatChips, formatChipsWithUnit } from "@/lib/format";

export default function TablePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  // The table this page successfully left; the page is on its way to the lobby.
  const [leftTableId, setLeftTableId] = useState<string | null>(null);
  // The server confirmed "I'm still here" while this revision was current. Its
  // warning stays hidden even if the snapshot clearing it is still in flight.
  const [keptOpen, setKeptOpen] = useState<{ tableId: string; revision: number } | null>(null);
  // The seat whose buy-in dialog is open. Nothing is sent until the player confirms an amount there.
  const [buyInSeat, setBuyInSeat] = useState<number | null>(null);
  const closeBuyIn = useCallback(() => setBuyInSeat(null), []);
  const { accessToken, user, hydrated, apiOffline } = useAuthStore();
  const snapshot = useTableStore((s) => s.snapshot);
  const snapshotReceivedAt = useTableStore((s) => s.snapshotReceivedAt);
  const socketStatus = useTableStore((s) => s.socketStatus);
  const tableError = useTableStore((s) => s.tableError);
  const tableClosed = useTableStore((s) => s.tableClosed);
  useTableSocket(params.id, accessToken);
  useTableFx(snapshot, user?.id ?? null);
  // Opening another table's page means the player has moved on from the one
  // whose closure the lobby is still explaining.
  useEffect(() => { if (params.id) dropStaleClosedNotice(params.id); }, [params.id]);

  if (!hydrated) return null;

  if (!user || !accessToken) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-[family-name:var(--font-display)] text-3xl">{apiOffline ? "Game server unavailable" : "Sign in to sit down"}</h1>
        <p className="mt-3 text-emerald-50">{apiOffline ? API_UNAVAILABLE_MESSAGE : "You need a session before joining a live table."}</p>
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
  const disconnected = !isLiveStatus(socketStatus);
  const bankroll = user.bankroll;
  const closure = tableClosure(snapshot, tableClosed);
  // During the warning everything still works (acting or taking a seat
  // cancels it); once closure begins the server refuses seats, sit-ins and leaves.
  const closing = closure?.kind === "closing" || closure?.kind === "closed";
  const keptOpenHere = keptOpen?.tableId === params.id && keptOpen.revision === snapshot?.revision;
  const showClosure = closure !== null && !leaving && leftTableId !== params.id &&
    !(closure.kind === "warning" && keptOpenHere);
  const canClaimSeats = Boolean(snapshot && !seated && !disconnected && !closing && user.bankroll >= snapshot.minBuyIn);

  function backToLobby() {
    // The closed dialog already said why the chips came back; the lobby need not repeat it.
    if (closure?.kind === "closed") useAuthStore.getState().clearTableClosedNotice(params.id);
    router.push("/");
  }

  /** "Sit here" only opens the buy-in dialog; SEAT_CLAIM is sent from there, on Confirm. */
  function claimSeat(seatIndex: number) {
    if (!snapshot || !params.id || disconnected || closing) return;
    if (bankroll < snapshot.minBuyIn) return;
    dropStaleClosedNotice();
    setBuyInSeat(seatIndex);
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
      // The table closed as this request arrived. Closure cashed every seat
      // out in the same commit that closed it, so the player has left, with
      // nothing still to settle.
      if (!reply.ok && reply.code !== "TABLE_CLOSED") throw new Error(reply.message);
      if (!reply.ok || !reply.pendingLeave) useAuthStore.getState().setLeavingTableId(null);
      // Leaving the last seat closes the table; the player chose that, so no closed dialog on the way out.
      setLeftTableId(params.id);
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
            {seated && !closing ? (
              <button type="button" disabled={leaving || disconnected} onClick={() => void leaveTable()}
                className="text-sm text-amber-200 disabled:opacity-50">{leaving ? "Leaving…" : "← Leave table"}</button>
            ) : <Link href="/" className="text-sm text-amber-200">← Lobby</Link>}
            {seated && !closing ? (
              // Honest about what staying seated means: the seat is kept, but
              // the table plays on and a missed turn sits the player out.
              <span className="flex flex-col">
                <Link href="/" className="text-sm text-emerald-50 underline-offset-2 hover:underline" aria-describedby="lobby-keep-seat-help">Back to lobby</Link>
                <span id="lobby-keep-seat-help" className="text-xs text-emerald-50/90">You stay seated. If you miss a turn you are sat out automatically.</span>
              </span>
            ) : null}
          </div>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl sm:text-3xl">{snapshot?.name ?? "Table"}</h1>
          <p className="flex flex-wrap items-center gap-x-1 text-sm text-emerald-50">
            <span>{snapshot ? `Blinds ${formatChips(snapshot.smallBlind)}/${formatChips(snapshot.bigBlind)} · ` : tableClosed ? "" : "connecting · "}</span>
            <ConnectionStatus status={socketStatus} closed={closure?.kind === "closed"} />
            <span>{` · ${user.username} · ${formatChipsWithUnit(user.bankroll)}`}</span>
          </p>
        </div>
        {snapshot && params.id ? (
          <TableControls tableId={params.id} accessToken={token} snapshot={snapshot} heroUserId={user.id}
            onLeave={() => void leaveTable()} leaving={leaving} disconnected={disconnected} closing={closing} />
        ) : null}
      </div>

      {tableError ? (
        <p className="mb-4 rounded-xl border border-red-400/40 bg-red-950/40 px-4 py-3 text-red-100">{tableError}</p>
      ) : null}

      {snapshot ? (
        <PokerFelt
          snapshot={snapshot}
          receivedAt={snapshotReceivedAt}
          heroUserId={user.id}
          canClaimSeats={canClaimSeats}
          onClaimSeat={claimSeat}
        />
      ) : (
        <p className="py-24 text-center text-emerald-50">{tableClosed ? "This table has closed." : "Joining table…"}</p>
      )}

      <div className="mx-auto mt-5 grid max-w-6xl items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        {legal && params.id && hero && snapshot ? (
          <div className="table-action-dock lg:static">
            <ActionBar revision={snapshot.revision} turnId={snapshot.turnId ?? null} tableId={params.id} accessToken={token} legal={legal} stack={hero.stack}
              clock={turnClockInput(snapshot, snapshotReceivedAt)}
              pot={snapshot.potTotal} currentBet={Math.max(0, ...snapshot.players.map((player) => player.committedThisStreet))}
              disconnected={disconnected || leaving || Boolean(hero.pendingLeave)} />
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-emerald-50" role="status">
            {closure?.kind === "closed"
              ? "This table has closed. Any chips you had here are back in your bankroll."
              : closure?.kind === "closing"
              ? "The table is closing. Chips at the table go back to each player's bankroll."
              : hero?.pendingLeave
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
      <TurnAnnouncer snapshot={snapshot} receivedAt={snapshotReceivedAt} heroUserId={user.id} />
      {buyInSeat !== null && snapshot && params.id && !closing ? (
        <BuyInDialog
          tableId={params.id}
          seatIndex={buyInSeat}
          minBuyIn={snapshot.minBuyIn}
          maxBuyIn={snapshot.maxBuyIn}
          bigBlind={snapshot.bigBlind}
          bankroll={bankroll}
          accessToken={token}
          seated={seated}
          onClose={closeBuyIn}
        />
      ) : null}
      {closure && showClosure && params.id ? (
        closure.kind === "warning" ? (
          // Not modal: the table stays playable, and acting or taking a seat keeps it open too.
          <IdleWarningPanel
            tableId={params.id}
            accessToken={token}
            deadline={snapshotReceivedAt + closure.closingInMs}
            canKeepOpen={Boolean(hero && !hero.empty && hero.kind === "HUMAN" && !hero.pendingLeave)}
            canTakeSeat={canClaimSeats && Boolean(snapshot?.players.some((player) => player.empty))}
            onKeptOpen={() => {
              const current = useTableStore.getState().snapshot;
              if (current?.tableId === params.id) setKeptOpen({ tableId: params.id, revision: current.revision });
              useAuthStore.getState().clearTableIdleNotice(params.id);
            }}
            onBackToLobby={backToLobby}
            recheck={() => {
              // Runs after an await, so the render's token may be stale: a
              // session refresh (or sign-out) during the keep-alive replaced the
              // socket, and getSocket with the old token would tear down the new
              // one and its listeners. The new socket re-joins the table itself.
              if (useAuthStore.getState().accessToken !== token) return;
              const socket = getSocket(token);
              if (socket.connected) socket.emit(SOCKET_EVENTS.REHYDRATE, { tableId: params.id });
            }}
          />
        ) : (
          <IdleCloseDialog
            closure={closure}
            snapshot={snapshot}
            tableId={params.id}
            accessToken={token}
            bankroll={user.bankroll}
            onBackToLobby={backToLobby}
          />
        )
      ) : null}
    </main>
  );
}
