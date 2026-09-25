"use client";

import { useEffect, useState } from "react";
import { SOCKET_EVENTS, type PublicTableState } from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { setSoundEnabled, soundEnabled } from "@/lib/sounds";
import { FairnessAudit } from "./fairness-audit";

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
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => { setSoundOn(soundEnabled()); }, []);
  const hero = snapshot.players.find((p) => p.userId === heroUserId);
  const inHand = snapshot.phase === "PREFLOP" || snapshot.phase === "FLOP" || snapshot.phase === "TURN" || snapshot.phase === "RIVER";
  const socket = () => getSocket(accessToken);

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={soundOn} onClick={() => { setSoundEnabled(!soundOn); setSoundOn(!soundOn); }}
        className="min-h-10 rounded-full border border-white/20 px-4 py-2 text-sm transition hover:bg-white/10">
        Sound {soundOn ? "on" : "off"}
      </button>
      <FairnessAudit tableId={tableId} accessToken={accessToken} snapshot={snapshot} />
      {hero && !hero.empty ? (
        <>
          <button
            type="button"
            className="min-h-10 rounded-full border border-amber-200/40 px-4 py-2 text-sm transition hover:bg-white/10"
            onClick={() => socket().emit(hero.sittingOut ? SOCKET_EVENTS.SIT_IN : SOCKET_EVENTS.SIT_OUT, { tableId })}
          >
            {hero.sittingOut ? "Sit in" : "Sit out"}
          </button>
          <button
            type="button"
            className="min-h-10 rounded-full border border-red-300/40 px-4 py-2 text-sm text-red-100 transition hover:bg-red-950/40"
            onClick={() => socket().emit(SOCKET_EVENTS.STAND_UP, { tableId })}
          >
            {inHand ? "Fold & leave" : `Cash out $${hero.stack.toLocaleString()}`}
          </button>
        </>
      ) : null}
    </div>
  );
}
