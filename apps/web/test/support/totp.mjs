// RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits) for the browser fixtures and specs. Not production code.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_MS = 30_000;

/** RFC 4648 base32 (no padding, case and spaces ignored). */
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function randomBase32(length = 32) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => ALPHABET[byte % 32]).join('');
}

export function hotp(secretB32, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(message).digest();
  const offset = mac[19] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / STEP_MS);
}

/** The code for now (or `offset` steps away). */
export function totp(secretB32, nowMs = Date.now(), offset = 0) {
  return hotp(secretB32, currentStep(nowMs) + offset);
}

/** The matched step within ±1, or null. */
export function matchTotp(secretB32, code, nowMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = currentStep(nowMs);
  for (const candidate of [step - 1, step, step + 1]) if (hotp(secretB32, candidate) === code) return candidate;
  return null;
}
