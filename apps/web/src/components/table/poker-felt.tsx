"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { PublicTableState } from "@poker/shared";
import { formatChips, formatChipsWithUnit } from "@/lib/format";
import { cardName, PlayingCard } from "./playing-card";
import { SeatHud } from "./seat-hud";
import { turnClockInput } from "./turn-clock";

export function PokerFelt({
  snapshot,
  receivedAt,
  heroUserId,
  onClaimSeat,
  canClaimSeats,
}: {
  snapshot: PublicTableState;
  /** performance.now() when `snapshot` arrived; the turn clock is anchored to it. */
  receivedAt: number;
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
  const clock = turnClockInput(snapshot, receivedAt);
  const announcement = useFeltAnnouncement(snapshot);

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
      {/*
        The felt itself is not a live region: it changes on every snapshot
        (each bet moves the pot), and a screen reader would re-read it every
        time. Only meaningful changes are announced, from this one region.
      */}
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="felt-announcer">{announcement}</p>
      <div className="poker-table-center">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-50">
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
          Pot {formatChips(snapshot.potTotal)}
        </motion.p>
        {snapshot.pots.length > 1 ? (
          <p className="text-xs text-amber-50">
            {snapshot.pots.map((p) => `Pot ${p.index + 1}: ${formatChips(p.amount)}`).join(" · ")}
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
            className="mt-3 text-sm font-medium text-amber-100"
          >
            {snapshot.winners
              .map((w) => {
                const name = seats.find((p) => p.seatIndex === w.seatIndex)?.username ?? `Seat ${w.seatIndex + 1}`;
                return `${name} +${formatChips(w.amount)}${w.handName ? ` (${w.handName})` : ""}`;
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
              clock={snapshot.toActSeat === player.seatIndex ? clock : null}
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

const PHASE_NAMES: Record<string, string> = { FLOP: "Flop", TURN: "Turn", RIVER: "River" };

/**
 * What the felt's live region says: a new hand, each street's new cards and
 * the result, each once. A snapshot that only moves chips (a bet, a call)
 * or repeats the same state (a reconnect, a rehydrate) announces nothing, so
 * a screen-reader user is not flooded with the pot after every action.
 */
function useFeltAnnouncement(snapshot: PublicTableState): string {
  const [message, setMessage] = useState("");
  const last = useRef<{ tableId: string; handNumber: number; boardLength: number; winnersKey: string } | null>(null);
  const winnersKey = snapshot.winners.map((w) => `${w.seatIndex}:${w.amount}`).join("|");
  useEffect(() => {
    const prev = last.current;
    last.current = { tableId: snapshot.tableId, handNumber: snapshot.handNumber, boardLength: snapshot.board.length, winnersKey };
    // The first snapshot of a table is the page loading, not news.
    if (!prev || prev.tableId !== snapshot.tableId) return;
    if (winnersKey && winnersKey !== prev.winnersKey) {
      setMessage(snapshot.winners.map((w) => {
        const name = snapshot.players.find((p) => p.seatIndex === w.seatIndex)?.username ?? `Seat ${w.seatIndex + 1}`;
        return `${name} wins ${formatChipsWithUnit(w.amount)}${w.handName ? ` with ${w.handName}` : ""}.`;
      }).join(" "));
      return;
    }
    if (snapshot.handNumber !== prev.handNumber && snapshot.handNumber > 0) {
      setMessage(`Hand ${snapshot.handNumber} started.`);
      return;
    }
    if (snapshot.handNumber === prev.handNumber && snapshot.board.length > prev.boardLength) {
      const cards = snapshot.board.slice(prev.boardLength).map((card) => cardName(card) ?? "unknown card").join(", ");
      const street = PHASE_NAMES[snapshot.board.length === 3 ? "FLOP" : snapshot.board.length === 4 ? "TURN" : "RIVER"];
      setMessage(`${street}: ${cards}.`);
    }
  }, [snapshot, winnersKey]);
  return message;
}
