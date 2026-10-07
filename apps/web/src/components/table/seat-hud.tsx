"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { PublicPlayerView } from "@poker/shared";
import { formatChips } from "@/lib/format";
import { PlayingCard } from "./playing-card";
import { TurnClockBar, type TurnClockInput } from "./turn-clock";

export function SeatHud({
  player,
  isHero,
  isToAct,
  isWinner,
  clock,
  onClaim,
  canClaim,
  inHand,
}: {
  player: PublicPlayerView;
  isHero: boolean;
  isToAct: boolean;
  isWinner: boolean;
  /** The turn clock when this seat is to act (anchored to arrival, never the device's wall clock). */
  clock: TurnClockInput | null;
  onClaim?: () => void;
  canClaim?: boolean;
  inHand: boolean;
}) {
  const reducedMotion = useReducedMotion();
  if (player.empty) {
    return (
      <button
        type="button"
        disabled={!canClaim}
        onClick={onClaim}
        // Opaque surface and full-strength text: the label must read at 4.5:1
        // over both the felt and the page behind it (WCAG 2.2 AA).
        className={`w-28 rounded-2xl border border-dashed px-3 py-2 text-center text-xs disabled:cursor-default sm:w-36 ${
          canClaim ? "min-h-11 border-amber-200/70 bg-emerald-950 font-semibold text-amber-100 hover:bg-emerald-900" : "border-white/30 bg-emerald-950 text-emerald-100"}`}
        data-testid={canClaim ? "seat-claim" : "open-seat"}
      >
        {canClaim ? "Sit here" : "Open seat"}
      </button>
    );
  }

  return (
    <div
      className={`seat-hud w-32 rounded-2xl border bg-black/60 px-3 py-2 backdrop-blur sm:w-40 ${
        isWinner
          ? "seat-hud--winner border-amber-300 shadow-[0_0_24px_rgba(251,191,36,0.45)]"
          : isToAct
            ? "seat-hud--active border-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.35)]"
            : "border-white/15"
      }`}
    >
      <div className="flex items-center gap-2">
        <div
          className="grid h-8 w-8 place-items-center rounded-full text-xs font-bold text-black"
          style={{ background: `hsl(${player.avatarHue} 70% 60%)` }}
        >
          {player.username.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {player.username}
            {isHero ? " (you)" : ""}
          </p>
          <motion.p
            key={player.stack}
            initial={reducedMotion ? false : { opacity: 0.5, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.24 }}
            className="text-xs text-emerald-200"
          >{formatChips(player.stack)}<span className="sr-only"> chips</span></motion.p>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] uppercase tracking-wider text-amber-200">
        {player.isDealer ? <span className="rounded bg-amber-200/20 px-1">D</span> : null}
        {player.isSb ? <span>SB</span> : null}
        {player.isBb ? <span>BB</span> : null}
        {player.status === "FOLDED" ? <span>Fold</span> : null}
        {player.status === "ALL_IN" ? <span>All-in</span> : null}
        {player.status === "ELIMINATED" ? <span>Busted</span> : null}
        {player.sittingOut ? <span>Out</span> : null}
        {player.waitingForBigBlind && !player.sittingOut ? (
          <span className="rounded bg-white/10 px-1" title="Dealt in when the big blind reaches this seat">
            <span aria-hidden="true">Waiting for BB</span>
            <span className="sr-only">Waiting for the big blind</span>
          </span>
        ) : null}
        {player.botProfile ? <span>{player.botProfile.replace("_", " ")}</span> : null}
      </div>
      {isToAct && clock ? <TurnClockBar input={clock} compact /> : null}
      {player.committedThisStreet > 0 ? (
        <motion.p
          key={player.committedThisStreet}
          initial={reducedMotion ? false : { y: 8, opacity: 0, scale: 0.8 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.28, ease: "easeOut" }}
          className="mx-auto mt-1 w-fit rounded-full border border-amber-200/25 bg-amber-300/10 px-2 py-0.5 text-center text-xs text-amber-100"
        >
          Bet {formatChips(player.committedThisStreet)}
        </motion.p>
      ) : null}
      <div className="mt-2 flex justify-center gap-1">
        {player.holeCards ? (
          <>
            <PlayingCard card={player.holeCards[0]} delay={0.05} />
            <PlayingCard card={player.holeCards[1]} delay={0.12} />
          </>
        ) : inHand && (player.status === "ACTIVE" || player.status === "ALL_IN") ? (
          <>
            <PlayingCard hidden delay={0.05} />
            <PlayingCard hidden delay={0.12} />
          </>
        ) : null}
      </div>
    </div>
  );
}
