"use client";

import { useEffect, useId, useState } from "react";
import { SOCKET_EVENTS, type PublicPlayerView, type PublicTableState } from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { setSoundEnabled, soundEnabled } from "@/lib/sounds";
import { FairnessAudit } from "./fairness-audit";

export function TableControls({
  tableId,
  accessToken,
  snapshot,
  heroUserId,
  onLeave,
  leaving,
  disconnected,
}: {
  tableId: string;
  accessToken: string;
  snapshot: PublicTableState;
  heroUserId: string | null;
  onLeave: () => void;
  leaving: boolean;
  disconnected: boolean;
}) {
  const [soundOn, setSoundOn] = useState(true);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  useEffect(() => { setSoundOn(soundEnabled()); }, []);
  const hero = snapshot.players.find((p) => p.userId === heroUserId);
  const inHand = snapshot.phase === "PREFLOP" || snapshot.phase === "FLOP" || snapshot.phase === "TURN" || snapshot.phase === "RIVER";
  const socket = () => getSocket(accessToken);
  const leaveHelpId = useId();
  const leave = hero && !hero.empty ? leaveControl(hero, inHand) : null;

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(window.location.href)
          .then(() => setLinkMessage("Table link copied"))
          .catch(() => setLinkMessage("Could not copy table link"));
      }} className="min-h-10 rounded-full border border-white/20 px-4 py-2 text-sm transition hover:bg-white/10">
        Copy table link
      </button>
      {linkMessage ? <span role="status" className="self-center text-xs text-emerald-100/70">{linkMessage}</span> : null}
      <button type="button" aria-pressed={soundOn} onClick={() => { setSoundEnabled(!soundOn); setSoundOn(!soundOn); }}
        className="min-h-10 rounded-full border border-white/20 px-4 py-2 text-sm transition hover:bg-white/10">
        Sound {soundOn ? "on" : "off"}
      </button>
      <FairnessAudit tableId={tableId} accessToken={accessToken} snapshot={snapshot} />
      {hero && leave ? (
        <>
          <button
            type="button"
            disabled={leaving || disconnected}
            className="min-h-10 rounded-full border border-amber-200/40 px-4 py-2 text-sm transition hover:bg-white/10"
            onClick={() => { const live = socket(); if (live.connected) live.emit(hero.sittingOut ? SOCKET_EVENTS.SIT_IN : SOCKET_EVENTS.SIT_OUT, { tableId }); }}
          >
            {hero.pendingLeave ? "Cancel leave & sit in" : hero.sittingOut ? "Sit in" : "Sit out"}
          </button>
          <button
            type="button"
            disabled={leaving || disconnected}
            className="min-h-10 rounded-full border border-red-300/40 px-4 py-2 text-sm text-red-100 transition hover:bg-red-950/40"
            onClick={onLeave}
            title={leave.help ?? undefined}
            aria-describedby={leave.help ? leaveHelpId : undefined}
          >
            {leaving ? "Leaving…" : hero.pendingLeave ? "Return to lobby" : leave.label}
          </button>
          {leave.help ? <span id={leaveHelpId} className="basis-full text-xs text-emerald-100/70">{leave.help}</span> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Label and help for leaving, matching what the engine does (leaveSeat):
 * outside a betting round the stack is cashed out at once. During one the
 * seat is released when the hand ends; a player still able to act is folded
 * on their turn, or checks if folding would leave a pot they paid into with no
 * eligible player. An all-in hand plays out.
 */
function leaveControl(hero: PublicPlayerView, inHand: boolean): { label: string; help: string | null } {
  if (!inHand || (!hero.holeCards && hero.status === "SIT_OUT")) return { label: `Cash out $${hero.stack.toLocaleString()}`, help: null };
  if (hero.status === "ACTIVE") {
    return {
      label: "Fold & leave",
      help: "Your hand is folded on your turn; your chips return to your bankroll when the hand ends. " +
        "If folding would leave a pot you paid into with no eligible player, you check instead.",
    };
  }
  return {
    label: "Leave after hand",
    help: hero.status === "ALL_IN"
      ? "You are all-in, so your hand plays out; your chips return to your bankroll when the hand ends."
      : "You are not in this hand; your chips return to your bankroll when it ends.",
  };
}
