import { BACKUP_CODE_COUNT } from "@poker/shared";
import type { AppDb } from "../http/db";
import { hmacSha256, randomBytes, toHex } from "./bytes";
import { subkey } from "./tickets";

/**
 * Single-use backup codes for accounts with TOTP: 10 codes of 10 Crockford
 * base32 characters (50 bits), shown once as "XXXXX-XXXXX". Only an HMAC
 * under AUTH_HMAC_SECRET is stored (keyed by user), so a copy of the database
 * alone cannot be brute-forced. They work only while TOTP is enabled.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    // 256 is a multiple of 32, so byte & 31 is uniform.
    const raw = [...randomBytes(CODE_LENGTH)].map((byte) => CROCKFORD[byte & 31]).join("");
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** Uppercase, drop spaces and dashes, read I and L as 1 and O as 0. Null unless 10 Crockford characters remain. */
export function normalizeBackupCode(input: string): string | null {
  if (input.length > 32) return null;
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (clean.length !== CODE_LENGTH) return null;
  for (const char of clean) if (!CROCKFORD.includes(char)) return null;
  return clean;
}

export async function hashBackupCode(secret: string, userId: string, normalized: string): Promise<string> {
  return toHex(await hmacSha256(await subkey(secret, "backup-code"), `${userId}:${normalized}`));
}

/**
 * Delete the user's codes and store 10 new hashes. Pass a transaction client.
 * Returns the codes to show once. createdAt is the application clock, which
 * lockdown compares with the incident instant.
 */
export async function replaceBackupCodes(db: AppDb, secret: string, userId: string, now: Date): Promise<string[]> {
  const codes = generateBackupCodes();
  const hashes = await Promise.all(codes.map((code) => hashBackupCode(secret, userId, normalizeBackupCode(code)!)));
  await db.userBackupCode.deleteMany({ where: { userId } });
  await db.userBackupCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash, createdAt: now })) });
  return codes;
}

export async function remainingBackupCodes(db: AppDb, userId: string): Promise<number> {
  return db.userBackupCode.count({ where: { userId, usedAt: null } });
}

/** Mark one unused code as used (atomic). The caller checks that TOTP is enabled first. */
export async function consumeBackupCode(db: AppDb, secret: string, userId: string, input: string, now: Date): Promise<{ ok: boolean; remaining: number }> {
  const normalized = normalizeBackupCode(input);
  if (!normalized) return { ok: false, remaining: -1 };
  const codeHash = await hashBackupCode(secret, userId, normalized);
  const { count } = await db.userBackupCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: now } });
  if (count !== 1) return { ok: false, remaining: -1 };
  return { ok: true, remaining: await remainingBackupCodes(db, userId) };
}
