"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { StepUpGrantMethod, StepUpGrantResponse, StepUpPurpose } from "@poker/shared";
import { STEP_UP_EMAIL_CODE_DIGITS, STEP_UP_METHODS_BY_PURPOSE } from "@poker/shared";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { OtpInput } from "@/components/ui/otp-input";
import { Spinner } from "@/components/ui/spinner";
import { TextField } from "@/components/ui/text-field";
import { useAccountSecurity } from "@/lib/account-cache";
import { ApiError } from "@/lib/api";
import {
  errorCode, messageOf, reauthPasskeyOptions, requestStepUpEmailCode, requestStepUpGrant, retryAfterSeconds,
} from "@/lib/auth-api";
import { useAuthConfig } from "@/lib/auth-config";
import { focusSoon } from "@/lib/focus";
import { securityHoldText } from "@/lib/wallet-copy";
import { getPasskeyAssertion, passkeyFailure, passkeyFailureMessage, passkeySupport } from "@/lib/webauthn";
import { useAuthStore } from "@/stores/session";

/**
 * A money step-up (INTEGRATION.md override 8): one single-use grant for one
 * action, bound to the action's hash (`bind`). The proof is the strongest
 * the account has, as the API requires:
 * - a passkey with user verification (PASSKEY);
 * - the password plus an authenticator or backup code (TOTP);
 * - only for an account with neither, the password plus a 6-digit code
 *   emailed for this session, purpose and action (PASSWORD_EMAIL).
 * The password alone never authorises money. The grant is handed to the
 * caller, which spends it on the wallet route within 5 minutes.
 */
export interface MoneyStepUpRequest {
  purpose: StepUpPurpose;
  /** Lower-case hex SHA-256 of the canonical action (the caller has checked it against what it shows). */
  bind: string;
  /** The methods the wallet route named (STEP_UP_REQUIRED or the quote); the purpose's own list when absent. */
  methods?: readonly StepUpGrantMethod[];
  /** Completes "To {action}, confirm it's you", e.g. "withdraw €20.00 to Visa •••• 4242". */
  action: string;
}

type Mode = "totp" | "passkey" | "email" | "none";

function fail(err: unknown): string {
  const wait = retryAfterSeconds(err);
  if (wait !== null) return `Too many attempts. Try again in ${wait} s.`;
  if (!(err instanceof ApiError)) return messageOf(err);
  switch (err.code) {
    case undefined:
      return err.status === 401 ? "That password isn't right." : messageOf(err);
    case "MFA_INVALID": return "That code didn't work.";
    case "EMAIL_CODE_INVALID": {
      const left = err.details.attemptsRemaining;
      return typeof left === "number" ? `That code isn't right. ${left} ${left === 1 ? "attempt" : "attempts"} left.` : "That code isn't right.";
    }
    case "CHALLENGE_INVALID": return "This confirmation expired. Start again.";
    case "SECURITY_HOLD": return securityHoldText(typeof err.details.until === "string" ? err.details.until : null);
    case "EMAIL_NOT_VERIFIED": return "Confirm your email address first.";
    case "EMAIL_MISSING": return "Add an email address to your account first.";
    case "MAIL_UNAVAILABLE": return "We can't send email right now. Try again later.";
    case "PASSKEY_INVALID": return "That passkey isn't on this account.";
    case "NO_PASSKEYS": return "There's no passkey on this account.";
    case "PASSKEYS_UNAVAILABLE": return "Passkeys aren't available right now.";
    case "SECURITY_NOT_CONFIGURED": return "Confirmation isn't available right now. Try again later.";
    default: return messageOf(err);
  }
}

