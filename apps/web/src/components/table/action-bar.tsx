"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SOCKET_EVENTS, type ActionType, type LegalActionSet } from "@poker/shared";
import { formatChips, formatChipsWithUnit } from "@/lib/format";
import { getSocket } from "@/lib/socket";
import { playSound } from "@/lib/sounds";
import { useTableStore } from "@/stores/session";
import { clampChips, normaliseChipDraft, parseChipDraft } from "./chip-amount";
import { FOCUS_ACTIONS_KEY, readBooleanPreference } from "./preferences";
import { formatClock, useTurnClock, type TurnClockInput } from "./turn-clock";

/** Sound is decoration: it is played after the action is on the wire and can never stop the action. */
function playSoundSafely(kind: Parameters<typeof playSound>[0]): void {
  try {
    playSound(kind);
  } catch {
    // playSound already swallows its own failures; this guards a future change to it.
  }
}

export function ActionBar({
  tableId,
  revision,
  turnId = null,
  accessToken,
  legal,
  stack,
  pot,
  currentBet,
  clock = null,
  disconnected = false,
}: {
  tableId: string;
  revision: number;
  /** PublicTableState.turnId when the server sends it; the action is refused only if that turn is over. */
  turnId?: string | null;
  accessToken: string;
  legal: LegalActionSet;
  stack: number;
  pot: number;
  currentBet: number;
  /** The hero's turn clock, anchored to snapshot arrival. */
  clock?: TurnClockInput | null;
  disconnected?: boolean;
}) {
  const max = Math.floor(legal.maxRaiseTo);
  const min = Math.min(max, Math.floor(legal.actions.includes("BET") ? legal.minBet : legal.minRaiseTo));
  // One integer amount model (chip-amount.ts): the field keeps what was typed,
  // the amount is always a finite integer in [min, max], and the button label
  // shows exactly the amount that is sent.
  const [draft, setDraft] = useState(() => String(min));
  const [pending, setPending] = useState(false);
  const lastMin = useRef(min);
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const turn = useTurnClock(clock);

  useEffect(() => {
    if (lastMin.current !== min) {
      lastMin.current = min;
      setDraft(String(min));
    }
  }, [min]);
  const amount = clampChips(parseChipDraft(draft) ?? min, min, max);

  // "Focus actions on my turn" (a per-device preference, see TableControls):
  // when this player's turn starts, keyboard focus moves to the first action.
  useEffect(() => {
    if (!readBooleanPreference(FOCUS_ACTIONS_KEY, false)) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>("button[data-action]:not([disabled])");
    first?.focus({ preventScroll: true });
  }, [turnId]);

  const shortcuts = useMemo(() => {
    const potish = (frac: number) => clampChips(currentBet + Math.floor((pot + legal.callAmount) * frac), min, max);
    return [
      { label: "Min", value: min },
      { label: "1/2", value: potish(0.5) },
      { label: "3/4", value: potish(0.75) },
      { label: "Pot", value: potish(1) },
      { label: "All-in", value: max },
    ];
  }, [min, max, pot, currentBet, legal.callAmount]);

  async function send(action: ActionType, value?: number) {
    if (inFlight.current || disconnected) return;
    const socket = getSocket(accessToken);
    if (!socket.connected) return;
    if (value !== undefined && !Number.isSafeInteger(value)) return;
    inFlight.current = true;
    setPending(true);
    // Everything after the flag is inside the try, so the buttons are always
    // released (finally), whatever throws. The action goes on the wire first;
    // sound follows, best-effort, and can never block or delay it.
    try {
      useTableStore.getState().setTableError(null);
      const reply = socket.timeout(10_000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, {
        tableId, revision, action, amount: value, clientActionId: crypto.randomUUID(), ...(turnId ? { turnId } : {}),
      });
      playSoundSafely(action === "FOLD" ? "turn" : "chip");
      const result = await reply;
      if (!result.ok) useTableStore.getState().setTableError(result.message);
    } catch {
      if (useTableStore.getState().snapshot?.tableId === tableId && useTableStore.getState().snapshot?.revision === revision) {
        useTableStore.getState().setTableError("Action confirmation timed out. Checking the table before you retry.");
        if (socket.connected) socket.emit(SOCKET_EVENTS.REHYDRATE, { tableId });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const callLabel =
    legal.callAmount === 0 ? "Check" : legal.callAmount >= stack ? `All-in ${formatChips(stack)}` : `Call ${formatChips(legal.callAmount)}`;
  const canSize = legal.actions.includes("BET") || legal.actions.includes("RAISE");
  const bank = turn?.phase === "timebank";

  return (
    <div ref={rootRef} className="rounded-2xl border border-amber-200/20 bg-black/70 p-4 backdrop-blur" aria-label="Your poker actions" role="group">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-50">
        <span className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-widest text-amber-200">Your turn</span>
          {turn ? (
            <span data-testid="turn-countdown" data-phase={turn.phase}
              className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${
                bank ? "bg-sky-950 text-sky-100" : turn.seconds <= 5 ? "bg-red-950 text-red-100" : "bg-emerald-950 text-amber-100"}`}>
              {bank ? `Time bank ${formatClock(turn.phaseSeconds)}` : `${formatClock(turn.phaseSeconds)} left`}
              {turn.phase === "base" && turn.bankAfterMs > 0 ? ` (+${formatClock(Math.ceil(turn.bankAfterMs / 1000))} bank)` : ""}
            </span>
          ) : null}
        </span>
        <span>{disconnected ? "Reconnecting…" : legal.callAmount > 0 ? `${formatChipsWithUnit(legal.callAmount)} to call` : "You can check for free"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {/*
          Colours are chosen for WCAG 2.2 AA (at least 4.5:1 for the label in
          every enabled state, hover included); the browser test measures them.
        */}
        {legal.actions.includes("FOLD") ? (
          <button
            type="button"
            data-action="FOLD"
            disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-zinc-700 px-5 py-2 font-semibold text-white transition hover:bg-zinc-600 disabled:opacity-50"
            onClick={() => void send("FOLD")}
          >
            Fold
          </button>
        ) : null}
        {legal.actions.includes("CHECK") ? (
          <button type="button" data-action="CHECK" disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-emerald-700 px-5 py-2 font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-50"
            onClick={() => void send("CHECK")}>
            Check
          </button>
        ) : null}
        {legal.actions.includes("CALL") ? (
          <button type="button" data-action="CALL" disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-emerald-800 px-5 py-2 font-semibold text-white transition hover:bg-emerald-900 disabled:opacity-50"
            onClick={() => void send("CALL")}>
            {callLabel}
          </button>
        ) : null}
        {canSize ? (
          <button
            type="button"
            data-action={legal.actions.includes("BET") ? "BET" : "RAISE"}
            disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-amber-300 px-5 py-2 font-semibold text-emerald-950 transition hover:bg-amber-200 disabled:opacity-50"
            onClick={() => void send(legal.actions.includes("BET") ? "BET" : "RAISE", amount)}
          >
            {legal.actions.includes("BET") ? "Bet" : "Raise to"} {formatChips(amount)}
          </button>
        ) : null}
        {legal.actions.includes("ALL_IN") ? (
          <button type="button" data-action="ALL_IN" disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-red-700 px-5 py-2 font-semibold text-white transition hover:bg-red-800 disabled:opacity-50"
            onClick={() => void send("ALL_IN")}>
            All-in {formatChips(stack)}
          </button>
        ) : null}
      </div>
      {canSize ? (
        <div className="mt-4 border-t border-white/10 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <label htmlFor="bet-amount">{legal.actions.includes("BET") ? "Bet amount" : "Raise to"}</label>
            <input id="bet-amount" type="number" inputMode="numeric" step={1} min={min} max={max} value={draft}
              onChange={(e) => setDraft(normaliseChipDraft(e.target.value))}
              onBlur={() => setDraft(String(amount))}
              className="w-28 rounded-lg border border-white/30 bg-emerald-950 px-3 py-1.5 text-right text-white" />
          </div>
          <input
            type="range"
            aria-label="Bet amount slider"
            min={min}
            max={max}
            step={1}
            value={amount}
            onChange={(e) => setDraft(String(clampChips(Number(e.target.value), min, max)))}
            className="h-9 w-full accent-amber-300"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {shortcuts.map((s) => (
              <button
                key={s.label}
                type="button"
                className="min-h-9 rounded-full border border-white/30 px-3 py-1 text-xs text-white transition hover:border-amber-200/70"
                onClick={() => setDraft(String(s.value))}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
