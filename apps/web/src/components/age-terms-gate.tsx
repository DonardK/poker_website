"use client";

import Link from "next/link";
import { useId } from "react";

export interface AgeTermsConsent {
  confirmAge: boolean;
  acceptTerms: boolean;
}

export const NO_CONSENT: AgeTermsConsent = { confirmAge: false, acceptTerms: false };

/** Both boxes ticked: only then may an account be created. */
export function hasConsent(consent: AgeTermsConsent): boolean {
  return consent.confirmAge && consent.acceptTerms;
}

/**
 * COMPLIANCE NOTE (decision D10): account creation requires an explicit 18+
 * confirmation and acceptance of the current terms.
 * Both boxes start unticked and are never pre-ticked or remembered: the
 * request body's `confirmAge: true` / `acceptTerms: true` must be something
 * this person did on this page. The caller keeps its submit button disabled
 * until `hasConsent` is true.
 */
export function AgeTermsGate({ value, onChange, disabled = false }: {
  value: AgeTermsConsent;
  onChange: (next: AgeTermsConsent) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border border-white/20 bg-black/30 px-4 py-3 text-sm text-emerald-50">
      <legend className="sr-only">Age and terms</legend>
      <label htmlFor={`${id}-age`} className="flex items-start gap-3">
        <input id={`${id}-age`} type="checkbox" required disabled={disabled} checked={value.confirmAge}
          onChange={(event) => onChange({ ...value, confirmAge: event.target.checked })}
          className="mt-0.5 h-5 w-5 shrink-0 accent-amber-300" />
        <span>I confirm that I am 18 years of age or older.</span>
      </label>
      <label htmlFor={`${id}-terms`} className="flex items-start gap-3">
        <input id={`${id}-terms`} type="checkbox" required disabled={disabled} checked={value.acceptTerms}
          onChange={(event) => onChange({ ...value, acceptTerms: event.target.checked })}
          className="mt-0.5 h-5 w-5 shrink-0 accent-amber-300" />
        <span>
          I accept the{" "}
          <Link href="/terms" target="_blank" rel="noopener" className="font-semibold text-amber-100 underline underline-offset-4">Terms of Service</Link>
          {" "}and have read the{" "}
          <Link href="/privacy" target="_blank" rel="noopener" className="font-semibold text-amber-100 underline underline-offset-4">Privacy Notice</Link>.
        </span>
      </label>
    </fieldset>
  );
}