export function MoneyStepUpDialog({ request, onGranted, onCancel }: {
  request: MoneyStepUpRequest;
  onGranted: (grant: StepUpGrantResponse) => void;
  onCancel: () => void;
}) {
  const { security, error: securityError, reload } = useAccountSecurity();
  const user = useAuthStore((s) => s.user);
  const config = useAuthConfig();
  const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [emailChallenge, setEmailChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passkeyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void passkeySupport().then((support) => { if (live) setPasskeyReady(support.supported); });
    return () => { live = false; };
  }, []);

  // The security overview is the authority on the account's factors; the session's copy is the fallback.
  const totpOn = security ? security.totp.enabled : user?.twoFactorEnabled;
  const passkeys = security ? security.passkeys.length : user?.passkeyCount;
  const known = totpOn !== undefined && passkeys !== undefined;
  const allowed = request.methods && request.methods.length > 0 ? request.methods : STEP_UP_METHODS_BY_PURPOSE[request.purpose];
  const canPasskey = allowed.includes("PASSKEY") && (passkeys ?? 0) > 0 && config?.passkeysEnabled !== false && passkeyReady === true;
  const canTotp = allowed.includes("TOTP") && totpOn === true;
  const canEmail = allowed.includes("PASSWORD_EMAIL") && totpOn === false && passkeys === 0;
  const mode: Mode = canTotp ? "totp" : canPasskey ? "passkey" : canEmail ? "email" : "none";
  const ready = known && passkeyReady !== null;

  useEffect(() => {
    if (!ready) return;
    (mode === "passkey" ? passkeyRef : passwordRef).current?.focus();
  }, [ready, mode]);

  const grant = async (proof: Parameters<typeof requestStepUpGrant>[0]["proof"]) => {
    const result = await requestStepUpGrant({ purpose: request.purpose, bind: request.bind, proof });
    onGranted(result);
  };

  async function confirmWithPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { options, challengeToken } = await reauthPasskeyOptions({ purpose: request.purpose, bind: request.bind });
      const credential = await getPasskeyAssertion(options);
      await grant({ kind: "passkey", challengeToken, credential });
    } catch (err) {
      if (err instanceof ApiError) setError(fail(err));
      else {
        const message = passkeyFailureMessage(passkeyFailure(err));
        if (message) setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(value = code) {
    if (busy || !password || !value) return;
    setBusy(true);
    setError(null);
    try {
      await grant({ kind: "totp", password, code: value.trim() });
    } catch (err) {
      setCode("");
      if (err instanceof ApiError && err.status === 401 && !err.code) { setPassword(""); focusSoon(passwordRef); } else focusSoon(codeRef);
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode() {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sent = await requestStepUpEmailCode({ purpose: request.purpose, bind: request.bind });
      setEmailChallenge(sent.emailChallengeToken);
      setCode("");
      setNotice(`We emailed you a ${STEP_UP_EMAIL_CODE_DIGITS}-digit code. It works for 10 minutes, for this request only.`);
      focusSoon(codeRef);
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail(value = code) {
    if (busy || !password || !emailChallenge || value.length !== STEP_UP_EMAIL_CODE_DIGITS) return;
    setBusy(true);
    setError(null);
    try {
      await grant({ kind: "password_email", password, emailCode: value, emailChallengeToken: emailChallenge });
    } catch (err) {
      setCode("");
      if (errorCode(err) === "CHALLENGE_INVALID") { setEmailChallenge(null); setNotice(null); }
      if (err instanceof ApiError && err.status === 401 && !err.code) { setPassword(""); focusSoon(passwordRef); } else focusSoon(codeRef);
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }

  const actions = (submitLabel: string, disabled: boolean) => (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" busy={busy} disabled={busy || disabled}>{submitLabel}</Button>
    </div>
  );

  return (
    <ModalDialog
      title="Confirm it's you"
      description={<p>To {request.action}, confirm it&apos;s you. This confirmation works once, for this request only.</p>}
      onClose={onCancel}
      dismissible={!busy}
      initialFocusRef={mode === "passkey" ? passkeyRef : passwordRef}
    >
      {!ready ? (
        securityError && !known ? (
          <div className="flex flex-col gap-3">
            <Notice tone="error">{securityError}</Notice>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button onClick={() => void reload()}>Try again</Button>
            </div>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Checking how you can confirm…</p>
        )
      ) : mode === "totp" ? (
        <form onSubmit={(event) => { event.preventDefault(); void submitTotp(); }} className="flex flex-col gap-4" noValidate>
          <PasswordField ref={passwordRef} id="money-step-up-password" label="Password" autoComplete="current-password"
            value={password} onChange={setPassword} disabled={busy} />
          {backup ? (
            <TextField ref={codeRef} id="money-step-up-backup" label="Backup code" hint="Each backup code works once." value={code}
              autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={16} disabled={busy}
              onChange={(event) => setCode(event.target.value)} />
          ) : (
            <OtpInput ref={codeRef} id="money-step-up-code" label="Code from your authenticator app" value={code} onChange={setCode}
              onComplete={(value) => { if (password) void submitTotp(value); }} disabled={busy} />
          )}
          <button type="button" className="self-start text-sm text-amber-100 underline underline-offset-4"
            onClick={() => { setBackup(!backup); setCode(""); setError(null); }}>
            {backup ? "Use your authenticator app" : "Use a backup code instead"}
          </button>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {actions("Confirm", !password || !code)}
          {canPasskey ? (
            <Button ref={passkeyRef} variant="secondary" onClick={() => void confirmWithPasskey()} disabled={busy}>Use a passkey instead</Button>
          ) : null}
        </form>
      ) : mode === "passkey" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-emerald-50">Use the passkey on this device (fingerprint, face or screen lock).</p>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button ref={passkeyRef} busy={busy} disabled={busy} onClick={() => void confirmWithPasskey()}>Confirm with a passkey</Button>
          </div>
        </div>
      ) : mode === "email" ? (
        <form onSubmit={(event) => { event.preventDefault(); if (emailChallenge) void submitEmail(); else void sendEmailCode(); }}
          className="flex flex-col gap-4" noValidate>
          <PasswordField ref={passwordRef} id="money-step-up-password" label="Password" autoComplete="current-password"
            value={password} onChange={setPassword} disabled={busy} />
          {emailChallenge ? (
            <>
              <OtpInput ref={codeRef} id="money-step-up-email-code" label="Code from the email" length={STEP_UP_EMAIL_CODE_DIGITS}
                value={code} onChange={setCode} onComplete={(value) => { if (password) void submitEmail(value); }} disabled={busy} />
              <button type="button" className="self-start text-sm text-amber-100 underline underline-offset-4" disabled={busy}
                onClick={() => void sendEmailCode()}>
                Send a new code
              </button>
            </>
          ) : (
            <p className="text-sm text-emerald-50">
              We&apos;ll email you a code to confirm. Turn on two-step verification or add a passkey to confirm without email.
            </p>
          )}
          {notice ? <Notice tone="info">{notice}</Notice> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {emailChallenge ? actions("Confirm", !password || code.length !== STEP_UP_EMAIL_CODE_DIGITS) : actions("Email me a code", !password)}
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <Notice tone="warning" live={false}>
            {(passkeys ?? 0) > 0
              ? "Confirm with your passkey on a device and browser that support passkeys, or turn on two-step verification."
              : "This account can't confirm payments yet."}{" "}
            <Link href="/account/security" className="underline underline-offset-4">Account &amp; security</Link>
          </Notice>
          <div className="flex justify-end"><Button variant="secondary" onClick={onCancel}>Close</Button></div>
        </div>
      )}
    </ModalDialog>
  );
}
