"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SOCKET_EVENTS, type ActionType, type LegalActionSet } from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { playSound } from "@/lib/sounds";
import { useTableStore } from "@/stores/session";

export function ActionBar({
  tableId,
  revision,
  accessToken,
  legal,
  stack,
  pot,
  currentBet,
  disconnected = false,
}: {
  tableId: string;
  revision: number;
  accessToken: string;
  legal: LegalActionSet;
  stack: number;
  pot: number;
  currentBet: number;
  disconnected?: boolean;
}) {
  const max = legal.maxRaiseTo;
  const min = Math.min(max, legal.actions.includes("BET") ? legal.minBet : legal.minRaiseTo);
  const [amount, setAmount] = useState(min);
  const [pending, setPending] = useState(false);
  const lastMin = useRef(min);
  const inFlight = useRef(false);

  useEffect(() => {
    if (lastMin.current !== min) {
      lastMin.current = min;
      setAmount(min);
    }
  }, [min]);
  const clamped = Math.max(min, Math.min(max, amount));

  const shortcuts = useMemo(() => {
    const potish = (frac: number) => Math.max(min, Math.min(max, currentBet + Math.floor((pot + legal.callAmount) * frac)));
    return [
      { label: "Min", value: min },
      { label: "1/2", value: potish(0.5) },
      { label: "3/4", value: potish(0.75) },
      { label: "Pot", value: potish(1) },
      { label: "All-in", value: max },
    ];
  }, [min, max, pot, currentBet, legal.callAmount]);

  async function send(action: ActionType, value?: number) {
    const socket = getSocket(accessToken);
    if (inFlight.current || disconnected || !socket.connected) return;
    inFlight.current = true;
    setPending(true);
    useTableStore.getState().setTableError(null);
    playSound(action === "FOLD" ? "turn" : "chip");
    try {
      const reply = await socket.timeout(10_000).emitWithAck(SOCKET_EVENTS.ACTION_INTENT, {
        tableId, revision, action, amount: value, clientActionId: crypto.randomUUID(),
      });
      if (!reply.ok) useTableStore.getState().setTableError(reply.message);
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
    legal.callAmount === 0 ? "Check" : legal.callAmount >= stack ? `All-in $${stack}` : `Call $${legal.callAmount}`;

  return (
    <div className="rounded-2xl border border-amber-200/20 bg-black/60 p-4 backdrop-blur" aria-label="Your poker actions">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-100/70">
        <span className="font-semibold uppercase tracking-widest text-amber-200">Your turn</span>
        <span>{disconnected ? "Reconnecting…" : legal.callAmount > 0 ? `$${legal.callAmount.toLocaleString()} to call` : "You can check for free"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {legal.actions.includes("FOLD") ? (
          <button
            type="button"
            disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-zinc-700 px-5 py-2 font-semibold transition hover:bg-zinc-600 disabled:opacity-50"
            onClick={() => send("FOLD")}
          >
            Fold
          </button>
        ) : null}
        {legal.actions.includes("CHECK") ? (
          <button disabled={pending || disconnected} className="min-h-11 rounded-xl bg-emerald-700 px-5 py-2 font-semibold transition hover:bg-emerald-600 disabled:opacity-50" onClick={() => send("CHECK")}>
            Check
          </button>
        ) : null}
        {legal.actions.includes("CALL") ? (
          <button disabled={pending || disconnected} className="min-h-11 rounded-xl bg-emerald-600 px-5 py-2 font-semibold transition hover:bg-emerald-500 disabled:opacity-50" onClick={() => send("CALL")}>
            {callLabel}
          </button>
        ) : null}
        {legal.actions.includes("BET") || legal.actions.includes("RAISE") ? (
          <button
            disabled={pending || disconnected}
            className="min-h-11 rounded-xl bg-amber-300 px-5 py-2 font-semibold text-emerald-950 transition hover:bg-amber-200 disabled:opacity-50"
            onClick={() => send(legal.actions.includes("BET") ? "BET" : "RAISE", clamped)}
          >
            {legal.actions.includes("BET") ? "Bet" : "Raise to"} ${clamped}
          </button>
        ) : null}
        {legal.actions.includes("ALL_IN") ? (
          <button disabled={pending || disconnected} className="min-h-11 rounded-xl bg-red-700 px-5 py-2 font-semibold transition hover:bg-red-600 disabled:opacity-50" onClick={() => send("ALL_IN")}>
            All-in ${stack}
          </button>
        ) : null}
      </div>
      {legal.actions.includes("BET") || legal.actions.includes("RAISE") ? (
        <div className="mt-4 border-t border-white/10 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <label htmlFor="bet-amount">{legal.actions.includes("BET") ? "Bet amount" : "Raise to"}</label>
            <input id="bet-amount" type="number" inputMode="numeric" min={min} max={max} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              onBlur={() => setAmount(clamped)}
              className="w-28 rounded-lg border border-white/20 bg-emerald-950/70 px-3 py-1.5 text-right text-white" />
          </div>
          <input
            type="range"
            aria-label="Bet amount slider"
            min={min}
            max={max}
            value={clamped}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="h-9 w-full accent-amber-300"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {shortcuts.map((s) => (
              <button
                key={s.label}
                type="button"
                className="min-h-9 rounded-full border border-white/20 px-3 py-1 text-xs transition hover:border-amber-200/70"
                onClick={() => setAmount(s.value)}
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
