"use client";

import { SOCKET_EVENTS, type PublicTableState } from "@poker/shared";
import { getSocket } from "@/lib/socket";

export function TableControls({
  tableId,
  accessToken,
  snapshot,
  heroUserId,
}: {
  tableId: string;
  accessToken: string;
  snapshot: PublicTableState;
  heroUserId: string | null;
}) {
  const hero = snapshot.players.find((p) => p.userId === heroUserId);
  if (!hero || hero.empty) return null;

  const inHand = snapshot.phase === "PREFLOP" || snapshot.phase === "FLOP" || snapshot.phase === "TURN" || snapshot.phase === "RIVER";
  const socket = () => getSocket(accessToken);

  return (
    <div className="flex flex-wrap gap-2">
      {hero.sittingOut ? (
        <button
          type="button"
          className="rounded-full border border-amber-200/40 px-4 py-2 text-sm"
          onClick={() => socket().emit(SOCKET_EVENTS.SIT_IN, { tableId })}
        >
          Sit in
        </button>
      ) : (
        <button
          type="button"
          className="rounded-full border border-white/20 px-4 py-2 text-sm"
          onClick={() => socket().emit(SOCKET_EVENTS.SIT_OUT, { tableId })}
        >
          Sit out
        </button>
      )}
      <button
        type="button"
        className="rounded-full border border-red-300/40 px-4 py-2 text-sm text-red-100"
        onClick={() => socket().emit(SOCKET_EVENTS.STAND_UP, { tableId })}
      >
        {inHand ? "Fold & leave" : `Cash out $${hero.stack.toLocaleString()}`}
      </button>
    </div>
  );
}
