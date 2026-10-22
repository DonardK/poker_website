/**
 * TOTP (RFC 6238 / RFC 4226) and backup codes, as units: the RFC vectors,
 * the ±1 step window, base32, the otpauth URI, sealing under the auth key
 * ring, and backup-code format, normalisation and per-user hashing.
 */
import { describe, expect, it } from "vitest";
import { generateBackupCodes, hashBackupCode, normalizeBackupCode } from "../src/auth/backup-codes";
import { base32Decode, base32Encode, matchTotp, newTotpSecret, openTotpSecret, otpauthUri, sealTotpSecret, totpCode } from "../src/auth/totp";
import { createHarness, randomTestHex } from "./harness";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"
const VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("totp", () => {
  it("matches the six RFC 6238 Appendix B vectors (SHA-1, 6 digits)", async () => {
    for (const [seconds, code] of VECTORS) {
      expect(await totpCode(RFC_SECRET, Math.floor(seconds / 30)), String(seconds)).toBe(code);
      expect(await matchTotp(RFC_SECRET, code, seconds * 1000), String(seconds)).toBe(Math.floor(seconds / 30));
    }
  });

  it("accepts the previous, current and next step and refuses two steps away", async () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    for (const delta of [-1, 0, 1]) {
      expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step + delta), now)).toBe(step + delta);
    }
    for (const delta of [-2, 2]) {
      expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step + delta), now)).toBeNull();
    }
    for (const bad of ["12345", "1234567", "abcdef", "", "12 456"]) expect(await matchTotp(RFC_SECRET, bad, now)).toBeNull();
  });

  it("base32 round-trips and a new secret is 20 bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET)!)).toBe("12345678901234567890");
    expect(base32Decode("not base32!")).toBeNull();
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("builds the otpauth URI with an encoded issuer and a colon separator", () => {
    const uri = otpauthUri("Hold'em Live", "Alice_1", RFC_SECRET);
    expect(uri).toBe(`otpauth://totp/Hold'em%20Live:Alice_1?secret=${RFC_SECRET}&issuer=Hold'em%20Live&algorithm=SHA1&digits=6&period=30`);
    expect(decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, "")).split(":")).toEqual(["Hold'em Live", "Alice_1"]);
  });

  it("seals the secret under the auth key ring, bound to the user", () => {
    const { config } = createHarness();
    const sealed = sealTotpSecret(config, "user-a", RFC_SECRET);
    expect(sealed).toMatch(/^v2\.a1\./);
    expect(sealed).not.toContain(RFC_SECRET);
    expect(openTotpSecret(config, "user-a", sealed)).toBe(RFC_SECRET);
    expect(() => openTotpSecret(config, "user-b", sealed)).toThrow();
    const off = createHarness({ AUTH_HMAC_SECRET: "", AUTH_ENCRYPTION_KEYS: "", AUTH_ENCRYPTION_ACTIVE_KEY_ID: "" });
    expect(off.config.security).toBeNull();
    expect(() => sealTotpSecret(off.config, "user-a", RFC_SECRET)).toThrow(/not configured/);
  });
});

describe("backup codes", () => {
  it("are 10 distinct XXXXX-XXXXX Crockford codes", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it("normalise case, spaces, dashes and the I/L/O look-alikes", () => {
    expect(normalizeBackupCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeBackupCode(" il0o1 - 23456 ")).toBe("11001" + "23456");
    expect(normalizeBackupCode("ABCDE-FGHJ")).toBeNull();
    expect(normalizeBackupCode("ABCDE-FGHJU")).toBeNull(); // U is not Crockford
    expect(normalizeBackupCode("x".repeat(40))).toBeNull();
  });

  it("hash with the HMAC key and differ per user", async () => {
    const secret = randomTestHex();
    const a = await hashBackupCode(secret, "user-a", "ABCDEFGHJK");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashBackupCode(secret, "user-a", "ABCDEFGHJK")).toBe(a);
    expect(await hashBackupCode(secret, "user-b", "ABCDEFGHJK")).not.toBe(a);
    expect(await hashBackupCode("another-secret-another-secret-123", "user-a", "ABCDEFGHJK")).not.toBe(a);
  });
});
