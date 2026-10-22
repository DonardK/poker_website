"use client";

import { ChipIcon } from "@/components/ui/icons";
import { formatChipsWithUnit } from "@/lib/format";
import { useAuthStore } from "@/stores/session";

/**
 * The play-chip balance in the header: the only element on lobby pages whose
 * text is exactly "N chips" (browser tests read it). Chips are never shown
 * with a currency sign (decision D5).
 */
export function BalancePill() {
  const bankroll = useAuthStore((s) => s.user?.bankroll ?? null);
  if (bankroll === null) return null;
  return (
    <p className="flex min-h-10 items-center gap-2 rounded-full border border-amber-200/30 bg-black/30 px-3 text-sm font-semibold text-amber-100"
      title="Play-chip balance (no cash value)">
      <ChipIcon className="h-4 w-4" />
      <span className="sr-only">Play-chip balance: </span>
      <span data-testid="balance">{formatChipsWithUnit(bankroll)}</span>
    </p>
  );
}
