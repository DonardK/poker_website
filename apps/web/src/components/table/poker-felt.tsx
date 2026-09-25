"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { PublicTableState } from "@poker/shared";
import { PlayingCard } from "./playing-card";
import { SeatHud } from "./seat-hud";

export function PokerFelt({
  snapshot,
  heroUserId,
  onClaimSeat,
  canClaimSeats,
}: {
  snapshot: PublicTableState;
  heroUserId: string | null;
  onClaimSeat?: (seatIndex: number) => void;
  canClaimSeats?: boolean;
}) {
  const heroSeat = snapshot.players.find((p) => p.userId === heroUserId)?.seatIndex ?? 0;
  const seats = snapshot.players;
  const n = Math.max(seats.length, 2);
  const winnerSeats = new Set(snapshot.winners.map((w) => w.seatIndex));
  const inHand = snapshot.phase !== "WAITING" && snapshot.phase !== "COMPLETE";
  const reducedMotion = useReducedMotion();

  const layout = useMemo(
    () =>
      seats.map((player) => {
        const visual = ((player.seatIndex - heroSeat) % n + n) % n;
        const angle = Math.PI / 2 + (visual / n) * 2 * Math.PI;
        return {
          player,
          left: `${50 + Math.cos(angle) * 39}%`,
          top: `${50 + Math.sin(angle) * 35}%`,
        };
      }),
    [seats, heroSeat, n],
  );

  return (
    <div className="poker-table mx-auto w-full max-w-6xl">
      <div className="poker-table-felt" aria-hidden="true" />
      <div className="poker-table-center" aria-live="polite">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-100/70">
          {snapshot.phase}
          {snapshot.handNumber > 0 ? ` · Hand #${snapshot.handNumber}` : ""}
        </p>
        <motion.p
          key={snapshot.potTotal}
          initial={reducedMotion ? false : { scale: 0.88, opacity: 0.55, y: 5 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.26, ease: "easeOut" }}
          className="mt-1 text-2xl font-semibold text-amber-50"
        >
          Pot ${snapshot.potTotal.toLocaleString()}
        </motion.p>
        {snapshot.pots.length > 1 ? (
          <p className="text-[11px] text-amber-100/70">
            {snapshot.pots.map((p) => `Pot ${p.index + 1} $${p.amount}`).join(" · ")}
          </p>
        ) : null}
        <div className="mt-3 flex min-h-14 flex-wrap justify-center gap-1">
          {snapshot.board.map((card, i) => (
            <PlayingCard key={`${snapshot.handNumber}-${i}`} card={card} delay={(i % 3) * 0.09} compact />
          ))}
        </div>
        {snapshot.winners.length > 0 ? (
          <motion.p
            key={`${snapshot.handNumber}-${snapshot.winners.map((w) => w.seatIndex).join("-")}`}
            initial={reducedMotion ? false : { opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reducedMotion ? 0 : 0.35, ease: "easeOut" }}
            className="mt-3 text-sm font-medium text-amber-200"
          >
            {snapshot.winners
              .map((w) => {
                const name = seats.find((p) => p.seatIndex === w.seatIndex)?.username ?? `Seat ${w.seatIndex + 1}`;
                return `${name} +$${w.amount}${w.handName ? ` (${w.handName})` : ""}`;
              })
              .join(" · ")}
          </motion.p>
        ) : null}
      </div>
      <div className="poker-table-seats">
        {layout.map(({ player, left, top }) => (
          <div key={player.seatIndex} className={`poker-table-seat ${player.userId === heroUserId ? "poker-table-hero" : ""}`} style={{ left, top }}>
            <SeatHud
              player={player}
              isHero={player.userId === heroUserId}
              isToAct={snapshot.toActSeat === player.seatIndex}
              isWinner={winnerSeats.has(player.seatIndex)}
              turnEndsAt={snapshot.turnEndsAt}
              timeBankMs={snapshot.timeBankMs}
              canClaim={Boolean(canClaimSeats && player.empty)}
              inHand={inHand}
              onClaim={player.empty ? () => onClaimSeat?.(player.seatIndex) : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
