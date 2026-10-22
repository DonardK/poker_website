import type { EdgeConfig } from "../env";
import type { AppDb } from "../http/db";
import { logInfo, logWarn } from "../http/log";
import { clearFamiliarFailures, familiarLockedUntil, loginLockMs, recordFamiliarFailure } from "./lockout";
import { passwords } from "./password";
import { recordSecurityEvent, type RequestFacts } from "./security-events";

/**
 * One password attempt with the lockout rules (lockout.ts): exactly one
 * PBKDF2 derivation whatever the outcome (a dummy one for an unknown or
 * locked account), and the same answer for every failure. Used by sign-in,
 * the password step-up and the money step-up.
 */

export interface PasswordSubject {
  id: string;
  passwordHash: string | null;
  lockedUntil: Date | string | null;
}

export interface PasswordContext {
  /** Familiar address or known device: the account-wide lock does not apply; `scope` has its own counter. */
  familiar: boolean;
  scope: string;
  now: number;
  facts: RequestFacts | null;
}

export type PasswordCheck = { ok: true; rehash: string | null } | { ok: false };

async function recordFailedLogin(db: AppDb, userId: string, now: number, facts: RequestFacts | null): Promise<void> {
  const { failedLoginCount } = await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  }) as { failedLoginCount: number };
  const lockMs = loginLockMs(failedLoginCount);
  if (!lockMs) return;
  await db.user.updateMany({ where: { id: userId }, data: { lockedUntil: new Date(now + lockMs) } });
  logWarn({ security: "LOGIN_LOCKOUT", userId, failures: failedLoginCount, lockMs }, "account locked after repeated failed logins");
  await recordSecurityEvent(db, { userId, type: "LOGIN_LOCKOUT", facts, data: { failures: failedLoginCount, lockMs } });
}

/** `user` null (unknown, bot, guest, no password) still costs one derivation and answers like a wrong password. */
export async function checkPassword(db: AppDb, config: EdgeConfig, user: PasswordSubject | null, password: string, context: PasswordContext): Promise<PasswordCheck> {
  const usable = user && user.passwordHash ? user : null;
  const { now, familiar, scope } = context;
  const accountLocked = usable?.lockedUntil != null && new Date(usable.lockedUntil).getTime() > now;
  const locked = usable != null && (familiar ? familiarLockedUntil(usable.id, scope) > now : accountLocked);
  const verdict = await passwords.verify(
    password,
    usable && !locked ? usable.passwordHash : null,
    { iterations: config.passwordPbkdf2Iterations, legacyBcrypt: config.enableLegacyBcrypt },
  );
  if (!usable || locked || !verdict.matches) {
    if (usable && !locked) {
      if (!familiar) await recordFailedLogin(db, usable.id, now, context.facts);
      else {
        const lockMs = recordFamiliarFailure(usable.id, scope, now, loginLockMs);
        if (lockMs) logWarn({ security: "LOGIN_LOCKOUT", userId: usable.id, scope: scope.startsWith("device:") ? "known-device" : "familiar-address", lockMs }, "account locked for one familiar address or device after repeated failed logins");
      }
    }
    return { ok: false };
  }
  if (familiar && accountLocked) {
    logInfo({ security: "LOGIN_FROM_FAMILIAR_ADDRESS_DURING_LOCK", userId: usable.id }, "signed in from a familiar address or device while the account was locked for others");
  }
  clearFamiliarFailures(usable.id, scope);
  return { ok: true, rehash: verdict.rehash };
}
