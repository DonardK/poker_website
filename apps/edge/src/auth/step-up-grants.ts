import type { StepUpGrantMethod, StepUpPurpose } from "@poker/shared";
import { STEP_UP_EMAIL_CODE_DIGITS, STEP_UP_EMAIL_CODE_TTL_MS, STEP_UP_GRANT_TTL_MS, STEP_UP_METHODS_BY_PURPOSE } from "@poker/shared";
import type { AppDb } from "../http/db";
import { hmacSha256, randomBelow, textEqual, toHex } from "./bytes";
import type { Factors } from "./factors";
import { subkey } from "./tickets";

/**
 * Money step-up (docs/money/WALLET.md): a single-use StepUpGrant bound to one
 * session, one purpose and the hash of one canonical action. The API mints
 * it after checking a proof; the payments Worker consumes it (sets
 * consumedAt) inside the transaction it authorises. The database refuses a
 * PASSWORD-only money grant, an admin_payments grant without a passkey, a
 * lifetime over 5 minutes and any second consumption.
 *
 * Proofs: a passkey with user verification (PASSKEY); the password plus a
 * TOTP or backup code (TOTP); or, only for an account with neither TOTP nor
 * a passkey, the password plus a 6-digit code emailed for this session,
 * purpose and action (PASSWORD_EMAIL).
 */

export const EMAIL_CODE_HOURLY_CAP = 5;

export type ProofKind = "passkey" | "totp" | "password_email";

export const PROOF_METHOD: Readonly<Record<ProofKind, StepUpGrantMethod>> = {
  passkey: "PASSKEY",
  totp: "TOTP",
  password_email: "PASSWORD_EMAIL",
};

/** Null when the proof kind may be used for this purpose by this account; otherwise why not. */
export function methodRefusal(purpose: StepUpPurpose, kind: ProofKind, factors: Factors): string | null {
  const method = PROOF_METHOD[kind];
  if (!STEP_UP_METHODS_BY_PURPOSE[purpose].includes(method)) {
    return purpose === "admin_payments" ? "Admin payment decisions need a passkey." : "This confirmation method is not allowed here.";
  }
  if (kind === "password_email" && (factors.totpEnabled || factors.passkeys > 0)) {
    return "Use your passkey or authenticator app to confirm.";
  }
  if (kind === "totp" && !factors.totpEnabled) return "Two-step verification is not set up on this account.";
  if (kind === "passkey" && factors.passkeys === 0) return "This account has no passkeys.";
  return null;
}

export interface GrantInput {
  userId: string;
  sessionId: string;
  purpose: StepUpPurpose;
  bindHash: string;
  method: StepUpGrantMethod;
  now: Date;
}

/** createdAt and expiresAt come from one clock reading (the database bounds the difference). */
export async function createGrant(db: AppDb, input: GrantInput): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(input.now.getTime() + STEP_UP_GRANT_TTL_MS);
  const row = await db.stepUpGrant.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      purpose: input.purpose,
      bindHash: input.bindHash,
      method: input.method,
      createdAt: input.now,
      expiresAt,
    },
    select: { id: true },
  }) as { id: string };
  return { id: row.id, expiresAt };
}

export function newEmailCode(): string {
  return String(randomBelow(10 ** STEP_UP_EMAIL_CODE_DIGITS)).padStart(STEP_UP_EMAIL_CODE_DIGITS, "0");
}

export async function hashEmailCode(secret: string, challengeId: string, code: string): Promise<string> {
  return toHex(await hmacSha256(await subkey(secret, "step-up-email-code"), `${challengeId}:${code}`));
}

export async function emailCodeMatches(secret: string, challengeId: string, code: string, storedHash: string): Promise<boolean> {
  return textEqual(await hashEmailCode(secret, challengeId, code), storedHash);
}

export function emailCodeExpiry(now: Date): Date {
  return new Date(now.getTime() + STEP_UP_EMAIL_CODE_TTL_MS);
}

export const PURPOSE_LABEL: Readonly<Record<StepUpPurpose, string>> = {
  withdrawal: "withdrawal",
  payout_destination: "change to your payout details",
  admin_payments: "payments decision",
};
