import type { SecondFactorMethod } from "@poker/shared";
import type { EdgeConfig } from "../env";
import type { AppDb } from "../http/db";
import { logWarn } from "../http/log";
import { consumeBackupCode } from "./backup-codes";
import { clearDeviceMfaFailures, deviceMfaLockedUntil, loginLockMs, recordDeviceMfaFailure } from "./lockout";
import { recordSecurityEvent, type RequestFacts } from "./security-events";
import { verifyAndConsumeTotp } from "./totp";

/**
 * The second step after a correct password: a TOTP code or a backup code,
 * with its own lock (same schedule as passwords). At the sign-in step a known
 * device keeps an isolate-local counter, so failures elsewhere cannot lock
 * the owner out; everything else uses the account-wide counter
 * (User.mfaFailedCount / mfaLockedUntil).
 */

export interface SecondFactorScope {
  userId: string;
  /** Known device at the sign-in step (KnownDevice row exists for this cookie): use its own counter. */
  knownDeviceHash: string | null;
}

/** Seconds until the second factor may be tried again, or 0. */
export function secondFactorRetryAfter(user: { mfaLockedUntil: Date | string | null }, scope: SecondFactorScope, now: number): number {
  const until = scope.knownDeviceHash
    ? deviceMfaLockedUntil(scope.userId, scope.knownDeviceHash)
    : user.mfaLockedUntil == null ? 0 : new Date(user.mfaLockedUntil).getTime();
  return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : 0;
}

export type SecondFactorResult =
  | { ok: true; amr: "otp" | "backup"; remainingBackupCodes: number | null }
  | { ok: false };

/** Verify and consume a code (atomic: a code or step is accepted once). Requires TOTP to be enabled. */
export async function verifySecondFactor(
  db: AppDb,
  config: EdgeConfig,
  userId: string,
  method: SecondFactorMethod,
  code: string,
  now: Date,
): Promise<SecondFactorResult> {
  if (!config.security) return { ok: false };
  if (method === "totp") {
    return await verifyAndConsumeTotp(db, config, userId, code.trim(), now.getTime()) ? { ok: true, amr: "otp", remainingBackupCodes: null } : { ok: false };
  }
  const used = await consumeBackupCode(db, config.security.hmacSecret, userId, code, now);
  return used.ok ? { ok: true, amr: "backup", remainingBackupCodes: used.remaining } : { ok: false };
}

/** Count a wrong code. Logs and records MFA_LOCKOUT when a lock starts. */
export async function recordSecondFactorFailure(db: AppDb, scope: SecondFactorScope, now: Date, facts: RequestFacts | null): Promise<void> {
  if (scope.knownDeviceHash) {
    const lockMs = recordDeviceMfaFailure(scope.userId, scope.knownDeviceHash, now.getTime());
    if (lockMs) logWarn({ security: "MFA_LOCKOUT", userId: scope.userId, scope: "known-device", lockMs }, "second factor locked for one known device after repeated wrong codes");
    return;
  }
  const { mfaFailedCount } = await db.user.update({
    where: { id: scope.userId },
    data: { mfaFailedCount: { increment: 1 } },
    select: { mfaFailedCount: true },
  }) as { mfaFailedCount: number };
  const lockMs = loginLockMs(mfaFailedCount);
  if (!lockMs) return;
  await db.user.update({ where: { id: scope.userId }, data: { mfaLockedUntil: new Date(now.getTime() + lockMs) }, select: { id: true } });
  logWarn({ security: "MFA_LOCKOUT", userId: scope.userId, failures: mfaFailedCount, lockMs }, "second factor locked after repeated wrong codes");
  await recordSecurityEvent(db, { userId: scope.userId, type: "MFA_LOCKOUT", facts, data: { failures: mfaFailedCount, lockMs } });
}

/** After a right code: clear the counter that applied. */
export async function clearSecondFactorFailures(db: AppDb, scope: SecondFactorScope, user: { mfaFailedCount: number; mfaLockedUntil: Date | string | null }): Promise<void> {
  if (scope.knownDeviceHash) clearDeviceMfaFailures(scope.userId, scope.knownDeviceHash);
  if (user.mfaFailedCount !== 0 || user.mfaLockedUntil != null) {
    await db.user.update({ where: { id: scope.userId }, data: { mfaFailedCount: 0, mfaLockedUntil: null }, select: { id: true } });
  }
}
