/**
 * Callers, re-checked by payments itself (docs/money/WALLET.md section 3.2):
 * poker-api authenticated the request, but a compromised poker-api must not
 * be able to act for a user without that user's live session. The payments
 * login may read only the Session and User columns needed here
 * (migration 20261019120000_payments_wallet section 8).
 */
import type { PrismaClient } from "../generated/prisma/client";
import type { Caller, SystemCaller } from "./contract";
import { refuse } from "./errors";
import type { MoneyTx } from "../money/tx";

export interface CallerUser {
  id: string;
  username: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  role: "PLAYER" | "ADMIN";
  securityHoldUntil: Date | null;
  createdAt: Date;
}

type Db = PrismaClient | MoneyTx;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

const USER_SELECT = {
  id: true, username: true, email: true, emailVerifiedAt: true, role: true, kind: true, isGuest: true, securityHoldUntil: true, createdAt: true,
} as const;

async function readUser(db: Db, userId: string): Promise<CallerUser | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  if (!user || user.kind !== "HUMAN" || user.isGuest) return null;
  return {
    id: user.id, username: user.username, email: user.email, emailVerifiedAt: user.emailVerifiedAt, role: user.role,
    securityHoldUntil: user.securityHoldUntil, createdAt: user.createdAt,
  };
}

/** The caller's live session and account, or FORBIDDEN (poker-api never sends a dead session; a mismatch is a red flag). */
export async function verifyCaller(db: Db, caller: Caller, now: Date): Promise<CallerUser> {
  if (!caller || typeof caller.userId !== "string" || !ID.test(caller.userId) || typeof caller.sessionId !== "string" || !ID.test(caller.sessionId)) {
    refuse("FORBIDDEN", "Your session has ended. Sign in again.");
  }
  const session = await db.session.findUnique({
    where: { id: caller.sessionId },
    select: { id: true, userId: true, expiresAt: true, absoluteExpiresAt: true, revokedAt: true },
  });
  const t = now.getTime();
  if (!session || session.userId !== caller.userId || session.revokedAt !== null || session.expiresAt.getTime() <= t
      || (session.absoluteExpiresAt !== null && session.absoluteExpiresAt.getTime() <= t)) {
    refuse("FORBIDDEN", "Your session has ended. Sign in again.");
  }
  const user = await readUser(db, caller.userId);
  if (!user) refuse("FORBIDDEN", "This account cannot use the wallet.");
  return user;
}

/** An account event poker-api reports for a user (no session): the user must exist and be a person. */
export async function verifySystemTarget(db: Db, target: SystemCaller): Promise<CallerUser> {
  if (!target || typeof target.userId !== "string" || !ID.test(target.userId)) refuse("VALIDATION", "Unknown account.");
  const user = await readUser(db, target.userId);
  if (!user) refuse("NOT_FOUND", "Unknown account.");
  return user;
}

export function securityHeld(user: Pick<CallerUser, "securityHoldUntil">, now: Date): boolean {
  return user.securityHoldUntil !== null && user.securityHoldUntil.getTime() > now.getTime();
}
