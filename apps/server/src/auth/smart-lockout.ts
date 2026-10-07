/**
 * Smart lockout for password sign-in (NEW-4).
 *
 * The per-account lock (failedLoginCount / lockedUntil on User, see
 * routes.ts) stops password guessing, but on its own anyone who knows a
 * username, and usernames are shown at every table, could keep its owner
 * locked out indefinitely. So the account lock applies to addresses the
 * account has never signed in from. An address one of the account's sessions
 * used in the last FAMILIAR_WINDOW_MS (IPv6 grouped by /56, as the rate
 * limiter does) is "familiar": the owner signing in from home is not locked
 * out by someone else's guesses. Failures from a familiar address are counted
 * here instead, per account and address, with the same escalating lock, so a
 * guesser sharing the owner's address is still slowed down (and the per-IP
 * credential limit in security/rate-limits.ts still applies).
 *
 * The familiar-address counters live in process memory: they reset on
 * restart and are per instance, like the other limiters (F20).
 */
import { ipKeyGenerator } from "express-rate-limit";

export const FAMILIAR_WINDOW_MS = 90 * 86_400_000;
/** Bounds the familiar-address counters; entries untouched for a day are dropped first. */
const MAX_ENTRIES = 10_000;
const STALE_MS = 86_400_000;
/** Queried for a sign-in that names no usable account, so every attempt does the same work. */
const NO_USER = "no-such-user";

interface SessionReader {
  session: { findMany(args: { where: object; select: { ip: true } }): Promise<{ ip: string | null }[]> };
}

/** The address key the rate limiter uses (IPv6 masked to /56), or null. */
export function addressKey(ip: string | null | undefined): string | null {
  return ip ? ipKeyGenerator(ip) : null;
}

/** True when one of the account's sessions from the last FAMILIAR_WINDOW_MS signed in from this address. */
export async function isFamiliarAddress(db: SessionReader, userId: string | null, ip: string | null | undefined, now: number): Promise<boolean> {
  const key = addressKey(ip);
  const rows = await db.session.findMany({
    where: { userId: userId ?? NO_USER, createdAt: { gte: new Date(now - FAMILIAR_WINDOW_MS) }, ip: { not: null } },
    select: { ip: true },
  });
  return key !== null && rows.some((row) => addressKey(row.ip) === key);
}

const familiar = new Map<string, { failures: number; lockedUntil: number; touchedAt: number }>();
const entryKey = (userId: string, ip: string | null | undefined) => `${userId}|${addressKey(ip) ?? "unknown"}`;

/** When the lock on this account from this familiar address ends (ms epoch; 0 when none). */
export function familiarLockedUntil(userId: string, ip: string | null | undefined): number {
  return familiar.get(entryKey(userId, ip))?.lockedUntil ?? 0;
}

/** Count a failed sign-in from a familiar address; returns the lock length started, if any (0 otherwise). */
export function recordFamiliarFailure(userId: string, ip: string | null | undefined, now: number, lockMs: (failures: number) => number): number {
  if (familiar.size >= MAX_ENTRIES) {
    for (const [key, entry] of familiar) if (now - entry.touchedAt > STALE_MS) familiar.delete(key);
    if (familiar.size >= MAX_ENTRIES) familiar.delete(familiar.keys().next().value!);
  }
  const key = entryKey(userId, ip);
  const entry = familiar.get(key) ?? { failures: 0, lockedUntil: 0, touchedAt: now };
  entry.failures += 1;
  entry.touchedAt = now;
  const lock = lockMs(entry.failures);
  if (lock) entry.lockedUntil = now + lock;
  familiar.set(key, entry);
  return lock;
}

/** A successful sign-in from this address clears its counter. */
export function clearFamiliarFailures(userId: string, ip: string | null | undefined): void {
  familiar.delete(entryKey(userId, ip));
}
