"use client";

import { useEffect, useRef } from "react";
import type { PublicTableState } from "@poker/shared";
import { installAudioUnlock, playSound } from "@/lib/sounds";

export function useTableFx(snapshot: PublicTableState | null, heroUserId: string | null) {
  const prev = useRef<PublicTableState | null>(null);

  // Browsers keep audio suspended until a gesture (and suspend it again after
  // interruptions); every tap or key press on the table page resumes it.
  useEffect(() => installAudioUnlock(), []);

  useEffect(() => {
    if (!snapshot) return;
    const last = prev.current;
    prev.current = snapshot;
    if (!last || last.tableId !== snapshot.tableId) return;

    if (snapshot.handNumber !== last.handNumber && snapshot.phase === "PREFLOP") {
      playSound("deal");
    } else if (snapshot.board.length > last.board.length) {
      playSound("deal");
    }

    if (snapshot.winners.length > 0 && last.winners.length === 0) {
      playSound("win");
    }

    if (snapshot.toActSeat != null && snapshot.toActSeat !== last.toActSeat) {
      const actor = snapshot.players.find((p) => p.seatIndex === snapshot.toActSeat);
      if (actor?.userId === heroUserId) playSound("turn");
    }
  }, [snapshot, heroUserId]);
}
