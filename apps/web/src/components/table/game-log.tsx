"use client";

import { useEffect, useRef } from "react";
import type { HandHistoryLogEntry } from "@poker/shared";

export function GameLog({ entries }: { entries: HandHistoryLogEntry[] }) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <aside className="flex h-72 flex-col rounded-2xl border border-white/10 bg-black/40 p-3 text-sm">
      <h2 className="mb-2 text-xs uppercase tracking-[0.2em] text-amber-200/70">Hand log</h2>
      <div ref={scroller} className="flex-1 space-y-1 overflow-y-auto pr-1">
        {entries.length === 0 ? (
          <p className="text-emerald-100/50">Waiting for cards…</p>
        ) : (
          entries.map((e) => (
            <p key={`${e.seq}-${e.at}`} className="text-emerald-100/80">
              <span className="text-amber-100/70">{e.username}</span> {e.text.replace(`${e.username} `, "")}
            </p>
          ))
        )}
      </div>
    </aside>
  );
}
