"use client";

import { useCallback, useState } from "react";
import type { PasskeySummary } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { ApiError } from "@/lib/api";
import { errorCode, messageOf, passkeyRegistrationOptions, registerPasskey } from "@/lib/auth-api";
import { describeUserAgent } from "@/lib/user-agent";
import { createPasskey, passkeyFailure, passkeyFailureMessage } from "@/lib/webauthn";
import { useAuthStore } from "@/stores/session";

function addFailure(err: unknown): string | null {
  if (err instanceof ApiError) {
    const code = errorCode(err);
    if (code === "PASSKEY_ALREADY_REGISTERED") return "This passkey is already on your account.";
    if (code === "PASSKEY_LIMIT") return "This account has the most passkeys allowed. Remove one first.";
    if (code === "PASSKEYS_UNAVAILABLE") return "Passkeys are unavailable right now. Try again later.";
    if (code === "PASSKEY_INVALID" || code === "CHALLENGE_INVALID") return "The passkey couldn't be saved. Try again.";
    return messageOf(err);
  }
  return passkeyFailureMessage(passkeyFailure(err));
}

/**
 * Add a passkey to the signed-in account: options (needs a fresh step-up),
 * the browser's create ceremony, then the API verifies and stores the public
 * key. The default name is this browser and system ("Chrome on Windows").
 * Cancelling anywhere is silent.
 */
export function useAddPasskey(onAdded: (passkey: PasskeySummary) => void): { add: () => Promise<void>; busy: boolean; error: string | null; clearError: () => void } {
  const { withStepUp } = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { options, challengeToken } = await withStepUp(() => passkeyRegistrationOptions(), { action: "add a passkey" });
      const credential = await createPasskey(options);
      const name = describeUserAgent(navigator.userAgent).slice(0, 64);
      // The step-up is checked again on save; a lapse while the browser dialog was open asks once more.
      const { passkey } = await withStepUp(() => registerPasskey({ challengeToken, credential, name }), { action: "add a passkey" });
      const user = useAuthStore.getState().user;
      useAuthStore.getState().patchUser({ passkeyCount: (user?.passkeyCount ?? 0) + 1 });
      onAdded(passkey);
    } catch (err) {
      if (!isStepUpCancelled(err)) setError(addFailure(err));
    } finally {
      setBusy(false);
    }
  }, [withStepUp, onAdded]);

  return { add, busy, error, clearError: () => setError(null) };
}
