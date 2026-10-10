import type { AppDb } from "../http/db";
import { addressKey } from "./ip";

/**
 * Per-account login throttling, independent of the client IP. After
 * LOGIN_LOCK_AFTER consecutive failures the account is locked for 30s,
 * doubling up to 15 minutes. Attempts during the lock are not counted.
 * From a familiar address the account-wide lock does not apply; failures
 * there use the same schedule for that address only.
 */
export const LOGIN_LOCK_AFTER = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;

export function loginLockMs(failures: number): number {
  return failures < LOGIN_LOCK_AFTER ? 0 : Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** Math.min(failures - LOGIN_LOCK_AFTER, 16));
}

export const FAMILIAR_WINDOW_MS = 90 * 86_400_000;
export const FAMILIAR_MAX_ENTRIES = 10_000;
const STALE_MS = 86_400_000;
const NO_USER = "no-such-user";

export async function isFamiliarAddress(db: AppDb, userId: string | null, ip: string | null | undefined, now: number): Promise<boolean> {
  const key = addressKey(ip);
  const rows = await db.session.findMany({
    where: { userId: userId ?? NO_USER, createdAt: { gte: new Date(now - FAMILIAR_WINDOW_MS) }, ip: { not: null } },
    select: { ip: true },
  });
  return key !== null && rows.some((row: { ip: string | null }) => addressKey(row.ip) === key);
}

interface FamiliarEntry { failures: number; lockedUntil: number; touchedAt: number }
const familiar = new Map<string, FamiliarEntry>();
const entryKey = (userId: string, ip: string | null | undefined) => `${userId}|${addressKey(ip) ?? "unknown"}`;

export function familiarLockedUntil(userId: string, ip: string | null | undefined): number {
  return familiar.get(entryKey(userId, ip))?.lockedUntil ?? 0;
}

export function recordFamiliarFailure(userId: string, ip: string | null | undefined, now: number, lockMs: (failures: number) => number): number {
  const key = entryKey(userId, ip);
  if (!familiar.has(key) && familiar.size >= FAMILIAR_MAX_ENTRIES) {
    for (const [stored, entry] of familiar) if (now - entry.touchedAt > STALE_MS) familiar.delete(stored);
    if (familiar.size >= FAMILIAR_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestTouch = Infinity;
      for (const [stored, entry] of familiar) {
        if (entry.touchedAt < oldestTouch) { oldestTouch = entry.touchedAt; oldestKey = stored; }
      }
      if (oldestKey) familiar.delete(oldestKey);
    }
  }
  const entry = familiar.get(key) ?? { failures: 0, lockedUntil: 0, touchedAt: now };
  entry.failures += 1;
  entry.touchedAt = now;
  const lock = lockMs(entry.failures);
  if (lock) entry.lockedUntil = now + lock;
  familiar.set(key, entry);
  return lock;
}

export function clearFamiliarFailures(userId: string, ip: string | null | undefined): void {
  familiar.delete(entryKey(userId, ip));
}

/** Tests only. Familiar-address counters are isolate-local, same as the Node process map. */
export function resetFamiliarLockout(): void {
  familiar.clear();
}
