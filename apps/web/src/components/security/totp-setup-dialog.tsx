"use client";

import { useEffect, useRef, useState } from "react";
import type { TotpSetupResponse } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { BackupCodesPanel } from "@/components/security/backup-codes-panel";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { OtpInput } from "@/components/ui/otp-input";
import { QrCode } from "@/components/ui/qr-code";
import { Spinner } from "@/components/ui/spinner";
import { enableTotp, errorCode, messageOf, retryAfterSeconds, startTotpSetup } from "@/lib/auth-api";
import { useAuthStore } from "@/stores/session";
import { focusSoon } from "@/lib/focus";

type Step =
  | { kind: "loading" }
  | { kind: "scan"; setup: TotpSetupResponse }
  | { kind: "verify"; setup: TotpSetupResponse }
  | { kind: "codes"; codes: string[] }
  | { kind: "failed"; message: string };

/** "ABCD EFGH ..." for typing the key by hand. */
function groupKey(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function setupFailure(err: unknown): string {
  const code = errorCode(err);
  if (code === "TOTP_ALREADY_ENABLED") return "Two-step verification is already on for this account.";
  if (code === "SECURITY_NOT_CONFIGURED") return "Two-step verification can't be set up right now. Try again later.";
  return messageOf(err, "Two-step verification could not be started. Try again.");
}

/**
 * Turn on two-step verification with an authenticator app: scan the QR code
 * (drawn in the browser; the secret goes to no third party) or type the key,
 * confirm a code, then save the ten backup codes. Starting needs a fresh
 * step-up ("Confirm it's you"), right after sign-up the sign-in counts.
 */
export function TotpSetupDialog({ onClose, onEnabled }: { onClose: () => void; onEnabled: () => void }) {
  const { withStepUp } = useStepUp();
  const username = useAuthStore((s) => s.user?.username ?? "");
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  async function begin() {
    setStep({ kind: "loading" });
    setError(null);
    setCode("");
    try {
      const setup = await withStepUp(() => startTotpSetup(), { action: "set up two-step verification" });
      setStep({ kind: "scan", setup });
    } catch (err) {
      if (isStepUpCancelled(err)) { onCloseRef.current(); return; }
      setStep({ kind: "failed", message: setupFailure(err) });
    }
  }

  // Start once on open.
  useEffect(() => { void begin(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step.kind === "verify") codeRef.current?.focus();
    else if (step.kind !== "loading") headingRef.current?.focus();
  }, [step.kind]);

  async function confirm(value = code) {
    if (busy || step.kind !== "verify" || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const { backupCodes } = await enableTotp(value);
      useAuthStore.getState().patchUser({ twoFactorEnabled: true });
      setStep({ kind: "codes", codes: backupCodes });
      onEnabled();
    } catch (err) {
      setCode("");
      const wait = retryAfterSeconds(err);
      if (errorCode(err) === "TOTP_INVALID") setError("That code didn't match. Check your phone's time and try again.");
      else if (errorCode(err) === "TOTP_NOT_PENDING") {
        setError(null);
        setStep({ kind: "failed", message: "This setup expired. Start again to get a new QR code." });
      } else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else setError(messageOf(err));
      focusSoon(codeRef);
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Step["kind"], string> = {
    loading: "Set up two-step verification",
    scan: "Scan the QR code",
    verify: "Enter a code",
    codes: "Save your backup codes",
    failed: "Set up two-step verification",
  };

  return (
    <ModalDialog title={titles[step.kind]} onClose={onClose} dismissible={!busy && step.kind !== "codes"}>
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">{`Step: ${titles[step.kind]}`}</h3>
      {step.kind === "loading" ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <Spinner className="h-8 w-8" />
          <p role="status" className="text-sm text-emerald-50">Preparing your setup…</p>
        </div>
      ) : null}

      {step.kind === "failed" ? (
        <div className="flex flex-col gap-4">
          <Notice tone="error">{step.message}</Notice>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button onClick={() => void begin()}>Start again</Button>
          </div>
        </div>
      ) : null}

      {step.kind === "scan" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-emerald-50">
            Open an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Authy) and scan this code.
          </p>
          <div className="self-center rounded-xl bg-white p-2">
            <QrCode value={step.setup.otpauthUri} label="QR code for your authenticator app" />
          </div>
          <details className="rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-semibold text-amber-100">Can&apos;t scan? Enter this key</summary>
            <p className="mt-3 text-emerald-50">Choose &ldquo;Enter a setup key&rdquo; in the app, then type:</p>
            <p data-testid="totp-secret" className="mt-2 break-all font-mono text-base tracking-wider text-emerald-50">{groupKey(step.setup.secret)}</p>
            <div className="mt-2"><CopyButton value={step.setup.secret} label="Copy key" /></div>
          </details>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => setStep({ kind: "verify", setup: step.setup })}>Next</Button>
          </div>
        </div>
      ) : null}

      {step.kind === "verify" ? (
        <form noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
          <OtpInput ref={codeRef} id="totp-enable-code" label="6-digit code from the app" value={code} onChange={setCode}
            onComplete={(value) => void confirm(value)} disabled={busy} error={error} />
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busy} onClick={() => { setError(null); setStep({ kind: "scan", setup: step.setup }); }}>Back</Button>
            <Button type="submit" busy={busy} disabled={busy || code.length !== 6}>Turn on</Button>
          </div>
        </form>
      ) : null}

      {step.kind === "codes" ? (
        <div className="flex flex-col gap-4">
          <Notice tone="success">Two-step verification is on.</Notice>
          <BackupCodesPanel codes={step.codes} username={username} onDone={onClose} />
        </div>
      ) : null}
    </ModalDialog>
  );
}
