/**
 * Game-state encryption key ring and secret-strength validation.
 *
 * SECURITY NOTES
 * - Ring: GAME_ENCRYPTION_KEYS="kid:hex64,kid2:hex64" names every key that
 *   may DECRYPT; GAME_ENCRYPTION_ACTIVE_KEY_ID names the one that ENCRYPTS.
 *   The legacy single GAME_ENCRYPTION_KEY stays supported as key id "k0", the
 *   key every "v1." ciphertext was written with. Rotation = add a new key,
 *   make it active, re-encrypt the mutable rows (scripts/rotate-game-key.mjs)
 *   and keep the old key in the ring for as long as append-only history
 *   (sealed audits, encrypted hole cards) written under it must stay readable.
 * - Production strength checks reject keys and JWT secrets that are
 *   placeholders, low-entropy, reused across purposes or duplicated. Error
 *   messages name the variable and key id, never the value.
 *
 * This module imports no configuration, so it can be tested directly and
 * used by the rotation script without loading any .env file.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** `Buffer` is a Workers global value (`any`) and not a type name. */
type CipherBytes = Uint8Array & { toString(encoding?: string): string; equals(other: Uint8Array): boolean };

export const LEGACY_KEY_ID = "k0";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX64 = /^[a-f0-9]{64}$/i;

export interface KeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, CipherBytes>;
}

export interface KeyRingInput {
  /** GAME_ENCRYPTION_KEYS: "kid:hex64,kid2:hex64" (blank = none). */
  keys?: string | undefined;
  /** GAME_ENCRYPTION_KEY: the legacy single key, ring id "k0" (blank = none). */
  legacyKey?: string | undefined;
  /** GAME_ENCRYPTION_ACTIVE_KEY_ID (blank = the only key, or "k0" when only the legacy key is set). */
  activeKeyId?: string | undefined;
}

/** Variable names used in error messages, so each ring's errors name its own settings. */
export interface KeyRingNames {
  keys: string;
  activeKeyId: string;
  legacyKey: string;
}

export const GAME_KEY_RING_NAMES: KeyRingNames = {
  keys: "GAME_ENCRYPTION_KEYS",
  activeKeyId: "GAME_ENCRYPTION_ACTIVE_KEY_ID",
  legacyKey: "GAME_ENCRYPTION_KEY",
};

/** The account-security ring (TOTP secrets). It has no legacy single key; its keys never equal game keys (env.ts). */
export const AUTH_KEY_RING_NAMES: KeyRingNames = {
  keys: "AUTH_ENCRYPTION_KEYS",
  activeKeyId: "AUTH_ENCRYPTION_ACTIVE_KEY_ID",
  legacyKey: "AUTH_ENCRYPTION_KEYS",
};

/** Builds the ring; throws (without echoing any key material) on malformed input. */
export function parseKeyRing(input: KeyRingInput, names: KeyRingNames = GAME_KEY_RING_NAMES): KeyRing {
  const keys = new Map<string, CipherBytes>();
  const legacy = input.legacyKey?.trim();
  if (legacy) {
    if (!HEX64.test(legacy)) throw new Error(`${names.legacyKey} must be 64 hex characters`);
    keys.set(LEGACY_KEY_ID, Buffer.from(legacy, "hex"));
  }
  for (const entry of (input.keys ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    const kid = separator < 0 ? "" : entry.slice(0, separator).trim();
    const hex = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!KEY_ID.test(kid)) throw new Error(`${names.keys}: each entry must be <kid>:<64 hex>, kid of 1-32 letters, digits, '_' or '-'`);
    if (!HEX64.test(hex)) throw new Error(`${names.keys}: key "${kid}" must be 64 hex characters`);
    if (keys.has(kid)) throw new Error(kid === LEGACY_KEY_ID && legacy
      ? `${names.keys}: key id "${LEGACY_KEY_ID}" is reserved for ${names.legacyKey}`
      : `${names.keys}: key id "${kid}" appears twice`);
    keys.set(kid, Buffer.from(hex, "hex"));
  }
  if (keys.size === 0) throw new Error(`Set ${names.keys} (with ${names.activeKeyId}) or the legacy ${names.legacyKey}`);
  const requested = input.activeKeyId?.trim();
  let activeKeyId: string;
  if (requested) activeKeyId = requested;
  else if (keys.size === 1) activeKeyId = [...keys.keys()][0]!;
  else throw new Error(`${names.activeKeyId} is required when the ring holds more than one key`);
  if (!keys.has(activeKeyId)) throw new Error(`${names.activeKeyId} "${activeKeyId.slice(0, 32)}" is not in the key ring`);
  return { activeKeyId, keys };
}

/**
 * Hex keys that have shipped in examples, documentation or (git history of)
 * the test configuration. They are public, so they protect nothing.
 */
const PLACEHOLDER_KEYS = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  // Edge test keys committed before the suites generated their own per run.
  "c549a47e88271398c0804736a4fcbaa0273d3b09c944b7ee5bea23f3ad51b784",
  "5f2c8e1a9b7d4c3e6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a",
  "6d5ce40d26950b96f5de1c391d98b0a2f952496a370bd764446c42f9ea0fc1e9",
]);

/**
 * Words that mark a secret as a placeholder or a published test value. The
 * repository's own test secrets all contain "test-only".
 */
export const PLACEHOLDER_SECRET = /change|replace|development|test-only|example|dummy|placeholder/i;

const distinct = (values: Iterable<unknown>): number => new Set(values).size;

