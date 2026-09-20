"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
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

  const layout = useMemo(
    () =>
      seats.map((player) => {
        const visual = ((player.seatIndex - heroSeat) % n + n) % n;
        const angle = Math.PI / 2 + (visual / n) * 2 * Math.PI;
        return {
          player,
          left: `${50 + Math.cos(angle) * 38}%`,
          top: `${50 + Math.sin(angle) * 32}%`,
        };
      }),
    [seats, heroSeat, n],
  );

  return (
    <div className="relative mx-auto aspect-[16/10] w-full max-w-5xl min-h-[22rem]">
      <div className="absolute inset-[8%] rounded-[999px] border-8 border-amber-200/50 bg-[radial-gradient(circle_at_center,#1f7a58_0%,#0c3b2c_62%,#08261d_100%)] shadow-[inset_0_0_80px_rgba(0,0,0,0.45)]" />
      <div className="absolute left-1/2 top-1/2 z-30 w-[min(100%,22rem)] -translate-x-1/2 -translate-y-1/2 px-2 text-center">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-100/70">
          {snapshot.phase}
          {snapshot.handNumber > 0 ? ` · Hand #${snapshot.handNumber}` : ""}
        </p>
        <motion.p
          key={snapshot.potTotal}
          initial={{ scale: 0.85, opacity: 0.4 }}
          animate={{ scale: 1, opacity: 1 }}
          className="mt-1 text-2xl font-semibold text-amber-50"
        >
          Pot ${snapshot.potTotal.toLocaleString()}
        </motion.p>
        {snapshot.pots.length > 1 ? (
          <p className="text-[11px] text-amber-100/70">
            {snapshot.pots.map((p) => `Pot ${p.index + 1} $${p.amount}`).join(" · ")}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap justify-center gap-1">
          {snapshot.board.map((card, i) => (
            <PlayingCard key={`${snapshot.animToken}-${card}-${i}`} card={card} delay={i * 0.08} compact />
          ))}
        </div>
        {snapshot.winners.length > 0 ? (
          <p className="mt-3 text-sm text-amber-200">
            {snapshot.winners
              .map((w) => {
                const name = seats.find((p) => p.seatIndex === w.seatIndex)?.username ?? `Seat ${w.seatIndex + 1}`;
                return `${name} +$${w.amount}${w.handName ? ` (${w.handName})` : ""}`;
              })
              .join(" · ")}
          </p>
        ) : null}
      </div>
      {layout.map(({ player, left, top }) => (
        <div key={player.seatIndex} className="absolute z-20 -translate-x-1/2 -translate-y-1/2" style={{ left, top }}>
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
  );
}
