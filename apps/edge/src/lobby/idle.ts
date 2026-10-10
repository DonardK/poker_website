import type { TableIdleNoticePayload, UserPatchPayload } from "@poker/shared";

export interface StoredIdleNotice {
  table_id: string;
  table_name: string;
  closing_at: number;
}

/** Absolute deadline from a notice, so AUTH_OK can recompute closingInMs later. */
export function rememberDeadline(notice: TableIdleNoticePayload, now: number): { tableId: string; tableName: string; closingAt: number } | null {
  if (notice.closingInMs === null) return null;
  const closingInMs = Number.isFinite(notice.closingInMs) ? Math.max(0, notice.closingInMs) : 0;
  return { tableId: notice.tableId, tableName: notice.tableName, closingAt: now + closingInMs };
}

export function idleNoticeFor(
  row: StoredIdleNotice | undefined,
  activeTableId: string | null,
  now: number,
): TableIdleNoticePayload | null {
  if (!row || !activeTableId || row.table_id !== activeTableId) return null;
  const closingAt = Number(row.closing_at);
  if (!(closingAt > now)) return null;
  return { tableId: row.table_id, tableName: row.table_name, closingInMs: Math.max(0, closingAt - now) };
}

export function parseIdleNotice(payload: unknown): TableIdleNoticePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.tableId !== "string" || row.tableId.length < 1 || row.tableId.length > 128) return null;
  if (typeof row.tableName !== "string" || row.tableName.length < 1 || row.tableName.length > 80) return null;
  if (row.closingInMs !== null && (typeof row.closingInMs !== "number" || !Number.isFinite(row.closingInMs))) return null;
  return { tableId: row.tableId, tableName: row.tableName, closingInMs: row.closingInMs };
}

/** Forward the wallet object. Refuse anything that is not a plain object with a numeric bankroll. */
export function parseUserPatch(payload: unknown): UserPatchPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.bankroll !== "number" || !Number.isFinite(row.bankroll)) return null;
  return payload as UserPatchPayload;
}
