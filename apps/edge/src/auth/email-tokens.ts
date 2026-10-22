import type { AppDb } from "../http/db";
import { randomToken, sha256Hex } from "./bytes";

/**
 * Email link tokens: 32 random bytes (43 base64url characters) in the URL
 * fragment of the link, so they never reach a server log or a Referer. Only
 * the SHA-256 is stored (EmailToken.tokenHash). Consumption is one
 * conditional UPDATE, so a token works once.
 */

export type EmailTokenPurpose = "VERIFY_EMAIL" | "PASSWORD_RESET" | "EMAIL_CHANGE" | "SECURITY_LOCKDOWN";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const EMAIL_TOKEN_TTL_MS: Readonly<Record<EmailTokenPurpose, number>> = {
  VERIFY_EMAIL: DAY,
  PASSWORD_RESET: 30 * 60_000,
  EMAIL_CHANGE: HOUR,
  SECURITY_LOCKDOWN: 7 * DAY,
};

/** Per-account caps (database count). Over the cap the request still succeeds, silently, and nothing is sent. */
export const EMAIL_TOKEN_CAP: Readonly<Record<EmailTokenPurpose, { count: number; windowMs: number }>> = {
  VERIFY_EMAIL: { count: 5, windowMs: HOUR },
  PASSWORD_RESET: { count: 3, windowMs: HOUR },
  EMAIL_CHANGE: { count: 3, windowMs: HOUR },
  // Security notices and new-sign-in alerts (each carries a lockdown link).
  SECURITY_LOCKDOWN: { count: 20, windowMs: DAY },
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface EmailTokenRow {
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  tokenHash: string;
  email: string;
  credentialsVersion: number;
  data: Record<string, unknown>;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface IssuedEmailToken {
  id: string;
  token: string;
  expiresAt: Date;
}

/** True when the account already received EMAIL_TOKEN_CAP tokens of this purpose in the window. */
export async function emailCapReached(db: AppDb, userId: string, purpose: EmailTokenPurpose, now: Date): Promise<boolean> {
  const cap = EMAIL_TOKEN_CAP[purpose];
  const recent = await db.emailToken.count({
    where: { userId, purpose, createdAt: { gte: new Date(now.getTime() - cap.windowMs) } },
  });
  return recent >= cap.count;
}

/** Null when the account is over the cap for this purpose (unless ignoreCap: a lockdown's own reset token). */
export async function issueEmailToken(db: AppDb, input: {
  userId: string;
  purpose: EmailTokenPurpose;
  email: string;
  credentialsVersion: number;
  data?: Record<string, unknown>;
  now: Date;
  ignoreCap?: boolean;
}): Promise<IssuedEmailToken | null> {
  if (!input.ignoreCap && await emailCapReached(db, input.userId, input.purpose, input.now)) return null;
  const token = randomToken(32);
  const expiresAt = new Date(input.now.getTime() + EMAIL_TOKEN_TTL_MS[input.purpose]);
  const row = await db.emailToken.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: await sha256Hex(token),
      email: input.email,
      credentialsVersion: input.credentialsVersion,
      data: input.data ?? {},
      expiresAt,
      // The application clock, so consumedAt (also the application clock) is never earlier.
      createdAt: input.now,
    },
    select: { id: true },
  }) as { id: string };
  return { id: row.id, token, expiresAt };
}

export function isEmailTokenShape(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** Read a token row without consuming it (null for a malformed or unknown token). */
export async function findEmailToken(db: AppDb, token: unknown): Promise<EmailTokenRow | null> {
  if (!isEmailTokenShape(token)) return null;
  return db.emailToken.findUnique({ where: { tokenHash: await sha256Hex(token) } }) as Promise<EmailTokenRow | null>;
}

/** Atomic single use: unconsumed, unexpired and of this purpose, or null. */
export async function consumeEmailToken(db: AppDb, token: unknown, purpose: EmailTokenPurpose, now: Date): Promise<EmailTokenRow | null> {
  if (!isEmailTokenShape(token)) return null;
  const tokenHash = await sha256Hex(token);
  const { count } = await db.emailToken.updateMany({
    where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (count !== 1) return null;
  return db.emailToken.findUnique({ where: { tokenHash } }) as Promise<EmailTokenRow | null>;
}

/** Mark every outstanding token of these purposes as used. */
export async function voidEmailTokens(db: AppDb, userId: string, purposes: EmailTokenPurpose[], now: Date): Promise<number> {
  const { count } = await db.emailToken.updateMany({
    where: { userId, purpose: { in: purposes }, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return count;
}

export function tokenData(row: { data: unknown }): Record<string, unknown> {
  return row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {};
}
