import { pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashes for the Workers Free plan.
 *
 * bcryptjs cost 12 takes hundreds of milliseconds. Free-plan Workers stop a
 * request at 10 ms of CPU, so login and register use PBKDF2-SHA256 instead.
 * The stored form is:
 *
 *   pbkdf2-sha256$v1$<iterations>$<salt_b64url>$<dk_b64url>
 *
 * 16-byte salt, 32-byte key. `PASSWORD_PBKDF2_ITERATIONS` selects the work
 * (default 10_000 on Free; 600_000 is the Paid-plan setting). A stored count
 * above {@link PASSWORD_PBKDF2_MAX} is ignored and the dummy derivation runs
 * at the configured count, so one poisoned row cannot set the iteration count.
 *
 * Legacy bcrypt (`$2a$` / `$2b$` / `$2y$`) is off unless `ENABLE_LEGACY_BCRYPT`
 * is true. The flag path dynamic-imports bcryptjs so the Free path never
 * evaluates it. Wrangler still bundles the package; it does not run it.
 * When the flag is on, a matching bcrypt hash is replaced with PBKDF2.
 * When it is off, login does the PBKDF2 dummy derivation and returns 401.
 *
 * The HTTP layer still rejects passwords over 72 bytes, which is the input
 * bcrypt stored, so a legacy rehash covers the same bytes.
 */

export const PASSWORD_PBKDF2_DEFAULT = 10_000;
export const PASSWORD_PBKDF2_MAX = 1_000_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ALGO = "pbkdf2-sha256";
const VERSION = "v1";

export interface PasswordVerdict {
  matches: boolean;
  /** Set when the password matched and the stored hash should be replaced. */
  rehash: string | null;
}

export interface VerifyOptions {
  iterations: number;
  legacyBcrypt: boolean;
}

interface Material {
  iterations: number;
  salt: Uint8Array;
  dk: Uint8Array;
}

const dummyByIterations = new Map<number, Material>();
/**
 * Random secret for the unknown-user dummy. Not a password anyone chose.
 * Created on first use: Workers forbid randomBytes during module startup.
 */
let dummySecret: Uint8Array | null = null;

function unknownUserSecret(): Uint8Array {
  dummySecret ??= randomBytes(32);
  return dummySecret;
}

export function passwordIterations(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > PASSWORD_PBKDF2_MAX) {
    throw new Error("PASSWORD_PBKDF2_ITERATIONS is out of range");
  }
  return value;
}

function derive(password: string | Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, KEY_BYTES, "sha256", (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function encodeB64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] ?? 0 : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += b64Char((triple >> 18) & 63);
    out += b64Char((triple >> 12) & 63);
    if (i + 1 < bytes.length) out += b64Char((triple >> 6) & 63);
    if (i + 2 < bytes.length) out += b64Char(triple & 63);
  }
  return out.replaceAll("+", "-").replaceAll("/", "_");
}

function b64Char(index: number): string {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[index] ?? "";
}

function decodeB64Url(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/") + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function format(material: Material): string {
  return `${ALGO}$${VERSION}$${material.iterations}$${encodeB64Url(material.salt)}$${encodeB64Url(material.dk)}`;
}

/** A well-formed PBKDF2 hash at or under the iteration cap, or null. */
export function parsePasswordHash(stored: string): Material | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algo, version, iterRaw, saltRaw, dkRaw] = parts;
  if (algo !== ALGO || version !== VERSION || iterRaw == null || saltRaw == null || dkRaw == null) return null;
  if (!/^[1-9]\d{0,6}$/.test(iterRaw)) return null;
  const iterations = Number(iterRaw);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PASSWORD_PBKDF2_MAX) return null;
  const salt = decodeB64Url(saltRaw);
  const dk = decodeB64Url(dkRaw);
  if (!salt || !dk || salt.length !== SALT_BYTES || dk.length !== KEY_BYTES) return null;
  return { iterations, salt, dk };
}

function isBcryptHash(stored: string): boolean {
  return /^\$2[aby]\$/.test(stored);
}

async function dummyMaterial(iterations: number): Promise<Material> {
  const cached = dummyByIterations.get(iterations);
  if (cached) return cached;
  const salt = randomBytes(SALT_BYTES);
  const dk = await derive(unknownUserSecret(), salt, iterations);
  const material = { iterations, salt, dk };
  dummyByIterations.set(iterations, material);
  return material;
}

/** One PBKDF2 derivation at `iterations`. The result is not a successful login. */
async function dummyMismatch(password: string, iterations: number): Promise<PasswordVerdict> {
  const dummy = await dummyMaterial(iterations);
  const got = await derive(password, dummy.salt, dummy.iterations);
  if (got.length === dummy.dk.length) timingSafeEqual(got, dummy.dk);
  return { matches: false, rehash: null };
}

function hashSync(password: string, iterations: number): string {
  const count = passwordIterations(iterations);
  const salt = randomBytes(SALT_BYTES);
  const dk = pbkdf2Sync(password, salt, count, KEY_BYTES, "sha256");
  return format({ iterations: count, salt, dk });
}

async function hash(password: string, iterations: number): Promise<string> {
  const count = passwordIterations(iterations);
  const salt = randomBytes(SALT_BYTES);
  const dk = await derive(password, salt, count);
  return format({ iterations: count, salt, dk });
}

async function verify(password: string, stored: string | null, options: VerifyOptions): Promise<PasswordVerdict> {
  const iterations = passwordIterations(options.iterations);
  const parsed = stored ? parsePasswordHash(stored) : null;
  if (parsed) {
    const got = await derive(password, parsed.salt, parsed.iterations);
    const matches = got.length === parsed.dk.length && timingSafeEqual(got, parsed.dk);
    if (!matches) return { matches: false, rehash: null };
    if (parsed.iterations < iterations) return { matches: true, rehash: await hash(password, iterations) };
    return { matches: true, rehash: null };
  }
  if (stored && options.legacyBcrypt && isBcryptHash(stored)) {
    try {
      const loaded = await import("bcryptjs");
      const bcrypt = loaded.default ?? loaded;
      if (await bcrypt.compare(password, stored)) return { matches: true, rehash: await hash(password, iterations) };
    } catch {
      /* malformed bcrypt string: same answer as a mismatch, after dummy work below */
    }
    return dummyMismatch(password, iterations);
  }
  return dummyMismatch(password, iterations);
}

/** Object so tests can spy without patching the ESM namespace. */
export const passwords = { hash, hashSync, verify };
