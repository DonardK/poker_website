import type { SessionEndReason } from "@poker/shared";
import type { Env } from "../env";
import type { TableActorRpc, UserSessionsRpc } from "../session/contract";
import { errBrief, logError, logWarn } from "./log";

const HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]);

/** Arms the table idle alarm. A failure leaves the committed row in place. */
export async function trackNewTable(env: Env, tableId: string): Promise<void> {
  try {
    const hint = env.TABLE_DO_LOCATION_HINT;
    const stub = HINTS.has(hint)
      ? env.TABLES.getByName(tableId, { locationHint: hint as DurableObjectLocationHint })
      : env.TABLES.getByName(tableId);
    await (stub as unknown as TableActorRpc).track();
  } catch (err) {
    logError({ ...errBrief(err), tableId }, "could not start the new table's timers");
  }
}

/** Best-effort. The next mutating frame re-reads the session row if this RPC fails. */
export async function fanoutRevoke(env: Env, userId: string, sessionIds: readonly string[], reason: SessionEndReason): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const stub = env.USER_SESSIONS.getByName(userId) as unknown as UserSessionsRpc;
    for (const sessionId of sessionIds) await stub.revoke({ sessionId, reason });
  } catch (err) {
    logWarn({ ...errBrief(err), userId, reason }, "UserSessions.revoke failed after the session row was revoked");
  }
}
