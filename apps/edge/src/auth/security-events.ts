import type { SecurityEventType } from "@poker/shared";
import type { AppDb } from "../http/db";
import { normalizeCountry } from "./devices";
import { coarseIp } from "./ip";

/**
 * Append-only account security history (AccountSecurityEvent; a trigger
 * refuses UPDATE and DELETE). Call it with the transaction client of the
 * change it describes, so the event exists exactly when the change does.
 *
 * Stores the coarse network only, the user agent cut to 256 characters, and
 * small facts in `data`. Never a token, code, password, link, email body or
 * full IP address.
 */

export interface RequestFacts {
  ip: string | null;
  userAgent: string | null;
  country: string | null;
}

export interface SecurityEventInput {
  userId: string;
  type: SecurityEventType;
  sessionId?: string | null;
  facts?: RequestFacts | null;
  data?: Record<string, unknown>;
}

export async function recordSecurityEvent(db: AppDb, input: SecurityEventInput): Promise<void> {
  await db.accountSecurityEvent.create({
    data: {
      userId: input.userId,
      type: input.type,
      sessionId: input.sessionId ?? null,
      ip: coarseIp(input.facts?.ip),
      userAgent: input.facts?.userAgent ? input.facts.userAgent.slice(0, 256) : null,
      country: normalizeCountry(input.facts?.country),
      data: input.data ?? {},
    },
  });
}
