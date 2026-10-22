/** The daily account-security sweep deletes only rows that can no longer matter. */
import { describe, expect, it } from "vitest";
import { sweep, type SweepDb } from "../src/maintenance/sweep";
import { createHarness } from "./harness";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("sweep", () => {
  it("drops expired nonces, old links, stale TOTP setups, long-removed passkeys and old step-up codes", async () => {
    const { db } = createHarness();
    const now = new Date("2026-10-19T03:23:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const user = db.addUser({ username: "Sweep_Me" });
    const other = db.addUser({ username: "Sweep_Keep" });
    db.insert("authNonce", { id: "nonce-old-1", purpose: "mfa:login", expiresAt: ago(2 * HOUR) });
    db.insert("authNonce", { id: "nonce-new-1", purpose: "mfa:login", expiresAt: ago(10 * 60_000) });
    const token = (expiresAt: Date) => ({ userId: user.id, purpose: "PASSWORD_RESET", tokenHash: crypto.randomUUID(), email: "a@example.com", credentialsVersion: 0, expiresAt });
    db.insert("emailToken", token(ago(31 * DAY)));
    db.insert("emailToken", token(ago(2 * DAY)));
    db.insert("userTotp", { userId: user.id, secretCiphertext: "v2.a1.x", enabledAt: null, createdAt: ago(2 * DAY) });
    db.insert("userTotp", { userId: other.id, secretCiphertext: "v2.a1.x", enabledAt: ago(3 * DAY), createdAt: ago(3 * DAY) });
    const passkey = (credentialId: string, removedAt: Date | null) => ({ userId: user.id, credentialId, publicKey: "AAAA", deviceType: "singleDevice", rpId: "localhost", name: "Key", removedAt });
    db.insert("webAuthnCredential", passkey("removed-long-ago-1", ago(31 * DAY)));
    db.insert("webAuthnCredential", passkey("removed-recently-1", ago(3 * DAY)));
    db.insert("webAuthnCredential", passkey("active-credential", null));
    db.insert("stepUpEmailChallenge", { userId: user.id, sessionId: "s", purpose: "withdrawal", bindHash: "a".repeat(64), codeHash: "b".repeat(64), email: "a@example.com", createdAt: ago(2 * DAY), expiresAt: ago(2 * DAY - 10 * 60_000) });

    const deleted = await sweep(db.api as unknown as SweepDb, now);
    expect(deleted).toEqual({ authNonces: 1, emailTokens: 1, pendingTotp: 1, removedPasskeys: 1, stepUpEmailCodes: 1 });
    expect(db.rows("authNonce").map((row) => row.id)).toEqual(["nonce-new-1"]);
    expect(db.rows("userTotp").map((row) => row.userId)).toEqual([other.id]);
    expect(db.rows("webAuthnCredential").map((row) => row.credentialId).sort()).toEqual(["active-credential", "removed-recently-1"]);
  });
});
