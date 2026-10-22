import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@poker/shared";
import { z } from "zod";
import { breach } from "./breached";

/**
 * Password rules (NIST SP 800-63B): 12 characters to 72 bytes, no
 * composition rules, must not contain the username, and must not be a known
 * breached password (HIBP, when PASSWORD_BREACH_CHECK is on).
 */

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** A new password (register, reset, change). */
export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_BYTES).refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES);
/** A password presented to sign in or step up: any length up to the hash input limit. */
export const presentedPasswordSchema = z.string().min(1).max(128).refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES);

export type PasswordProblem = { code: "PASSWORD_WEAK" | "PASSWORD_BREACHED"; error: string };

const WEAK: PasswordProblem = { code: "PASSWORD_WEAK", error: "Choose a password that doesn't contain your username." };
const BREACHED: PasswordProblem = {
  code: "PASSWORD_BREACHED",
  error: "This password has appeared in a data breach, so it isn't safe to use. Choose a different one.",
};

/**
 * Null when the password may be used. `unavailable` is called when the
 * breach check could not answer (the password is then allowed).
 */
export async function passwordProblem(
  password: string,
  username: string,
  options: { breachCheck: boolean; unavailable?: () => void },
): Promise<PasswordProblem | null> {
  if (username.length > 0 && password.toLowerCase().includes(username.toLowerCase())) return WEAK;
  if (!options.breachCheck) return null;
  const verdict = await breach.check(password);
  if (verdict === "breached") return BREACHED;
  if (verdict === "unknown") options.unavailable?.();
  return null;
}
