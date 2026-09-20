import { kv, redisKeys } from "./client.js";

/** Ephemeral engine snapshots. Schema is owned by the Phase 3 state machine. */
export async function getRawTableState(tableId: string): Promise<string | null> {
  return kv.get(redisKeys.tableState(tableId));
}

export async function setRawTableState(tableId: string, json: string): Promise<void> {
  await kv.set(redisKeys.tableState(tableId), json);
}

export async function getActiveTableForUser(userId: string): Promise<string | null> {
  return kv.get(redisKeys.userActiveTable(userId));
}

export async function setActiveTableForUser(userId: string, tableId: string | null): Promise<void> {
  const key = redisKeys.userActiveTable(userId);
  if (tableId) await kv.set(key, tableId);
  else await kv.del(key);
}
