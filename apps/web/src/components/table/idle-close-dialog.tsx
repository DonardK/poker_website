"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import {
  SOCKET_EVENTS,
  TABLE_IDLE_TIMEOUT_MS,
  TABLE_IDLE_WARNING_MS,
  type PublicTableState,
  type TableCloseReason,
} from "@poker/shared";
import { auditableHand, FairnessAudit } from "@/components/table/fairness-audit";
import { formatChipsWithUnit } from "@/lib/format";
import { getSocket } from "@/lib/socket";

/** What the table page must show about the table closing, or null while it is open. */
export type TableClosure =
  | { kind: "warning"; closingInMs: number }
  | { kind: "closing"; reason: TableCloseReason }
  | { kind: "closed"; reason: TableCloseReason | null };

const IDLE_MINUTES = TABLE_IDLE_TIMEOUT_MS / 60_000;
/** One polite announcement part-way through the warning; the panel itself announces the start. */
const ANNOUNCE_AT_SECONDS = 5;
/** The fixed layer the warnings float in (see .idle-float-layer in globals.css). */
const FLOAT_LAYER_ID = "idle-float-layer";

const PANEL_SURFACE =
  "relative overflow-hidden rounded-2xl border bg-[radial-gradient(ellipse_at_top,#17493a_0%,#0b2a20_58%,#071912_100%)] outline-none";

/**
 * The closure state from the latest verified snapshot and the server's
 * refusals. `!= null` on purpose: a snapshot from a server that predates the
 * lifecycle fields (rolling deploy) has neither key and means "open".
 */
export function tableClosure(snapshot: PublicTableState | null, refusedAsClosed: boolean): TableClosure | null {
  if (snapshot?.status === "CLOSED") return { kind: "closed", reason: snapshot.closeReason ?? null };
  // The refusal outranks a snapshot that predates the closure (missed while reconnecting).
  if (refusedAsClosed) return { kind: "closed", reason: snapshot?.closeReason ?? null };
  if (!snapshot) return null;
  if (snapshot.closeReason != null) return { kind: "closing", reason: snapshot.closeReason };
  if (snapshot.closingInMs != null) return { kind: "warning", closingInMs: snapshot.closingInMs };
  return null;
}

/**
 * The idle-closing warning, as a NON-modal panel floating near the top of the
 * screen. Play goes on under it: the action bar and "Sit here" stay usable,
 * and acting or taking a seat cancels the warning on the server just as
 * "I'm still here" does, so there is no backdrop, no inert page and no focus
 * trap. Focus moves to the primary action when the panel appears (ten
 * seconds is urgent) and, if it is still inside the panel, returns to where
 * it was when the panel goes away. Escape does not dismiss it: the table
 * closes whether or not the warning is on screen, so hiding it would only
 * hide the countdown.
 *
 * Shared by the table page (from its snapshot) and the app-wide notice a
 * seated player gets anywhere else (TABLE_IDLE_NOTICE). The countdown runs to
 * a performance.now() deadline measured from arrival. "I'm still here" is
 * confirmed by the server, which re-checks the table under its lock; this
 * panel never decides that the table stays open on its own.
 */
