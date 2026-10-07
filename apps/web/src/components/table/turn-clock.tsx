"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { PublicTableState } from "@poker/shared";

/**
 * The acting seat's turn clock.
 *
 * COMPLIANCE NOTE: the server folds (or checks) a player whose time runs out,
 * so the clock a player sees must never show more time than the server will
 * give. The server sends RELATIVE times measured when it built the snapshot
 * (turnRemainingMs / timeBankMsRemaining); the client anchors them to its
 * own monotonic clock (performance.now()) at the moment the snapshot arrived
 * (useTableStore.snapshotReceivedAt). The device's wall clock (Date.now())
 * is never compared with a server timestamp: a phone whose clock is ten
 * seconds slow would otherwise show 25 seconds while the server folds at 15.
 * turnEndsAt is informational only and is not read here.
 */
export interface TurnClockInput {
  /** Total time left for the turn (base plus any time bank) when the snapshot was built, in ms. */
  totalMs: number;
  /** Base (non time-bank) time left when the snapshot was built; null when the server does not split the clock. */
  baseMs: number | null;
  /** The player's personal time-bank pool in ms; null when unknown or the table has none. */
  extraMs: number | null;
  /** performance.now() when the snapshot arrived. */
  receivedAt: number;
  /** The table's base time per turn in ms (PublicTableState.timeBankMs). */
  baseTurnMs: number;
  /** Changes whenever a different turn starts (or a newer measurement arrives), restarting the clock. */
  key: string;
  /** The turn itself (not the measurement): changes only when a different turn starts. */
  turnKey: string;
}

export type TurnClockPhase = "turn" | "base" | "timebank";

