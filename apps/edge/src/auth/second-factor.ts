import type { SecondFactorMethod } from "@poker/shared";
import type { EdgeConfig } from "../env";
import type { AppDb } from "../http/db";
import { logWarn } from "../http/log";
import { consumeBackupCode } from "./backup-codes";
import { clearDeviceMfaFailures, deviceMfaLockedUntil, LOGIN_LOCK_AFTER, loginLockMs, recordDeviceMfaFailure } from "./lockout";
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

/**
 * Seconds the second factor stays locked, read from a row already loaded, or
 * 0. It counts nothing: the attempt itself goes through reserveSecondFactorAttempt.
 */
export function secondFactorLockedFor(user: { mfaLockedUntil: Date | string | null }, scope: SecondFactorScope, now: Date): number {
  const until = scope.knownDeviceHash
    ? deviceMfaLockedUntil(scope.userId, scope.knownDeviceHash)
    : user.mfaLockedUntil == null ? 0 : new Date(user.mfaLockedUntil).getTime();
  return secondsUntil(until, now.getTime());
}

/** Seconds until `until`, rounded up, or 0 when it has passed. */
function secondsUntil(until: number, now: number): number {
  return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : 0;
}

/** A counted attempt (go ahead and check the code), or how long to wait. */
export type SecondFactorAttempt =
  | { ok: true; scope: SecondFactorScope; failures: number; lockMs: number }
  | { ok: false; retryAfterS: number };

/**
 * Compare-and-set rounds before giving up. Each lost round means another
 * attempt was counted meanwhile, so a burst reaches the lock (at the 5th
 * count) within LOGIN_LOCK_AFTER + 1 rounds and every later round sees it.
 */
const RESERVE_ROUNDS = LOGIN_LOCK_AFTER + 3;

/**
 * Count an attempt BEFORE its code is checked, starting the lock in the same
 * write when this attempt reaches it. Checking the lock, then the code, then
 * counting would let every request that read the counter before the first
 * failure was written be tried: parallel guesses would pass the cap. A right
 * code then clears the counter (clearSecondFactorFailures, or the sign-in's
 * own reset); a wrong one is already counted.
 *
 * Account-wide: a compare-and-set on User.mfaFailedCount (Postgres re-checks
 * the WHERE after a concurrent write, so each count is taken once).
 * `snapshot` is the user row the caller already read. A known device at the
 * sign-in step: its isolate-local counter (synchronous, so atomic there).
 */
export async function reserveSecondFactorAttempt(
  db: AppDb,
  snapshot: { mfaFailedCount: number; mfaLockedUntil: Date | string | null } | null,
  scope: SecondFactorScope,
  now: Date,
): Promise<SecondFactorAttempt> {
  const at = now.getTime();
  if (scope.knownDeviceHash) {
    const wait = secondsUntil(deviceMfaLockedUntil(scope.userId, scope.knownDeviceHash), at);
    if (wait > 0) return { ok: false, retryAfterS: wait };
    const counted = recordDeviceMfaFailure(scope.userId, scope.knownDeviceHash, at);
    return { ok: true, scope, failures: counted.failures, lockMs: counted.lockMs };
  }
  let row = snapshot;
  for (let round = 0; round < RESERVE_ROUNDS; round++) {
    row ??= await db.user.findUnique({ where: { id: scope.userId }, select: { mfaFailedCount: true, mfaLockedUntil: true } }) as typeof snapshot;
    if (!row) return { ok: false, retryAfterS: 1 };
    const wait = secondsUntil(row.mfaLockedUntil == null ? 0 : new Date(row.mfaLockedUntil).getTime(), at);
    if (wait > 0) return { ok: false, retryAfterS: wait };
    const failures = row.mfaFailedCount + 1;
    const lockMs = loginLockMs(failures);
    const { count } = await db.user.updateMany({
      where: { id: scope.userId, mfaFailedCount: row.mfaFailedCount },
      data: { mfaFailedCount: failures, ...(lockMs ? { mfaLockedUntil: new Date(at + lockMs) } : {}) },
    });
    if (count === 1) return { ok: true, scope, failures, lockMs };
    row = null;
  }
  // Lost every round: other attempts are being counted right now.
  return { ok: false, retryAfterS: 1 };
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

/** The code of a counted attempt was wrong. Logs and records MFA_LOCKOUT when this attempt started a lock. */
export async function recordSecondFactorFailure(db: AppDb, attempt: Extract<SecondFactorAttempt, { ok: true }>, facts: RequestFacts | null): Promise<void> {
  const { scope, failures, lockMs } = attempt;
  if (!lockMs) return;
  if (scope.knownDeviceHash) {
    logWarn({ security: "MFA_LOCKOUT", userId: scope.userId, scope: "known-device", lockMs }, "second factor locked for one known device after repeated wrong codes");
    return;
  }
  logWarn({ security: "MFA_LOCKOUT", userId: scope.userId, failures, lockMs }, "second factor locked after repeated wrong codes");
  await recordSecurityEvent(db, { userId: scope.userId, type: "MFA_LOCKOUT", facts, data: { failures, lockMs } });
}

/** The code of a counted attempt was right: clear the counter it went on. */
export async function clearSecondFactorFailures(db: AppDb, attempt: Extract<SecondFactorAttempt, { ok: true }>): Promise<void> {
  const { scope } = attempt;
  if (scope.knownDeviceHash) {
    clearDeviceMfaFailures(scope.userId, scope.knownDeviceHash);
    return;
  }
  await db.user.update({ where: { id: scope.userId }, data: { mfaFailedCount: 0, mfaLockedUntil: null }, select: { id: true } });
}