/**
 * The fewest distinct characters a random secret reliably shows. A hex secret
 * (DEPLOY.md generates the JWT secrets as 32 random bytes in hex) draws from
 * only 16 characters, and about 1 in 4 random 64-character hex strings lacks
 * one of them, so requiring all 16 would refuse good production secrets and
 * stop the API. A hex secret needs 8 (a random 32-character one falls short
 * with probability below 1e-7); any other secret needs 16.
 */
export function minDistinctCharacters(secret: string): number {
  return /^[0-9a-f]+$/i.test(secret) ? 8 : 16;
}

/** A secret and the variable it came from, for messages that name only the variable. */
export type NamedSecret = readonly [name: string, value: string];

/**
 * The first production problem of a key ring, or null: a published or
 * low-entropy key, two ids with one key, or a key pasted into one of
 * `secrets` too (compared as hex text and as raw bytes). Names only.
 */
export function keyRingProblem(ring: KeyRing, secrets: readonly NamedSecret[]): string | null {
  const seen = new Map<string, string>();
  for (const [kid, key] of ring.keys) {
    const hex = key.toString("hex");
    if (PLACEHOLDER_KEYS.has(hex)) return `Encryption key "${kid}" is a published placeholder; generate a random key`;
    if (distinct(key) === 1) return `Encryption key "${kid}" repeats a single byte; generate a random key`;
    if (distinct(key) < 16) return `Encryption key "${kid}" has fewer than 16 distinct byte values; generate a random key`;
    const twin = seen.get(hex);
    if (twin !== undefined) return `Encryption keys "${twin}" and "${kid}" are identical; every key id needs its own key`;
    seen.set(hex, kid);
    for (const [name, secret] of secrets) {
      if (secret.trim().toLowerCase() === hex || Buffer.from(secret, "utf8").equals(key)) return `${name} reuses encryption key "${kid}"; every purpose needs an independent secret`;
    }
  }
  return null;
}

/** The first strength problem of the JWT secrets, or null. */
export function jwtSecretProblem(jwtAccessSecret: string, jwtRefreshSecret: string): string | null {
  for (const [name, secret] of [["JWT_ACCESS_SECRET", jwtAccessSecret], ["JWT_REFRESH_SECRET", jwtRefreshSecret]] as const) {
    if (secret.length < 32) return `${name} must be at least 32 characters`;
    const needed = minDistinctCharacters(secret);
    if (distinct(secret) < needed) return `${name} must contain at least ${needed} distinct characters (generate it with randomBytes(48).toString("base64url"))`;
  }
  if (jwtAccessSecret === jwtRefreshSecret) return "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ";
  return null;
}

/**
 * Production-only strength checks for the key ring and JWT secrets. Throws
 * the first problem found. A JWT secret is compared with each key both as
 * the hex text and as raw bytes, so pasting one value into two variables is
 * caught either way.
 */
export function assertProductionSecrets(ring: KeyRing, jwtAccessSecret: string, jwtRefreshSecret: string): void {
  const problem = keyRingProblem(ring, [["JWT_ACCESS_SECRET", jwtAccessSecret], ["JWT_REFRESH_SECRET", jwtRefreshSecret]])
    ?? jwtSecretProblem(jwtAccessSecret, jwtRefreshSecret);
  if (problem) throw new Error(problem);
}

// ---------------------------------------------------------------------------
// Ciphertext format
// ---------------------------------------------------------------------------

/**
 * v2 additional authenticated data: binds the format version, the key id and
 * the row context (e.g. "table:<id>"). Key ids cannot contain ":" (KEY_ID),
 * so the encoding is unambiguous. Moving a ciphertext to another row, or
 * relabelling it with another key id, fails authentication.
 */
function v2Aad(kid: string, context: string): CipherBytes {
  return Buffer.from(`poker-state:v2:${kid}:${context}`, "utf8");
}

/** "v2.<kid>.<iv hex>.<tag hex>.<data base64>" under the ring's active key. */
export function encryptWithRing(ring: KeyRing, value: unknown, context: string): string {
  const kid = ring.activeKeyId;
  const key = ring.keys.get(kid);
  if (!key) throw new Error("Active encryption key is missing from the ring");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(v2Aad(kid, context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v2", kid, iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("base64")].join(".");
}

/** The key id a ciphertext was written with ("k0" for v1), or null when it is not a recognised format. */
export function ciphertextKeyId(value: string): string | null {
  const parts = value.split(".");
  if (parts[0] === "v1" && parts.length === 4) return LEGACY_KEY_ID;
  if (parts[0] === "v2" && parts.length === 5 && KEY_ID.test(parts[1] ?? "")) return parts[1]!;
  return null;
}

/**
 * Decrypts v1 (legacy, key "k0", AAD = context) and v2 ciphertexts. Fails
 * closed: an unknown format, an unknown key id or any authentication failure
 * throws.
 */
export function decryptWithRing<T>(ring: KeyRing, value: string, context: string): T {
  const parts = value.split(".");
  let kid: string; let nonce: string | undefined; let tag: string | undefined; let data: string | undefined; let aad: CipherBytes;
  if (parts[0] === "v1" && parts.length === 4) {
    kid = LEGACY_KEY_ID; [, nonce, tag, data] = parts; aad = Buffer.from(context);
  } else if (parts[0] === "v2" && parts.length === 5 && KEY_ID.test(parts[1] ?? "")) {
    kid = parts[1]!; [, , nonce, tag, data] = parts; aad = v2Aad(kid, context);
  } else {
    throw new Error("Invalid encrypted state");
  }
  if (!nonce || !tag || !data || !/^[a-f0-9]{24}$/.test(nonce) || !/^[a-f0-9]{32}$/.test(tag)) throw new Error("Invalid encrypted state");
  const key = ring.keys.get(kid);
  if (!key) throw new Error(`Encrypted state uses unknown key id "${kid}"`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "hex"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")) as T;
}