export interface TurnClockState {
  /** Total ms left to act (base plus time bank). */
  remainingMs: number;
  /** Whole seconds left to act, rounded up (0 only once the time is gone). */
  seconds: number;
  /** "turn": no split known; "base": base time running with a time bank behind it; "timebank": base time used up. */
  phase: TurnClockPhase;
  /** Ms left in the current phase. */
  phaseRemainingMs: number;
  /** Seconds left in the current phase, rounded up. */
  phaseSeconds: number;
  /** Time bank still to come after the base time (base phase only), in ms. */
  bankAfterMs: number;
  /** Bar fill for the current phase, 0..1, continuous. */
  fraction: number;
  /** Bar fill stepped to whole seconds (reduced motion), 0..1. */
  steppedFraction: number;
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The clock input for the seat to act in `snapshot`, or null when no one is
 * to act or the server sent no remaining time. Optional fields from newer
 * servers (turnRemainingMs, baseTimeMsRemaining, extraTimeMs) are used when
 * present and well-formed; an older server's timeBankMsRemaining still works.
 */
export function turnClockInput(snapshot: PublicTableState | null, receivedAt: number): TurnClockInput | null {
  if (!snapshot || snapshot.toActSeat == null) return null;
  const actor = snapshot.players.find((p) => p.seatIndex === snapshot.toActSeat && !p.empty);
  const totalMs = finiteMs(snapshot.turnRemainingMs) ?? finiteMs(actor?.timeBankMsRemaining);
  if (totalMs == null) return null;
  const baseMs = finiteMs(actor?.baseTimeMsRemaining);
  const extraMs = finiteMs(actor?.extraTimeMs);
  const turnKey = snapshot.turnId ?? `${snapshot.handNumber}:${snapshot.phase}:${snapshot.toActSeat}`;
  return {
    totalMs,
    baseMs: baseMs == null ? null : Math.min(baseMs, totalMs),
    extraMs,
    receivedAt,
    baseTurnMs: finiteMs(snapshot.timeBankMs) ?? 0,
    key: `${turnKey}@${snapshot.revision}:${receivedAt}`,
    turnKey,
  };
}

/** The clock at monotonic time `now`. Pure, for rendering and tests. */
export function turnClockAt(input: TurnClockInput, now: number): TurnClockState {
  const elapsed = Math.max(0, now - input.receivedAt);
  const remainingMs = Math.max(0, input.totalMs - elapsed);
  // A split clock: the server said how much is base time, and a time bank stands behind it.
  const split = input.baseMs != null && (input.totalMs > input.baseMs || (input.extraMs ?? 0) > 0);
  let phase: TurnClockPhase = "turn";
  let phaseRemainingMs = remainingMs;
  let phaseTotalMs = Math.max(input.baseTurnMs, input.totalMs, 1);
  let bankAfterMs = 0;
  if (split && input.baseMs != null) {
    const baseLeft = Math.max(0, input.baseMs - elapsed);
    if (baseLeft > 0) {
      phase = "base";
      phaseRemainingMs = baseLeft;
      phaseTotalMs = Math.max(input.baseTurnMs, input.baseMs, 1);
      bankAfterMs = Math.max(0, input.totalMs - input.baseMs);
    } else {
      phase = "timebank";
      phaseRemainingMs = remainingMs;
      phaseTotalMs = Math.max(input.extraMs ?? 0, input.totalMs - input.baseMs, 1);
    }
  }
  const phaseSeconds = Math.ceil(phaseRemainingMs / 1000);
  return {
    remainingMs,
    seconds: Math.ceil(remainingMs / 1000),
    phase,
    phaseRemainingMs,
    phaseSeconds,
    bankAfterMs,
    fraction: Math.min(1, phaseRemainingMs / phaseTotalMs),
    steppedFraction: Math.min(1, (phaseSeconds * 1000) / phaseTotalMs),
  };
}

/** The live clock, refreshed four times a second until the time is gone. */
export function useTurnClock(input: TurnClockInput | null): TurnClockState | null {
  const [now, setNow] = useState(() => (typeof performance === "undefined" ? 0 : performance.now()));
  const key = input?.key ?? null;
  const endsAt = input ? input.receivedAt + input.totalMs : 0;
  useEffect(() => {
    if (key === null) return;
    setNow(performance.now());
    const id = window.setInterval(() => {
      const current = performance.now();
      setNow(current);
      if (current >= endsAt) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [key, endsAt]);
  return input ? turnClockAt(input, now) : null;
}

/** "42 s" under a minute, "9:59" from a minute up. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The seat's turn bar with a text countdown. The bar is driven from the
 * anchored clock above, not a CSS animation: the reduced-motion rule in
 * globals.css collapses every animation to ~0 ms, which drained the old bar
 * to empty the moment it appeared. Under reduced motion the bar steps once a
 * second with no transition; otherwise it glides between 250 ms updates.
 * The time-bank phase has its own colour and label.
 *
 * The bar glides only within one phase of one turn. A new turn or the switch
 * from base time to the time bank measures a different quantity, so the fill
 * is a new element (keyed on turn and phase) that starts at its true value:
 * gliding there from the previous turn's or phase's level would briefly show
 * a full bar (more time than the server will give) or an empty one.
 */
export function TurnClockBar({ input, compact = false }: { input: TurnClockInput; compact?: boolean }) {
  const clock = useTurnClock(input);
  const reducedMotion = useReducedMotion();
  if (!clock) return null;
  const bank = clock.phase === "timebank";
  const urgent = clock.seconds <= 5;
  const fill = reducedMotion ? clock.steppedFraction : clock.fraction;
  return (
    <div className="turn-clock mt-1" data-testid="turn-clock" data-phase={clock.phase}>
      <div className="h-1.5 overflow-hidden rounded bg-white/15" aria-hidden="true">
        <div
          key={`${input.turnKey}:${clock.phase}`}
          data-testid="turn-clock-fill"
          className={`turn-clock-fill h-full origin-left ${reducedMotion ? "turn-clock-fill--stepped" : ""} ${
            bank ? "bg-sky-300" : urgent ? "bg-red-400" : "bg-amber-300"}`}
          style={{ transform: `scaleX(${fill})` }}
        />
      </div>
      <p className={`mt-0.5 flex items-center justify-between gap-1 text-[11px] tabular-nums ${compact ? "" : "font-medium"} ${
        bank ? "text-sky-100" : urgent ? "text-red-100" : "text-amber-100"}`}>
        <span>{bank ? "Time bank" : clock.phase === "base" && clock.bankAfterMs > 0 ? `+${formatClock(Math.ceil(clock.bankAfterMs / 1000))} bank` : "To act"}</span>
        <span data-testid="turn-clock-seconds">{formatClock(clock.phaseSeconds)}</span>
      </p>
    </div>
  );
}
