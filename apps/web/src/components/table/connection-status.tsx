"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * The connection states the table socket hook reports (useTableStore
 * .socketStatus) in which the table is live and commands may be sent. The
 * hook is owned elsewhere and its wording may change, so every spelling of
 * "the cards matched the commitment" is accepted here.
 */
const COMMITMENT_STATUSES = new Set(["cards verified", "cards match commitment", "cards-match-commitment", "commitment verified", "commitment match"]);

export function isCommitmentStatus(status: string): boolean {
  return COMMITMENT_STATUSES.has(status.trim().toLowerCase());
}

/** The table is connected and its latest snapshot passed the browser's checks. */
export function isLiveStatus(status: string): boolean {
  return status === "live" || isCommitmentStatus(status);
}

export function statusLabel(status: string): string {
  if (status === "live") return "Live";
  if (isCommitmentStatus(status)) return "Cards match commitment";
  if (status === "verification failed") return "Card check failed";
  if (status === "disconnected") return "Reconnecting";
  if (status === "connected" || status === "authenticated") return "Connecting";
  if (status === "closed") return "Closed";
  if (status === "error") return "Error";
  return status;
}

/**
 * COMPLIANCE NOTE: the header must not overstate what the browser checked.
 * It verified that the cards it was shown (its own hole cards, the board,
 * hands tabled at showdown) open the server's pre-deal commitment for this
 * hand. That proves the server did not change those cards after committing;
 * it does not prove the shuffle was random or certify the game as fair, so
 * the label says "match commitment", never "verified" or "fair", and the
 * info popover says so in plain words.
 */
export function ConnectionStatus({ status, closed = false }: { status: string; closed?: boolean }) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const commitment = !closed && isCommitmentStatus(status);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  useEffect(() => { if (!commitment) setOpen(false); }, [commitment]);

  if (!commitment) return <span data-testid="table-status">{closed ? "Closed" : statusLabel(status)}</span>;
  return (
    <span ref={wrapRef} className="relative inline-flex items-center gap-1">
      <span data-testid="table-status">Cards match commitment</span>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label="About the card check"
        onClick={() => setOpen((value) => !value)}
        className="inline-grid h-6 w-6 place-items-center rounded-full border border-amber-200/60 text-xs font-semibold text-amber-100 hover:bg-white/10"
      >
        <span aria-hidden="true">i</span>
      </button>
      {open ? (
        <span
          id={popoverId}
          role="note"
          className="absolute left-0 top-full z-30 mt-2 block w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-amber-200/30 bg-emerald-950 p-3 text-xs leading-relaxed text-emerald-50 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
        >
          This browser checked that the cards it can see match the commitment the server published before the deal.
          It is a consistency check, not a fairness certification: it shows those cards were not changed after the
          commitment, not that the shuffle was random.
        </span>
      ) : null}
    </span>
  );
}
