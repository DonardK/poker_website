import type { AppDb } from "../http/db";
import { totpActive, type TotpRow } from "./totp";

/** The account's sign-in factors beyond the password, read together. */
export interface Factors {
  totp: TotpRow | null;
  /** TOTP enabled and not switched off. */
  totpEnabled: boolean;
  /** Active (not removed) passkeys. */
  passkeys: number;
}

export async function readFactors(db: AppDb, userId: string): Promise<Factors> {
  const [totp, passkeys] = await Promise.all([
    db.userTotp.findUnique({ where: { userId } }) as Promise<TotpRow | null>,
    db.webAuthnCredential.count({ where: { userId, removedAt: null } }),
  ]);
  return { totp, totpEnabled: totpActive(totp), passkeys };
}

/** A second factor was part of the sign-in or step-up: a TOTP code, a backup code or a passkey with user verification. */
export function includesSecondFactor(methods: readonly string[]): boolean {
  return methods.includes("otp") || methods.includes("backup") || methods.includes("passkey");
}
