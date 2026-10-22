import type { EdgeConfig } from "../env";
import { authRingFromConfig, decryptState, encryptState } from "../game/crypto";
import type { AppDb } from "../http/db";
import { bytesEqual, randomBytes } from "./bytes";

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30 s steps,
 * accepting the previous, current and next step. Secrets are 20 random bytes
 * (base32, 32 characters), sealed with the account-security key ring under
 * context "user-totp:<userId>" and never logged.
 *
 * Replay: a code is accepted only for a step above UserTotp.lastUsedStep, and
 * the bump is a single conditional UPDATE, so two requests with the same code
 * cannot both pass. Enabling records the enrolment step too.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
const DIGITS = 6;
const WINDOW = [-1, 0, 1] as const;
export const TOTP_PENDING_TTL_MS = 15 * 60_000;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32, case-insensitive, spaces and padding ignored. Null on any other character. */
export function base32Decode(input: string): Uint8Array | null {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth://totp/<issuer>:<account>?secret=...&issuer=...: the format authenticator apps scan. */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / STEP_MS);
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
}

async function hotp(key: CryptoKey, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[19] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code for one step (tests and the enrolment check). */
export async function totpCode(secretB32: string, step: number): Promise<string> {
  const secret = base32Decode(secretB32);
  if (!secret) throw new Error("Invalid TOTP secret");
  return hotp(await hmacKey(secret), step);
}

/**
 * The matched step, or null. All three candidate codes are computed and
 * compared in constant time, with no early exit.
 */
export async function matchTotp(secretB32: string, code: string, nowMs: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  if (!secret) return null;
  const key = await hmacKey(secret);
  const step = currentStep(nowMs);
  const presented = new TextEncoder().encode(code);
  let matched: number | null = null;
  for (const delta of WINDOW) {
    const candidate = await hotp(key, step + delta);
    if (bytesEqual(new TextEncoder().encode(candidate), presented) && matched === null) matched = step + delta;
  }
  return matched;
}

const context = (userId: string) => `user-totp:${userId}`;

export function sealTotpSecret(config: EdgeConfig, userId: string, secretB32: string): string {
  const ring = authRingFromConfig(config);
  if (!ring) throw new Error("Account security is not configured");
  return encryptState(ring, { v: 1, secret: secretB32 }, context(userId));
}

export function openTotpSecret(config: EdgeConfig, userId: string, ciphertext: string): string {
  const ring = authRingFromConfig(config);
  if (!ring) throw new Error("Account security is not configured");
  const sealed = decryptState<{ v?: unknown; secret?: unknown }>(ring, ciphertext, context(userId));
  if (sealed.v !== 1 || typeof sealed.secret !== "string") throw new Error("Unrecognised TOTP secret");
  return sealed.secret;
}

export interface TotpRow {
  userId: string;
  secretCiphertext: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  lastUsedStep: number;
  createdAt: Date;
}

/** Enabled and not switched off: a password sign-in then needs a code. */
export function totpActive(row: Pick<TotpRow, "enabledAt" | "disabledAt"> | null | undefined): boolean {
  return row != null && row.enabledAt != null && row.disabledAt == null;
}

/** matchTotp, then the atomic lastUsedStep bump. False for a wrong, stale or replayed code. */
export async function verifyAndConsumeTotp(db: AppDb, config: EdgeConfig, userId: string, code: string, nowMs: number): Promise<boolean> {
  const row = await db.userTotp.findUnique({ where: { userId } }) as TotpRow | null;
  if (!totpActive(row)) return false;
  const step = await matchTotp(openTotpSecret(config, userId, row!.secretCiphertext), code, nowMs);
  if (step === null || step <= row!.lastUsedStep) return false;
  const { count } = await db.userTotp.updateMany({
    where: { userId, lastUsedStep: { lt: step }, enabledAt: { not: null }, disabledAt: null },
    data: { lastUsedStep: step },
  });
  return count === 1;
}
