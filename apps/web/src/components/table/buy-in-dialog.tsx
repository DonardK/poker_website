"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SOCKET_EVENTS, type CommandResult, type SocketErrorPayload } from "@poker/shared";
import { formatChipsWithUnit } from "@/lib/format";
import { getSocket } from "@/lib/socket";
import { clampChips, normaliseChipDraft, parseChipDraft } from "./chip-amount";

/** After this long without an outcome the dialog says it is still waiting (never that it failed) and re-reads the table. */
const SLOW_CONFIRM_MS = 8_000;

/**
 * The buy-in for one seat. COMPLIANCE NOTE: taking a seat moves chips from
 * the player's bankroll to the table, so nothing is sent until the player
 * has seen and confirmed the amount and the balance it leaves. (Before this
 * dialog, "Sit here" bought in at once for up to 100 big blinds, possibly
 * the whole bankroll, without showing the amount.)
 *
 * A modal dialog: the rest of the page is inert, focus starts on the amount
 * and cannot leave, Escape and Cancel close it. SEAT_CLAIM carries a fresh
 * commandId (a retry of the same command reuses it on the server side) and
 * an ack callback. Servers that do not ack yet are handled by watching for
 * the outcome instead: the player's seat appearing in a snapshot, or a
 * SERVER_ERROR about this table. No outcome within SLOW_CONFIRM_MS is not a
 * failure (the seat may still be taken), so the dialog never reports a timeout.
 */
