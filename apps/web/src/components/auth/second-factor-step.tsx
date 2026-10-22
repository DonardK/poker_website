"use client";

import { useEffect, useRef, useState } from "react";
import type { MfaChallenge, SecondFactorMethod } from "@poker/shared";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { OtpInput } from "@/components/ui/otp-input";
import { TextField } from "@/components/ui/text-field";
import { focusSoon } from "@/lib/focus";

/**
 * The second sign-in step for an account with two-step verification: a code
 * from the authenticator app (auto-submits on the 6th digit) or a single-use
 * backup code. The ticket from the password step expires; when it does, the
 * page goes back to the password.
 */
export function SecondFactorStep({ challenge, method, onMethodChange, onSubmit, onBack, onExpired, error, busy, headingRef, passkeyButton }: {
  challenge: MfaChallenge;
  method: SecondFactorMethod;
  onMethodChange: (method: SecondFactorMethod) => void;
  onSubmit: (method: SecondFactorMethod, code: string) => Promise<boolean>;
  onBack: () => void;
  onExpired: () => void;
  error: string | null;
  busy: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  passkeyButton?: React.ReactNode;
}) {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  useEffect(() => {
    const ms = Date.parse(challenge.expiresAt) - Date.now();
    const id = window.setTimeout(() => onExpiredRef.current(), Number.isFinite(ms) ? Math.max(0, ms) : 300_000);
    return () => window.clearTimeout(id);
  }, [challenge]);

  useEffect(() => { setCode(""); }, [method]);

  async function submit(value = code) {
    const cleaned = method === "backup_code" ? value.replace(/[\s-]/g, "").toUpperCase() : value;
    if (busy || !cleaned) return;
    const ok = await onSubmit(method, cleaned);
    if (!ok) {
      setCode("");
      focusSoon(inputRef);
    }
  }

  const backupAllowed = challenge.methods.includes("backup_code");
  const totpAllowed = challenge.methods.includes("totp");
  return (
    <section aria-labelledby="second-factor-heading" className="flex flex-col gap-4">
      <h2 id="second-factor-heading" ref={headingRef} tabIndex={-1} className="font-[family-name:var(--font-display)] text-2xl outline-none">
        Two-step verification
      </h2>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex flex-col gap-4">
        {method === "totp" ? (
          <>
            <p className="text-sm text-emerald-50">Enter the 6-digit code from your authenticator app.</p>
            <OtpInput ref={inputRef} id="code" label="Authentication code" value={code} onChange={setCode} disabled={busy}
              onComplete={(value) => void submit(value)} />
          </>
        ) : (
          <TextField ref={inputRef} id="backup-code" label="Backup code" hint="Each backup code works once. Dashes are optional."
            value={code} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={16} disabled={busy}
            onChange={(event) => setCode(event.target.value)} />
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" busy={busy} disabled={busy || !code}>Verify</Button>
      </form>
      <div className="flex flex-col items-start gap-2 text-sm">
        {method === "totp" && backupAllowed ? (
          <button type="button" className="text-amber-100 underline underline-offset-4" onClick={() => onMethodChange("backup_code")}>
            Use a backup code instead
          </button>
        ) : null}
        {method === "backup_code" && totpAllowed ? (
          <button type="button" className="text-amber-100 underline underline-offset-4" onClick={() => onMethodChange("totp")}>
            Use your authenticator app
          </button>
        ) : null}
        <button type="button" className="text-amber-100 underline underline-offset-4" onClick={onBack}>Back</button>
      </div>
      {passkeyButton}
    </section>
  );
}
