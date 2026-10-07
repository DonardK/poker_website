/**
 * Stored table state written by an earlier engine version.
 *
 * COMPLIANCE NOTE (legacy state): TableManager.load() passes every decrypted
 * table state through `upgradeStoredTableState` before anything reads it, so
 * snapshots, timers and mutations only ever see the current state model. The
 * engine's `upgradeTableState` is deterministic and idempotent: it drops the
 * retired pre-deal seed round, purges a previous hand's leftover cards and
 * commitments, runs Hand Clean-up for a settled legacy hand, and VOIDS a
 * legacy hand still in progress (it has no pre-deal commitment or audit trail,
 * so it can never be verified): every bet is returned and players who were
 * leaving are cashed out. A voided hand is reported once per table and hand
 * number per process.
 *
 * A state saved before the idle clock existed gets `lastActivityAt` from the
 * caller's fallback (TableManager passes the row's last update), so a table
 * abandoned long ago is not granted a fresh five minutes by every load; a
 * seated player saved without a clock of their own gets the table's. Either
 * way it reports `upgraded`, so the defaults are stored by the next mutation.
 * (After a restart TableManager still times every table from the moment it
 * resumed: downtime is not inactivity.)
 *
 * Loading never writes. `upgraded` tells TableManager.mutate() to persist the
 * upgraded state even when the mutation itself changes nothing. The cash-outs
 * it produced are then paid in that same transaction, which also stores the
 * state with no pending cash-outs. Until that commit the stored state is
 * unchanged, so every load re-derives the same upgrade and the same cash-outs,
 * and they are paid exactly once.
 *
 * This module imports no configuration or database, so it can be tested
 * directly.
 */
import { upgradeTableState, type EngineTable } from "@poker/engine";

export interface VoidedHandEvent {
  tableId: string;
  handNumber: number;
}

const reportedVoids = new Set<string>();

/**
 * Upgrade one decrypted table state (the object is modified in place and must
 * not be used afterwards). `upgraded` is true when the result differs from
 * what is stored. `fallbackActivityAt` (ms epoch) starts a legacy state's
 * idle clock; without it the engine uses now.
 */
export function upgradeStoredTableState(tableId: string, stored: EngineTable, onVoided: (event: VoidedHandEvent) => void, options: { fallbackActivityAt?: number } = {}): { table: EngineTable; upgraded: boolean } {
  const before = JSON.stringify(stored);
  const { table, voidedHand } = upgradeTableState(stored, options);
  if (voidedHand !== null) {
    const key = JSON.stringify([tableId, voidedHand]);
    if (!reportedVoids.has(key)) {
      reportedVoids.add(key);
      onVoided({ tableId, handNumber: voidedHand });
    }
  }
  return { table, upgraded: JSON.stringify(table) !== before };
}
