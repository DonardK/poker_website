"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SOCKET_EVENTS, type ActionType, type LegalActionSet } from "@poker/shared";
import { getSocket } from "@/lib/socket";
import { playSound } from "@/lib/sounds";

export function ActionBar({
  tableId,
  accessToken,
  legal,
  stack,
  pot,
}: {
  tableId: string;
  accessToken: string;
  legal: LegalActionSet;
  stack: number;
  pot: number;
}) {
  const min = legal.actions.includes("BET") ? legal.minBet : legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const [amount, setAmount] = useState(min);
  const lastMin = useRef(min);

  useEffect(() => {
    if (lastMin.current !== min) {
      lastMin.current = min;
      setAmount(min);
    }
  }, [min]);

  const clamped = Math.max(min, Math.min(max, amount));

  const shortcuts = useMemo(() => {
    const potish = (frac: number) => Math.max(min, Math.min(max, Math.floor(pot * frac) || min));
    return [
      { label: "Min", value: min },
      { label: "1/2", value: potish(0.5) },
      { label: "3/4", value: potish(0.75) },
      { label: "Pot", value: potish(1) },
      { label: "All-in", value: max },
    ];
  }, [min, max, pot]);

  function send(action: ActionType, value?: number) {
    playSound(action === "FOLD" ? "turn" : "chip");
    getSocket(accessToken).emit(SOCKET_EVENTS.ACTION_INTENT, {
      tableId,
      action,
      amount: value,
      clientActionId: crypto.randomUUID(),
    });
  }

  const callLabel =
    legal.callAmount === 0 ? "Check" : legal.callAmount >= stack ? `All-in $${stack}` : `Call $${legal.callAmount}`;

  return (
    <div className="rounded-2xl border border-amber-200/20 bg-black/60 p-4 backdrop-blur">
      <div className="flex flex-wrap gap-2">
        {legal.actions.includes("FOLD") ? (
          <button
            type="button"
            className="rounded-full bg-zinc-700 px-5 py-2 font-semibold"
            onClick={() => send("FOLD")}
          >
            Fold
          </button>
        ) : null}
        {legal.actions.includes("CHECK") ? (
          <button className="rounded-full bg-emerald-700 px-5 py-2 font-semibold" onClick={() => send("CHECK")}>
            Check
          </button>
        ) : null}
        {legal.actions.includes("CALL") ? (
          <button className="rounded-full bg-emerald-600 px-5 py-2 font-semibold" onClick={() => send("CALL")}>
            {callLabel}
          </button>
        ) : null}
        {legal.actions.includes("BET") || legal.actions.includes("RAISE") ? (
          <button
            className="rounded-full bg-amber-300 px-5 py-2 font-semibold text-emerald-950"
            onClick={() => send(legal.actions.includes("BET") ? "BET" : "RAISE", clamped)}
          >
            {legal.actions.includes("BET") ? "Bet" : "Raise to"} ${clamped}
          </button>
        ) : null}
        {legal.actions.includes("ALL_IN") ? (
          <button className="rounded-full bg-red-700 px-5 py-2 font-semibold" onClick={() => send("ALL_IN")}>
            All-in ${stack}
          </button>
        ) : null}
      </div>
      {legal.actions.includes("BET") || legal.actions.includes("RAISE") ? (
        <div className="mt-3">
          <input
            type="range"
            min={min}
            max={max}
            value={clamped}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-full accent-amber-300"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {shortcuts.map((s) => (
              <button
                key={s.label}
                className="rounded-full border border-white/15 px-3 py-1 text-xs"
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