export function BuyInDialog({
  tableId,
  seatIndex,
  minBuyIn,
  maxBuyIn,
  bigBlind,
  bankroll,
  accessToken,
  seated,
  onClose,
}: {
  tableId: string;
  seatIndex: number;
  minBuyIn: number;
  maxBuyIn: number;
  bigBlind: number;
  bankroll: number;
  accessToken: string;
  /** The player holds a seat in the latest snapshot: the claim (this one or any other) succeeded. */
  seated: boolean;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const balanceId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // The parent passes a new onClose on every render (every snapshot); the
  // modal effects below must not re-run (and refocus the field) because of it.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const lo = Math.floor(minBuyIn);
  const hi = Math.floor(Math.min(maxBuyIn, bankroll));
  const affordable = Number.isSafeInteger(lo) && hi >= lo;
  const suggested = Math.min(bigBlind * 100, bankroll, maxBuyIn);
  const [draft, setDraft] = useState(() => String(affordable ? clampChips(suggested, lo, hi) : lo));
  const amount = affordable ? clampChips(parseChipDraft(draft) ?? lo, lo, hi) : lo;
  const balanceAfter = bankroll - amount;

  const [status, setStatus] = useState<"idle" | "pending" | "slow">("idle");
  const [error, setError] = useState<string | null>(null);
  /** The command in flight; a late ack or error for an earlier one is ignored. */
  const commandRef = useRef<string | null>(null);

  // Success: the seat is ours in a verified snapshot.
  useEffect(() => { if (seated) onCloseRef.current(); }, [seated]);

  // Refusals arrive as SERVER_ERROR (the table's id names the request) while
  // the server does not ack SEAT_CLAIM. The listener is attached before the
  // claim is sent (a local server answers faster than React commits an
  // effect) and removed once there is an outcome or the dialog goes away.
  // One naming no table is taken as ours only while a claim is in flight.
  const detachErrorListener = useRef<(() => void) | null>(null);
  const detachError = () => {
    detachErrorListener.current?.();
    detachErrorListener.current = null;
  };
  useEffect(() => () => detachError(), []);

  useEffect(() => {
    if (status !== "pending") return;
    const id = window.setTimeout(() => {
      setStatus((current) => (current === "pending" ? "slow" : current));
      const socket = getSocket(accessToken);
      if (socket.connected) socket.emit(SOCKET_EVENTS.REHYDRATE, { tableId });
    }, SLOW_CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [status, accessToken, tableId]);

  function confirm() {
    if (status !== "idle" || !affordable || !Number.isSafeInteger(amount) || amount < lo || amount > hi) return;
    const socket = getSocket(accessToken);
    if (!socket.connected) {
      setError("Reconnecting to the table. Try again in a moment.");
      return;
    }
    const commandId = crypto.randomUUID();
    commandRef.current = commandId;
    setError(null);
    setStatus("pending");
    detachError();
    const onError = (payload: SocketErrorPayload) => {
      if (commandRef.current !== commandId) return;
      if (payload.tableId !== undefined && payload.tableId !== tableId) return;
      commandRef.current = null;
      detachError();
      setStatus("idle");
      setError(payload.message);
    };
    socket.on(SOCKET_EVENTS.SERVER_ERROR, onError);
    detachErrorListener.current = () => { socket.off(SOCKET_EVENTS.SERVER_ERROR, onError); };
    socket.emit(SOCKET_EVENTS.SEAT_CLAIM, { tableId, seatIndex, buyIn: amount, commandId }, (result: CommandResult) => {
      if (commandRef.current !== commandId) return;
      if (!result.ok) {
        commandRef.current = null;
        detachError();
        setStatus("idle");
        setError(result.message);
      }
      // ok: the seat shows up in the next snapshot, which closes the dialog.
    });
  }

  // Modal behaviour, as IdleCloseDialog: the rest of the page is inert,
  // focus is trapped, and returns where it was on close.
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
    (inputRef.current ?? panelRef.current)?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])"));
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
      if (event.target instanceof Node && !host.contains(event.target)) (inputRef.current ?? panelRef.current)?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      for (const el of inerted) el.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [mounted]);

  if (!mounted) return null;
  const busy = status !== "idle";

  return createPortal(
    <div ref={hostRef} className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="my-auto w-full max-w-md rounded-2xl border border-amber-200/30 bg-[#0b2a20] p-5 text-emerald-50 shadow-[0_24px_80px_rgba(0,0,0,0.7)] outline-none sm:p-6"
      >
        <h2 id={titleId} className="font-[family-name:var(--font-display)] text-2xl">Buy in for seat {seatIndex + 1}</h2>
        <p id={descriptionId} className="mt-2 text-sm text-emerald-50">
          Choose how many chips to bring to the table: {formatChipsWithUnit(lo)} to {formatChipsWithUnit(Math.floor(maxBuyIn))}.
          {" "}Your bankroll is {formatChipsWithUnit(bankroll)}.
        </p>
        <form
          className="mt-5"
          onSubmit={(event) => { event.preventDefault(); confirm(); }}
        >
          <div className="flex items-center justify-between gap-3 text-sm">
            <label htmlFor={`${titleId}-amount`} className="font-medium">Buy-in</label>
            <input
              ref={inputRef}
              id={`${titleId}-amount`}
              type="number"
              inputMode="numeric"
              step={1}
              min={lo}
              max={affordable ? hi : lo}
              value={draft}
              disabled={!affordable || busy}
              aria-describedby={balanceId}
              onChange={(event) => { setDraft(normaliseChipDraft(event.target.value)); setError(null); }}
              onBlur={() => setDraft(String(amount))}
              className="w-32 rounded-lg border border-white/30 bg-emerald-950 px-3 py-1.5 text-right text-white disabled:opacity-60"
            />
          </div>
          <input
            type="range"
            aria-label="Buy-in slider"
            min={lo}
            max={affordable ? hi : lo}
            step={1}
            value={amount}
            disabled={!affordable || busy}
            onChange={(event) => { setDraft(String(clampChips(Number(event.target.value), lo, affordable ? hi : lo))); setError(null); }}
            className="mt-3 h-9 w-full accent-amber-300"
          />
          <p id={balanceId} className="mt-3 flex items-baseline justify-between rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-sm" data-testid="buy-in-balance">
            <span>Bankroll after buy-in</span>
            <span className="font-semibold tabular-nums text-emerald-100">{formatChipsWithUnit(balanceAfter)}</span>
          </p>
          {!affordable ? (
            <p role="alert" className="mt-3 rounded-xl border border-red-400/40 bg-red-950/60 px-3 py-2 text-sm text-red-100">
              You need at least {formatChipsWithUnit(lo)} to sit here.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 rounded-xl border border-red-400/40 bg-red-950/60 px-3 py-2 text-sm text-red-100">{error}</p>
          ) : null}
          <p role="status" className="mt-3 min-h-5 text-sm text-amber-100">
            {status === "pending" ? "Taking your seat…" : status === "slow" ? "Still waiting for the table to confirm your seat…" : ""}
          </p>
          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose}
              className="min-h-11 rounded-full border border-white/30 px-5 py-2 text-white transition hover:bg-white/10">
              Cancel
            </button>
            <button type="submit" disabled={!affordable || busy}
              className="min-h-11 rounded-full bg-amber-300 px-6 py-2 font-semibold text-emerald-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60">
              {busy ? "Taking seat…" : "Confirm buy-in"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
