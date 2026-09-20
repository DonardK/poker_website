"use client";

import { motion } from "framer-motion";
import type { PublicPlayerView } from "@poker/shared";
import { PlayingCard } from "./playing-card";

export function SeatHud({
  player,
  isHero,
  isToAct,
  isWinner,
  turnEndsAt,
  timeBankMs,
  onClaim,
  canClaim,
  inHand,
}: {
  player: PublicPlayerView;
  isHero: boolean;
  isToAct: boolean;
  isWinner: boolean;
  turnEndsAt: string | null;
  timeBankMs: number;
  onClaim?: () => void;
  canClaim?: boolean;
  inHand: boolean;
}) {
  if (player.empty) {
    return (
      <button
        type="button"
        disabled={!canClaim}
        onClick={onClaim}
        className="w-28 rounded-2xl border border-dashed border-white/20 bg-black/20 px-3 py-2 text-center text-xs text-white/40 disabled:cursor-default sm:w-36"
      >
        {canClaim ? "Sit here" : "Open seat"}
      </button>
    );
  }

  const remainingMs =
    isToAct && turnEndsAt ? Math.max(0, new Date(turnEndsAt).getTime() - Date.now()) : player.timeBankMsRemaining;
  const startPct =
    remainingMs != null && timeBankMs > 0 ? Math.max(0, Math.min(100, (remainingMs / timeBankMs) * 100)) : 0;

  return (
    <div
      className={`w-32 rounded-2xl border bg-black/55 px-3 py-2 backdrop-blur sm:w-40 ${
        isWinner
          ? "border-amber-300 shadow-[0_0_24px_rgba(251,191,36,0.45)]"
          : isToAct
            ? "border-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.35)]"
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
          <p className="text-xs text-emerald-200">${player.stack.toLocaleString()}</p>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] uppercase tracking-wider text-amber-200/80">
        {player.isDealer ? <span className="rounded bg-amber-200/20 px-1">D</span> : null}
        {player.isSb ? <span>SB</span> : null}
        {player.isBb ? <span>BB</span> : null}
        {player.status === "FOLDED" ? <span>Fold</span> : null}
        {player.status === "ALL_IN" ? <span>All-in</span> : null}
        {player.status === "ELIMINATED" ? <span>Busted</span> : null}
        {player.sittingOut ? <span>Out</span> : null}
        {player.botProfile ? <span>{player.botProfile.replace("_", " ")}</span> : null}
      </div>
      {isToAct && remainingMs != null ? (
        <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
          <div
            key={turnEndsAt ?? remainingMs}
            className="h-full origin-left bg-amber-300"
            style={{
              transform: `scaleX(${startPct / 100})`,
              animation: `timebank-drain ${Math.max(remainingMs, 1)}ms linear forwards`,
            }}
          />
        </div>
      ) : null}
      {player.committedThisStreet > 0 ? (
        <motion.p
          key={player.committedThisStreet}
          initial={{ y: 8, opacity: 0, scale: 0.8 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          className="mt-1 text-center text-xs text-amber-100"
        >
          Bet ${player.committedThisStreet}
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