export function IdleWarningPanel({
  tableId,
  accessToken,
  deadline,
  tableName,
  canKeepOpen,
  canTakeSeat = false,
  goToTableHref,
  onKeptOpen,
  onBackToLobby,
  recheck,
}: {
  tableId: string;
  accessToken: string;
  /** performance.now() when the table closes. A new deadline (a newer snapshot or notice) restarts the countdown. */
  deadline: number;
  /** Named when the viewer is somewhere else in the app. */
  tableName?: string;
  /** The viewer is a seated human who is not leaving: only they can keep the table open. */
  canKeepOpen: boolean;
  /** A spectator who could take a seat, which also keeps the table open. */
  canTakeSeat?: boolean;
  /** Offers "Go to table" beside "I'm still here". */
  goToTableHref?: string;
  /** The server confirmed "I'm still here". */
  onKeptOpen: () => void;
  /** The primary action for a viewer who cannot keep the table open. */
  onBackToLobby?: () => void;
  /**
   * Re-read the table when "I'm still here" is not confirmed in time. Only the
   * table's own page can: a re-join from anywhere else would move this
   * connection into that table's room.
   */
  recheck?: () => void;
}) {
  const layer = useFloatLayer();
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reducedMotion = useReducedMotion();
  const remainingMs = useRemainingMs(deadline);
  const seconds = Math.ceil(remainingMs / 1000);
  const urgent = seconds <= 3;
  // Reduced motion: the bar steps once a second instead of draining continuously.
  const fraction = Math.min(1, (reducedMotion ? seconds * 1000 : remainingMs) / TABLE_IDLE_WARNING_MS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Focus on the primary action once the panel is on screen, and back where
  // it was when the panel goes away, but only if the player has not moved on:
  // someone who clicked "Call" keeps focus on the action bar. A layout effect,
  // so on the way out focus is restored while the panel is still in the page
  // (before a closing dialog captures it).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!layer || !panel) return;
    const active = document.activeElement;
    const returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    (primaryRef.current ?? panel).focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      const focusInPanel = !current || current === document.body || panel.contains(current);
      if (focusInPanel && returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus({ preventScroll: true });
    };
  }, [layer]);

  // On a short screen the layer may clip the panel (it stops above the action
  // dock); scroll the layer, never the page, so the focused action shows: when
  // the panel appears, and again when an error note above the buttons pushes
  // them down (a refused "I'm still here" must leave its retry in view, with
  // seconds to go). Layout offsets, not client rects: the entry animation is a
  // transform. (The panel is the button's offsetParent, and the fixed layer the panel's.)
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const primary = primaryRef.current;
    if (!layer || !panel || !primary || layer.scrollHeight <= layer.clientHeight) return;
    const bottom = panel.offsetTop + primary.offsetTop + primary.offsetHeight + 12;
    if (bottom > layer.scrollTop + layer.clientHeight) layer.scrollTop = bottom - layer.clientHeight;
  }, [layer, error]);

  // Screen readers hear the panel (with the seconds left) when it appears,
  // then one polite update at ANNOUNCE_AT_SECONDS and one at zero, never a
  // per-second tick. A new deadline starts afresh.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => setAnnouncement(""), [deadline]);
  useEffect(() => {
    if (seconds === ANNOUNCE_AT_SECONDS) setAnnouncement(`${ANNOUNCE_AT_SECONDS} seconds until the table closes.`);
    else if (seconds === 0) setAnnouncement("Closing the table.");
  }, [seconds]);

  async function keepOpen() {
    if (inFlight.current) return;
    const socket = getSocket(accessToken);
    if (!socket.connected) {
      setError("Reconnecting to the table. Try again in a moment.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const reply = await socket.timeout(10_000).emitWithAck(SOCKET_EVENTS.TABLE_KEEP_ALIVE, { tableId });
      if (!reply.ok) setError(reply.message);
      else onKeptOpen();
    } catch {
      setError(recheck
        ? "The table did not confirm in time. Checking the table; you can try again."
        : "The table did not confirm in time. You can try again.");
      recheck?.();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!layer) return null;

  return createPortal(
    <motion.div
      ref={panelRef}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      initial={reducedMotion ? false : { opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
      className={`${PANEL_SURFACE} w-full max-w-md shrink-0 border-amber-200/35 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.72),0_0_0_1px_rgba(0,0,0,0.4)] sm:p-5`}
    >
      <TopRule />
      <div className="flex items-start gap-3 sm:gap-4">
        <Badge urgent={urgent} compact>
          {seconds > 0 ? (
            <span className={`font-[family-name:var(--font-display)] text-xl font-semibold tabular-nums sm:text-2xl ${urgent ? "text-red-100" : "text-amber-100"}`}
              data-testid="idle-countdown" aria-hidden="true">{seconds}</span>
          ) : <Spinner />}
        </Badge>
        <div className="min-w-0 flex-1">
          <Eyebrow>Inactive table</Eyebrow>
          <h2 id={titleId} className="mt-1 font-[family-name:var(--font-display)] text-xl leading-tight sm:text-2xl">Table closing due to inactivity</h2>
          <div id={descriptionId} className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-emerald-50">
            <p>
              No one has played{tableName ? <> at <strong className="font-semibold text-emerald-50">{tableName}</strong></> : null} for {IDLE_MINUTES} minutes.{" "}
              {seconds > 0 ? (
                <>
                  The table closes in <strong className="font-semibold text-amber-100">{seconds} {seconds === 1 ? "second" : "seconds"}</strong>
                  {canKeepOpen ? " unless you're still here."
                    : canTakeSeat ? " unless a seated player is still here or you take a seat."
                    : " unless a seated player is still here."}
                </>
              ) : <strong className="font-semibold text-amber-100">Closing the table…</strong>}
            </p>
            <p className="idle-panel-aside">Chips at the table go back to each player&apos;s chip balance.</p>
          </div>
        </div>
      </div>
      <CountdownBar fraction={fraction} urgent={urgent} className="mt-4" />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2 sm:gap-3">
        {goToTableHref ? (
          // Set like the buttons beside it (they inherit the panel's font; see globals.css).
          <Link href={goToTableHref}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-amber-200/40 px-5 py-2.5 text-amber-100 transition hover:bg-white/10 sm:flex-none">
            Go to table
          </Link>
        ) : null}
        {canKeepOpen ? (
          <PrimaryButton buttonRef={primaryRef} onClick={() => void keepOpen()} pending={pending} compact>
            {pending ? "Keeping the table open…" : "I'm still here"}
          </PrimaryButton>
        ) : onBackToLobby ? (
          <PrimaryButton buttonRef={primaryRef} onClick={onBackToLobby} compact>Back to lobby</PrimaryButton>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    </motion.div>,
    layer,
  );
}

/**
 * The table is closing, or has closed.
 *
 * A modal alert dialog: nothing at the table can be done any more (the
 * server refuses seats, sit-ins and leaves once closure has begun), so
 * everything else on the page is inert while it is open, focus starts on the
 * primary action and cannot leave, and Escape does not dismiss it. Once
 * closed, a player who was dealt in can verify the last hands before leaving.
 */
export function IdleCloseDialog({
  closure,
  snapshot,
  tableId,
  accessToken,
  bankroll,
  onBackToLobby,
}: {
  closure: Exclude<TableClosure, { kind: "warning" }>;
  /** The latest verified snapshot (the final one, once closed), for "Verify hand". */
  snapshot: PublicTableState | null;
  tableId: string;
  accessToken: string;
  bankroll: number | null;
  onBackToLobby: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Modal behaviour. The rest of the page becomes inert (hidden from
  // assistive technology, unfocusable, unclickable) and stops scrolling.
  // Focus is captured before anything turns inert and returned on close.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || !(el instanceof HTMLElement) || el.inert) continue;
      el.inert = true;
      inerted.push(el);
    }
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const focusPrimary = () => (primaryRef.current ?? panelRef.current)?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        // Never a silent dismissal: the choice stays on screen, with focus on it.
        event.preventDefault();
        event.stopPropagation();
        focusPrimary();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !host.contains(event.target)) focusPrimary();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      for (const el of inerted) el.inert = false;
      root.style.overflow = overflow;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [mounted]);

  // Initial focus, and again whenever the primary action is replaced
  // (closing -> closed), so focus is never dropped to the page.
  useEffect(() => {
    if (mounted) (primaryRef.current ?? panelRef.current)?.focus({ preventScroll: true });
  }, [mounted, closure.kind]);

  if (!mounted) return null;
  const lastHand = closure.kind === "closed" && snapshot ? auditableHand(snapshot, true) : 0;

  return createPortal(
    <motion.div
      ref={hostRef}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.2 }}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm"
    >
      <motion.div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
        className={`${PANEL_SURFACE} my-auto w-full max-w-md border-amber-200/25 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.7)] sm:p-7`}
      >
        <TopRule />
        {closure.kind === "closing" ? (
          <>
            <Eyebrow>Closing</Eyebrow>
            <div className="mt-2 flex items-start gap-4">
              <Badge><Spinner /></Badge>
              <div className="min-w-0">
                <h2 id={titleId} className="font-[family-name:var(--font-display)] text-2xl leading-tight sm:text-3xl">Closing the table…</h2>
                <div id={descriptionId} className="mt-2 space-y-2 text-sm leading-relaxed text-emerald-50">
                  <p>
                    {closure.reason === "IDLE" ? `No one played for ${IDLE_MINUTES} minutes. ` : ""}
                    Any hand in progress is being settled; then chips at the table go back to each player&apos;s chip balance.
                  </p>
                </div>
              </div>
            </div>
            <Actions>
              <PrimaryButton buttonRef={primaryRef} onClick={onBackToLobby}>Back to lobby</PrimaryButton>
            </Actions>
          </>
        ) : (
          <>
            <Eyebrow>Table closed</Eyebrow>
            <div className="mt-2 flex items-start gap-4">
              <Badge><span className="text-2xl text-amber-200" aria-hidden="true">{"♠"}</span></Badge>
              <div className="min-w-0">
                <h2 id={titleId} className="font-[family-name:var(--font-display)] text-2xl leading-tight sm:text-3xl">This table has closed</h2>
                <div id={descriptionId} className="mt-2 space-y-2 text-sm leading-relaxed text-emerald-50">
                  <p>{closedReasonText(closure.reason)}</p>
                  <p>Any chips you had at this table are back in your chip balance.</p>
                </div>
              </div>
            </div>
            {bankroll !== null ? (
              <p className="mt-5 flex items-baseline justify-between rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm">
                <span className="text-xs uppercase tracking-widest text-amber-200">Chip balance</span>
                <span className="font-semibold text-emerald-200">{formatChipsWithUnit(bankroll)}</span>
              </p>
            ) : null}
            {snapshot && lastHand >= 1 ? (
              // An idle closure may have settled the last hand by itself; the
              // record is kept and the player can check it before they go.
              <div className="mt-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3">
                <p className="text-xs uppercase tracking-widest text-amber-200">Hand record</p>
                <p className="mt-1 text-xs leading-relaxed text-emerald-50">
                  Check that a hand you played here was dealt and settled as recorded.
                </p>
                <FairnessAudit tableId={tableId} accessToken={accessToken} snapshot={snapshot} closed
                  className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2" />
              </div>
            ) : null}
            <Actions>
              <PrimaryButton buttonRef={primaryRef} onClick={onBackToLobby}>Back to lobby</PrimaryButton>
            </Actions>
          </>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** The layer element, created on first use and kept: every idle warning on the page stacks in it instead of overlapping. */
function useFloatLayer(): HTMLElement | null {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let el = document.getElementById(FLOAT_LAYER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = FLOAT_LAYER_ID;
      el.className = "idle-float-layer";
      document.body.appendChild(el);
    }
    setLayer(el);
  }, []);
  return layer;
}

/** Milliseconds left until `deadline` (a performance.now() time), refreshed four times a second until it passes. */
function useRemainingMs(deadline: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setNow(performance.now());
    const id = window.setInterval(() => {
      const current = performance.now();
      setNow(current);
      if (current >= deadline) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  return Math.max(0, deadline - now);
}

function closedReasonText(reason: TableCloseReason | null): string {
  if (reason === "IDLE") return `It closed after ${IDLE_MINUTES} minutes without activity.`;
  if (reason === "EMPTY") return "Everyone left the table, so it closed.";
  return "This table is no longer available.";
}

function TopRule() {
  return <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-amber-300/0 via-amber-300/70 to-amber-300/0" />;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-200">{children}</p>;
}

/** A poker-chip roundel: dashed rim, felt centre. */
function Badge({ children, urgent = false, compact = false }: { children: React.ReactNode; urgent?: boolean; compact?: boolean }) {
  return (
    <div aria-hidden="true" className={`grid shrink-0 place-items-center rounded-full border-[3px] border-dashed p-1 transition-colors ${
      compact ? "h-12 w-12 sm:h-14 sm:w-14" : "mt-1 h-16 w-16"} ${urgent ? "border-red-300/80" : "border-amber-300/70"}`}>
      <div className={`grid h-full w-full place-items-center rounded-full border ${urgent ? "border-red-200/30 bg-red-950/40" : "border-amber-200/25 bg-black/30"}`}>
        {children}
      </div>
    </div>
  );
}

function CountdownBar({ fraction, urgent, className }: { fraction: number; urgent: boolean; className: string }) {
  return (
    <div aria-hidden="true" className={`h-1.5 overflow-hidden rounded-full bg-white/10 ${className}`}>
      <div
        className={`h-full origin-left rounded-full transition-transform duration-[250ms] ease-linear motion-reduce:transition-none ${urgent ? "bg-red-400" : "bg-amber-300"}`}
        style={{ transform: `scaleX(${fraction})` }}
      />
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mt-3 rounded-xl border border-red-400/40 bg-red-950/50 px-3 py-2 text-sm text-red-100">{children}</p>;
}

function Spinner() {
  return <span className="block h-6 w-6 rounded-full border-2 border-amber-200/25 border-t-amber-200 motion-safe:animate-spin" />;
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">{children}</div>;
}

/**
 * While pending the button stays focusable (aria-disabled, not disabled): a
 * disabled button drops focus to the page.
 */
function PrimaryButton({ buttonRef, onClick, pending = false, compact = false, children }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  pending?: boolean;
  /** The floating warning's size: shares a row with "Go to table" on a phone. */
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-disabled={pending || undefined}
      onClick={() => { if (!pending) onClick(); }}
      className={`rounded-full bg-amber-300 font-semibold text-emerald-950 transition hover:bg-amber-200 aria-disabled:cursor-wait aria-disabled:opacity-60 ${
        compact ? "min-h-11 flex-1 px-5 py-2.5 sm:flex-none" : "min-h-12 w-full px-6 py-3 sm:w-auto"}`}
    >
      {children}
    </button>
  );
}
