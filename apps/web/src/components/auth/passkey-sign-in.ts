"use client";

import type { AuthResponse } from "@poker/shared";
import { ApiError } from "@/lib/api";
import { passkeyLogin, passkeyLoginOptions } from "@/lib/auth-api";
import { getPasskeyAssertion, passkeyFailure, passkeyFailureMessage } from "@/lib/webauthn";

/**
 * Sign in with a discoverable passkey (user verification required, which
 * counts as two factors on its own): options, the browser ceremony, verify.
 * `autofill` is conditional mediation: it waits until the user picks a
 * passkey from the username field's suggestions.
 */
export async function passkeySignIn(opts: { remember: boolean | (() => boolean); autofill?: boolean; cancelled?: () => boolean }): Promise<AuthResponse> {
  const { options, challengeToken } = await passkeyLoginOptions();
  // The page moved on while the options were on their way: start no ceremony (it would cancel a newer one).
  if (opts.cancelled?.()) throw new DOMException("The passkey request was cancelled.", "AbortError");
  const credential = await getPasskeyAssertion(options, { autofill: opts.autofill });
  const remember = typeof opts.remember === "function" ? opts.remember() : opts.remember;
  // SECURITY: no "unknown credential" signal on a refusal. The API answers PASSKEY_INVALID alike for an unknown
  // passkey and for one that failed verification (no enumeration), so a signal could make the password
  // manager delete a passkey that is still registered here.
  return passkeyLogin({ challengeToken, credential, remember });
}

/** The message for a failed passkey sign-in, or null when nothing should be said (the user cancelled). */
export function passkeySignInError(err: unknown): string | null {
  if (err instanceof ApiError) {
    if (err.code === "PASSKEY_INVALID") return "That passkey wasn't accepted. Try another passkey, or sign in with your password.";
    if (err.code === "CHALLENGE_INVALID") return "That passkey request expired. Try again.";
    if (err.code === "PASSKEYS_UNAVAILABLE") return "Passkeys are unavailable right now. Sign in with your password.";
    if (err.status === 429) return "Too many attempts. Wait a moment and try again.";
    return err.message;
  }
  return passkeyFailureMessage(passkeyFailure(err));
}
