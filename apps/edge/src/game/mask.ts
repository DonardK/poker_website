/**
 * The only way the edge runtime turns engine state into a client payload.
 * Same contract as apps/server/src/socket/mask.ts: projectTableState, and on
 * LEAK_BLOCKED send nothing to that viewer.
 */
import { EngineError, projectTableState, type EngineTable } from "@poker/engine";
import type { PublicTableState } from "@poker/shared";

export interface LeakBlockedEvent {
  tableId: string;
  revision: number;
  handNumber: number;
  phase: EngineTable["phase"];
  viewerUserId: string | null;
  reason: string;
}

/** Guarded per-viewer projection. Null means do not emit. Other errors propagate. */
export function guardedTableState(
  table: EngineTable,
  viewerUserId: string | null,
  onLeakBlocked: (event: LeakBlockedEvent) => void,
): PublicTableState | null {
  try {
    return projectTableState(table, viewerUserId);
  } catch (err) {
    if (!(err instanceof EngineError && err.code === "LEAK_BLOCKED")) throw err;
    onLeakBlocked({
      tableId: table.tableId,
      revision: table.revision,
      handNumber: table.handNumber,
      phase: table.phase,
      viewerUserId,
      reason: err.message,
    });
    return null;
  }
}
