/**
 * The only way the server turns engine state into a client payload.
 *
 * COMPLIANCE NOTE (state isolation and leakage prevention): every emitted
 * snapshot goes through `projectTableState`: the engine's per-viewer
 * allow-list projection followed by its fail-closed leak guard. If the guard
 * refuses (LEAK_BLOCKED), `guardedTableState` reports a security event and
 * returns null, and the caller emits nothing to that socket.
 */
import { EngineError, projectTableState, type EngineTable } from "@poker/engine";
import type { PublicTableState } from "@poker/shared";

export { projectTableState as maskTableState };

export interface LeakBlockedEvent {
  tableId: string;
  revision: number;
  handNumber: number;
  phase: EngineTable["phase"];
  viewerUserId: string | null;
  reason: string;
}

/** Guarded per-viewer projection; null means "do not emit" (fail closed). Other errors propagate. */
export function guardedTableState(table: EngineTable, viewerUserId: string | null, onLeakBlocked: (event: LeakBlockedEvent) => void): PublicTableState | null {
  try {
    return projectTableState(table, viewerUserId);
  } catch (err) {
    if (!(err instanceof EngineError && err.code === "LEAK_BLOCKED")) throw err;
    // The guard's reason names seats, positions and paths, never card values.
    onLeakBlocked({ tableId: table.tableId, revision: table.revision, handNumber: table.handNumber, phase: table.phase, viewerUserId, reason: err.message });
    return null;
  }
}
