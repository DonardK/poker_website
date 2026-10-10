"use client";

import { useEffect, useId, useState } from "react";
import { SOCKET_EVENTS, type PublicPlayerView, type PublicTableState } from "@poker/shared";
import { formatChipsWithUnit } from "@/lib/format";
import { getSocket } from "@/lib/socket";
import { setSoundEnabled, soundEnabled } from "@/lib/sounds";
import { FairnessAudit } from "./fairness-audit";
import { FOCUS_ACTIONS_KEY, readBooleanPreference, writeBooleanPreference } from "./preferences";

export function TableControls({
  tableId,
  accessToken,
  snapshot,
  heroUserId,
  onLeave,
  leaving,
  disconnected,
  closing = false,
}: {
  tableId: string;
  accessToken: string;
  snapshot: PublicTableState;
  heroUserId: string | null;
  onLeave: () => void;
  leaving: boolean;
  disconnected: boolean;
  /**
   * Closure has begun or finished. The server cashes every player out, so
   * there is nothing to sit in to or leave; the server would refuse both.
   */
  closing?: boolean;
}) {
  const [soundOn, setSoundOn] = useState(true);
  const [focusOnTurn, setFocusOnTurn] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  // Preferences are read after hydration (the server render cannot see
  // storage); both readers are best-effort and never throw.
  useEffect(() => {
    setSoundOn(soundEnabled());
    setFocusOnTurn(readBooleanPreference(FOCUS_ACTIONS_KEY, false));
  }, []);
  const hero = snapshot.players.find((p) => p.userId === heroUserId);
  const inHand = snapshot.phase === "PREFLOP" || snapshot.phase === "FLOP" || snapshot.phase === "TURN" || snapshot.phase === "RIVER";
  const socket = () => getSocket(accessToken);
  const leaveHelpId = useId();
  const sitOutNoticeId = useId();
  const sitOutNotice = hero?.sittingOut && !hero.pendingLeave ? sittingOutNotice(hero.sittingOutReason) : null;
  const leave = hero && !hero.empty && !closing ? leaveControl(hero, inHand) : null;

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(window.location.href)
          .then(() => setLinkMessage("Table link copied"))
          .catch(() => setLinkMessage("Could not copy table link"));
      }} className="min-h-10 rounded-full border border-white/30 px-4 py-2 text-sm transition hover:bg-white/10">
        Copy table link
      </button>
      {linkMessage ? <span role="status" className="self-center text-xs text-emerald-50">{linkMessage}</span> : null}
      <button type="button" aria-pressed={soundOn} onClick={() => { setSoundEnabled(!soundOn); setSoundOn(!soundOn); }}
        className="min-h-10 rounded-full border border-white/30 px-4 py-2 text-sm transition hover:bg-white/10">
        Sound {soundOn ? "on" : "off"}
      </button>
      <button type="button" aria-pressed={focusOnTurn}
        onClick={() => { writeBooleanPreference(FOCUS_ACTIONS_KEY, !focusOnTurn); setFocusOnTurn(!focusOnTurn); }}
        className="min-h-10 rounded-full border border-white/30 px-4 py-2 text-sm transition hover:bg-white/10">
        Focus actions on my turn
      </button>
      <FairnessAudit tableId={tableId} accessToken={accessToken} snapshot={snapshot} />
      {hero && leave ? (
        <>
          <button
            type="button"
            disabled={leaving || disconnected}
            className="min-h-10 rounded-full border border-amber-200/40 px-4 py-2 text-sm transition hover:bg-white/10"
            onClick={() => { const live = socket(); if (live.connected) live.emit(hero.sittingOut ? SOCKET_EVENTS.SIT_IN : SOCKET_EVENTS.SIT_OUT, { tableId }); }}
            aria-describedby={sitOutNotice ? sitOutNoticeId : undefined}
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
          {sitOutNotice ? (
            <p id={sitOutNoticeId} data-testid="sit-out-notice"
              className="basis-full rounded-xl border border-amber-300/50 bg-amber-950/80 px-3 py-2 text-sm text-amber-50">
              {sitOutNotice}
            </p>
          ) : null}
          {leave.help ? <span id={leaveHelpId} className="basis-full text-xs text-emerald-50">{leave.help}</span> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Label and help for leaving, matching what the engine does (leaveSeat):
 * outside a betting round the stack is returned at once. During one the
 * seat is released when the hand ends; a player still able to act is folded
 * on their turn, or checks if folding would leave a pot they paid into with no
 * eligible player. An all-in hand plays out.
 */
function leaveControl(hero: PublicPlayerView, inHand: boolean): { label: string; help: string | null } {
  if (!inHand || (!hero.holeCards && hero.status === "SIT_OUT")) {
    return { label: `Leave table & return ${formatChipsWithUnit(hero.stack)}`, help: null };
  }
  if (hero.status === "ACTIVE") {
    return {
      label: "Fold & leave",
      help: "Your hand is folded on your turn; your chips return to your chip balance when the hand ends. " +
        "If folding would leave a pot you paid into with no eligible player, you check instead.",
    };
  }
  return {
    label: "Leave after hand",
    help: hero.status === "ALL_IN"
      ? "You are all-in, so your hand plays out; your chips return to your chip balance when the hand ends."
      : "You are not in this hand; your chips return to your chip balance when it ends.",
  };
}

/**
 * Why the server sat this player out, when it was not their own choice, so
 * the "Sit in" button is not the only clue that they were removed from play.
 * A self-chosen sit-out (or a server that does not send the reason) needs no notice.
 */
function sittingOutNotice(reason: PublicPlayerView["sittingOutReason"]): string | null {
  if (reason === "TIMEOUT") return "You were sat out because your time to act ran out. Sit in to play again.";
  if (reason === "DISCONNECTED") return "You were sat out because your connection dropped. Sit in to play again.";
  return null;
}
