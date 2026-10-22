"use client";

import { useState } from "react";
import Link from "next/link";
import { AgeTermsGate, hasConsent, NO_CONSENT, type AgeTermsConsent } from "@/components/age-terms-gate";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { acceptTerms, messageOf } from "@/lib/auth-api";
import { termsAcceptance, termsErrorMessage, TERMS_VERSION } from "@/lib/legal";
import { signOut } from "@/lib/session-actions";
import { useAuthStore } from "@/stores/session";

/**
 * COMPLIANCE: the account accepted an older terms version than this build
 * shows. Play continues only after an explicit 18+ confirmation and
 * acceptance of the current documents (both boxes start unticked).
 */
export function TermsUpdatePrompt() {
  const [consent, setConsent] = useState<AgeTermsConsent>(NO_CONSENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!hasConsent(consent) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await acceptTerms(termsAcceptance());
      useAuthStore.getState().patchUser({ termsVersion: user.termsVersion ?? TERMS_VERSION });
    } catch (err) {
      setError(termsErrorMessage(err) ?? messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center gap-4 px-6 py-16">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">We&apos;ve updated our terms</h1>
      <p className="text-emerald-50">
        Please read the updated{" "}
        <Link href="/terms" target="_blank" rel="noopener" className="font-semibold text-amber-100 underline underline-offset-4">Terms of Service</Link>
        {" "}and{" "}
        <Link href="/privacy" target="_blank" rel="noopener" className="font-semibold text-amber-100 underline underline-offset-4">Privacy Notice</Link>
        {" "}(version {TERMS_VERSION}) and accept them to keep playing.
      </p>
      <AgeTermsGate value={consent} onChange={setConsent} disabled={busy} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Button busy={busy} disabled={busy || !hasConsent(consent)} onClick={() => void accept()}>Accept and continue</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void signOut({ reason: "logout" })}>Sign out</Button>
      </div>
    </main>
  );
}
