"use client";

import { useEffect, useRef, useState } from "react";

export interface PollOptions {
  /** Poll only while true (e.g. while a non-terminal status is on screen). */
  active: boolean;
  /** First delay; each round waits `backoff` times longer, up to maxIntervalMs. */
  intervalMs: number;
  maxIntervalMs: number;
  backoff?: number;
  /** Give up after this long (timedOut turns true). */
  maxDurationMs: number;
}

/**
 * Re-read something on a schedule, politely: only while `active`, only while
 * the page is visible (a hidden tab resumes when shown), backing off like the
 * lobby, and never longer than maxDurationMs. `tick` errors are swallowed (a
 * network blip must not end the wait); the next round tries again.
 */
export function usePoll(tick: () => Promise<unknown>, opts: PollOptions): { timedOut: boolean } {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  const [timedOut, setTimedOut] = useState(false);
  const { active, intervalMs, maxIntervalMs, backoff = 1.5, maxDurationMs } = opts;

  useEffect(() => {
    if (!active) return;
    setTimedOut(false);
    const started = Date.now();
    let delay = intervalMs;
    let timer: number | null = null;
    let running = false;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (Date.now() - started >= maxDurationMs) { setTimedOut(true); return; }
      timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      timer = null;
      if (stopped) return;
      if (document.visibilityState === "hidden") return; // resumed by the visibility listener
      running = true;
      try { await tickRef.current(); } catch { /* the next round tries again */ } finally { running = false; }
      delay = Math.min(maxIntervalMs, Math.round(delay * backoff));
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer === null && !running && !stopped) schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs, maxIntervalMs, backoff, maxDurationMs]);

  return { timedOut };
}
