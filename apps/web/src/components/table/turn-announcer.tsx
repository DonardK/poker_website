"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicTableState } from "@poker/shared";
import { turnClockAt, turnClockInput, useTurnClock } from "./turn-clock";

/** The one reminder before the time runs out. */
const WARN_AT_SECONDS = 5;

function secondsText(seconds: number): string {
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * A polite live region for the hero's turn. It says "Your turn — N seconds
 * to act" when the server offers this player actions, and once more at
 * WARN_AT_SECONDS left; never a per-second tick, never again for the same
 * turn when a newer snapshot of it arrives. It stays mounted for the whole
 * page (a live region added together with its text is often not read).
 */
export function TurnAnnouncer({ snapshot, receivedAt, heroUserId }: {
  snapshot: PublicTableState | null;
  receivedAt: number;
  heroUserId: string | null;
}) {
  const hero = snapshot?.players.find((p) => p.userId === heroUserId && !p.empty) ?? null;
  const heroTurn = Boolean(snapshot?.actorLegal && hero && snapshot.toActSeat === hero.seatIndex);
  const input = heroTurn ? turnClockInput(snapshot, receivedAt) : null;
  const clock = useTurnClock(input);
  // Identity of the hero's current turn: the server's turnId when sent.
  // Without one, a turn is one unbroken stretch of actorLegal being present
  // (it disappears as soon as the hero acts), so a refreshed snapshot of the
  // same turn is never announced twice.
  const turnIdentity = heroTurn && snapshot ? `${snapshot.tableId}:${snapshot.turnId ?? "current"}` : null;
  const turn = useRef<{ identity: string; warned: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const pendingTimer = useRef<number | null>(null);

  const announce = (text: string) => {
    // Clear first: the same words as last time (two turns in a row) would
    // otherwise not change the region and not be read.
    setMessage("");
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => setMessage(text), 60);
  };
  useEffect(() => () => { if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current); }, []);

  useEffect(() => {
    if (turnIdentity === null) {
      turn.current = null;
      return;
    }
    if (turn.current?.identity === turnIdentity) return;
    const seconds = input ? turnClockAt(input, performance.now()).seconds : null;
    turn.current = { identity: turnIdentity, warned: seconds !== null && seconds <= WARN_AT_SECONDS };
    announce(seconds !== null ? `Your turn — ${secondsText(seconds)} to act` : "Your turn");
    // Keyed on the turn alone: input is derived from the same snapshot, and a
    // newer snapshot of the same turn must not announce it again.
  }, [turnIdentity]);

  const seconds = clock?.seconds ?? null;
  useEffect(() => {
    const current = turn.current;
    if (!current || current.warned || seconds === null || seconds > WARN_AT_SECONDS || seconds <= 0) return;
    current.warned = true;
    announce(`${secondsText(seconds)} left to act`);
  }, [seconds]);

  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="turn-announcer">{message}</p>;
}
