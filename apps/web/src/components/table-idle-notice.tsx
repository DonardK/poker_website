"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { IdleWarningPanel } from "@/components/table/idle-close-dialog";
import { useAuthStore } from "@/stores/session";

/**
 * How long past its deadline an unanswered warning is kept when neither its
 * end nor the table's cash-out arrives (both missed while reconnecting).
 */
const DROP_AFTER_DEADLINE_MS = 30_000;

/**
 * The idle-closing warning of the table this player is seated at, on every
 * page except that table's own (which shows it from its snapshot). A player
 * who went to the lobby keeping their seat can keep the table open from here,
 * or go back to it. The warning clears when it ends (TABLE_IDLE_NOTICE with
 * no countdown), when the player is cashed out of that table (it closed, or
 * they left), when "I'm still here" is confirmed, and as a fallback 30 s
 * after the deadline.
 */
export function TableIdleNotice() {
  const notice = useAuthStore((s) => s.tableIdleNotice);
  const accessToken = useAuthStore((s) => s.accessToken);
  const leavingTableId = useAuthStore((s) => s.leavingTableId);
  const pathname = usePathname();

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => useAuthStore.getState().clearTableIdleNotice(notice.tableId),
      Math.max(0, notice.deadline + DROP_AFTER_DEADLINE_MS - performance.now()));
    return () => window.clearTimeout(id);
  }, [notice]);

  if (!notice || !accessToken) return null;
  // That table's page shows the same warning itself.
  if (tableIdFromPath(pathname) === notice.tableId) return null;
  // Leaving after this hand: a leaving player cannot keep the table open (the server refuses).
  if (leavingTableId === notice.tableId) return null;
  const { tableId } = notice;
  return (
    <IdleWarningPanel
      key={tableId}
      tableId={tableId}
      tableName={notice.tableName}
      accessToken={accessToken}
      deadline={notice.deadline}
      canKeepOpen
      goToTableHref={`/table/${encodeURIComponent(tableId)}`}
      onKeptOpen={() => useAuthStore.getState().clearTableIdleNotice(tableId)}
    />
  );
}

function tableIdFromPath(pathname: string | null): string | null {
  const match = /^\/table\/([^/]+)\/?$/.exec(pathname ?? "");
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
