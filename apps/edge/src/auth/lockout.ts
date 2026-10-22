import type { AppDb } from "../http/db";
import { addressKey } from "./ip";

/**
 * Per-account login throttling, independent of the client IP. After
 * LOGIN_LOCK_AFTER consecutive failures the account is locked for 30s,
 * doubling up to 15 minutes. Attempts during the lock are not counted.
 * From a familiar address or a known device (poker_device cookie) the
 * account-wide lock does not apply; failures there use the same schedule for
 * that address or device only (isolate-local counters).
 *
 * Second factors (TOTP and backup codes) follow the same schedule with their
 * own counters: User.mfaFailedCount / mfaLockedUntil account-wide, or an
 * isolate-local counter for a known device at the sign-in step.
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

export interface AddressHistory {
  /** A session from this address (/56 for IPv6) in the last 90 days. */
  familiar: boolean;
  /** Any session in the last 90 days: an alert-storm guard for the first sign-in after rollout. */
  recentSessions: boolean;
}

/** One query for both answers. userId null (unknown user) still runs it, against no rows. */
export async function addressHistory(db: AppDb, userId: string | null, ip: string | null | undefined, now: number): Promise<AddressHistory> {
  const key = addressKey(ip);
  const rows = await db.session.findMany({
    where: { userId: userId ?? NO_USER, createdAt: { gte: new Date(now - FAMILIAR_WINDOW_MS) } },
    select: { ip: true },
  });
  return {
    familiar: key !== null && rows.some((row: { ip: string | null }) => addressKey(row.ip) === key),
    recentSessions: rows.length > 0,
  };
}

export async function isFamiliarAddress(db: AppDb, userId: string | null, ip: string | null | undefined, now: number): Promise<boolean> {
  return (await addressHistory(db, userId, ip, now)).familiar;
}

/**
 * The isolate-local counter a familiar sign-in uses: the known device when
 * there is one (more specific), otherwise the address.
 */
export function familiarScope(ip: string | null | undefined, knownDeviceHash: string | null): string {
  return knownDeviceHash ? `device:${knownDeviceHash}` : `addr:${addressKey(ip) ?? "unknown"}`;
}

interface CounterEntry { failures: number; lockedUntil: number; touchedAt: number }

/** Bounded isolate-local failure counters keyed by `<userId>|<scope>`. */
class IsolateCounters {
  private readonly entries = new Map<string, CounterEntry>();

  lockedUntil(userId: string, scope: string): number {
    return this.entries.get(`${userId}|${scope}`)?.lockedUntil ?? 0;
  }

  /** Count a failure; returns the new count and the lock it started (0 for none). */
  record(userId: string, scope: string, now: number, lockMs: (failures: number) => number): { failures: number; lockMs: number } {
    const key = `${userId}|${scope}`;
    if (!this.entries.has(key) && this.entries.size >= FAMILIAR_MAX_ENTRIES) {
      for (const [stored, entry] of this.entries) if (now - entry.touchedAt > STALE_MS) this.entries.delete(stored);
      if (this.entries.size >= FAMILIAR_MAX_ENTRIES) {
        let oldestKey: string | undefined;
        let oldestTouch = Infinity;
        for (const [stored, entry] of this.entries) {
          if (entry.touchedAt < oldestTouch) { oldestTouch = entry.touchedAt; oldestKey = stored; }
        }
        if (oldestKey) this.entries.delete(oldestKey);
      }
    }
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, touchedAt: now };
    entry.failures += 1;
    entry.touchedAt = now;
    const lock = lockMs(entry.failures);
    if (lock) entry.lockedUntil = now + lock;
    this.entries.set(key, entry);
    return { failures: entry.failures, lockMs: lock };
  }

  clear(userId: string, scope: string): void {
    this.entries.delete(`${userId}|${scope}`);
  }

  reset(): void {
    this.entries.clear();
  }
}

const familiar = new IsolateCounters();
const secondFactor = new IsolateCounters();

export function familiarLockedUntil(userId: string, scope: string): number {
  return familiar.lockedUntil(userId, scope);
}

export function recordFamiliarFailure(userId: string, scope: string, now: number, lockMs: (failures: number) => number): number {
  return familiar.record(userId, scope, now, lockMs).lockMs;
}

export function clearFamiliarFailures(userId: string, scope: string): void {
  familiar.clear(userId, scope);
}

/** Second-factor counters for a known device at the sign-in step. */
export function deviceMfaLockedUntil(userId: string, deviceHash: string): number {
  return secondFactor.lockedUntil(userId, `device:${deviceHash}`);
}

/** Count an attempt for one known device (before its code is checked; a right code clears it). */
export function recordDeviceMfaFailure(userId: string, deviceHash: string, now: number): { failures: number; lockMs: number } {
  return secondFactor.record(userId, `device:${deviceHash}`, now, loginLockMs);
}

export function clearDeviceMfaFailures(userId: string, deviceHash: string): void {
  secondFactor.clear(userId, `device:${deviceHash}`);
}

/** Tests only. These counters are isolate-local, same as the Node process map. */
export function resetFamiliarLockout(): void {
  familiar.reset();
  secondFactor.reset();
}
