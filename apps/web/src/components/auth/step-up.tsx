"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MfaChallenge, ReauthMethod, SecondFactorMethod, StepUpResult } from "@poker/shared";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { OtpInput } from "@/components/ui/otp-input";
import { TextField } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api";
import { errorCode, messageOf, reauthMfa, reauthPassword, reauthPasskey, reauthPasskeyOptions, retryAfterSeconds } from "@/lib/auth-api";
import { useAuthConfig } from "@/lib/auth-config";
import { focusSoon } from "@/lib/focus";
import { getPasskeyAssertion, passkeyFailure, passkeyFailureMessage, passkeySupport } from "@/lib/webauthn";

/**
 * Step-up for account changes ("Confirm it's you"). Sensitive routes answer
 * 403 REAUTH_REQUIRED { methods, needs? } when the session's step-up window
 * (5 minutes after a sign-in or a re-auth, server-side) has passed. The
 * dialog proves it again with the password (then the second factor when the
 * account has TOTP), or a passkey, and the original request is retried once.
 * Cancelling rejects with StepUpCancelled, which callers ignore silently.
 */
export class StepUpCancelled extends Error {
  constructor() {
    super("Step-up cancelled");
    this.name = "StepUpCancelled";
  }
}

export function isStepUpCancelled(err: unknown): err is StepUpCancelled {
  return err instanceof StepUpCancelled;
}

/** The password step-up answers an MFA challenge instead of opening the window when the account has TOTP. */
function needsSecondFactor(result: StepUpResult | MfaChallenge): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

function isReauthRequired(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 403 && err.code === "REAUTH_REQUIRED";
}

interface Request {
  action: string;
  methods: ReauthMethod[];
  /** "password": only the password counts (a password change). */
  needs?: "password" | "second_factor";
  /** Start at the code step (the password was already accepted). */
  challenge?: MfaChallenge;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface StepUpApi {
  /** Run `fn`; on REAUTH_REQUIRED confirm the user's identity, then run it once more. */
  withStepUp: <T>(fn: () => Promise<T>, opts: { action: string }) => Promise<T>;
  /**
   * Step up with a password the page already collected (password change): the
   * server checks it now, and the dialog opens only for the second factor.
   */
  stepUpWithPassword: (password: string, opts: { action: string }) => Promise<void>;
}

const StepUpContext = createContext<StepUpApi | null>(null);

export function useStepUp(): StepUpApi {
  const api = useContext(StepUpContext);
  if (!api) throw new Error("useStepUp needs a StepUpProvider");
  return api;
}

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);

  const ask = useCallback((input: Omit<Request, "resolve" | "reject">) => new Promise<void>((resolve, reject) => {
    setRequest({ ...input, resolve, reject });
  }), []);

  const withStepUp = useCallback(async <T,>(fn: () => Promise<T>, opts: { action: string }): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!isReauthRequired(err)) throw err;
      const methods = Array.isArray(err.details.methods)
        ? (err.details.methods as unknown[]).filter((m): m is ReauthMethod => m === "password" || m === "passkey")
        : ["password" as const];
      const needs = err.details.needs === "password" || err.details.needs === "second_factor" ? err.details.needs : undefined;
      await ask({ action: opts.action, methods: methods.length ? methods : ["password"], needs });
      return fn();
    }
  }, [ask]);

  const stepUpWithPassword = useCallback(async (password: string, opts: { action: string }) => {
    const result = await reauthPassword(password);
    if (needsSecondFactor(result)) await ask({ action: opts.action, methods: ["password"], needs: "password", challenge: result });
  }, [ask]);

  const finish = (outcome: "done" | "cancel") => {
    const current = request;
    setRequest(null);
    if (!current) return;
    if (outcome === "done") current.resolve(); else current.reject(new StepUpCancelled());
  };

  return (
    <StepUpContext.Provider value={{ withStepUp, stepUpWithPassword }}>
      {children}
      {request ? <ReauthDialog request={request} onDone={() => finish("done")} onCancel={() => finish("cancel")} /> : null}
    </StepUpContext.Provider>
  );
}

function ReauthDialog({ request, onDone, onCancel }: { request: Request; onDone: () => void; onCancel: () => void }) {
  const [challenge, setChallenge] = useState<MfaChallenge | null>(request.challenge ?? null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<SecondFactorMethod>("totp");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyReady, setPasskeyReady] = useState(false);
  const config = useAuthConfig();
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const allowPasskey = request.methods.includes("passkey") && request.needs !== "password" && config?.passkeysEnabled === true;

  useEffect(() => {
    if (!allowPasskey) return;
    let live = true;
    void passkeySupport().then((support) => { if (live) setPasskeyReady(support.supported); });
    return () => { live = false; };
  }, [allowPasskey]);

  useEffect(() => {
    (challenge ? codeRef : passwordRef).current?.focus();
  }, [challenge, method]);

  const fail = (err: unknown) => {
    const wait = retryAfterSeconds(err);
    if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
    else if (err instanceof ApiError && err.status === 401 && !err.code) setError("That password isn't right.");
    else if (errorCode(err) === "MFA_INVALID") setError("That code didn't work.");
    else if (errorCode(err) === "MFA_TICKET_INVALID") {
      setChallenge(null);
      setCode("");
      setError("That took too long. Enter your password again.");
    } else setError(messageOf(err));
  };

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reauthPassword(password);
      setPassword("");
      if (needsSecondFactor(result)) setChallenge(result);
      else onDone();
    } catch (err) {
      setPassword("");
      fail(err);
      focusSoon(passwordRef);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(value = code) {
    if (busy || !challenge || !value) return;
    setBusy(true);
    setError(null);
    try {
      await reauthMfa({ mfaTicket: challenge.mfaTicket, method, code: value });
      onDone();
    } catch (err) {
      setCode("");
      fail(err);
      focusSoon(codeRef);
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { options, challengeToken } = await reauthPasskeyOptions();
      const credential = await getPasskeyAssertion(options);
      await reauthPasskey({ challengeToken, credential });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code === "NO_PASSKEYS" ? "There's no passkey on this account. Use your password." : err.code === "PASSKEY_INVALID"
          ? "That passkey isn't on this account." : messageOf(err));
      } else {
        const message = passkeyFailureMessage(passkeyFailure(err));
        if (message) setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      title="Confirm it's you"
      description={<p>For your security, confirm your identity to {request.action}.</p>}
      onClose={onCancel}
      dismissible={!busy}
      initialFocusRef={challenge ? codeRef : passwordRef}
    >
      {challenge ? (
        <form onSubmit={(event) => { event.preventDefault(); void submitCode(); }} className="flex flex-col gap-4" noValidate>
          {method === "totp" ? (
            <OtpInput ref={codeRef} id="reauth-code" label="Code from your authenticator app" value={code} onChange={setCode}
              onComplete={(value) => void submitCode(value)} disabled={busy} />
          ) : (
            <TextField ref={codeRef} id="reauth-backup-code" label="Backup code" hint="Each backup code works once." value={code}
              autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={16} disabled={busy}
              onChange={(event) => setCode(event.target.value)} />
          )}
          <button type="button" className="self-start text-sm text-amber-100 underline underline-offset-4"
            onClick={() => { setMethod(method === "totp" ? "backup_code" : "totp"); setCode(""); setError(null); }}>
            {method === "totp" ? "Use a backup code instead" : "Use your authenticator app"}
          </button>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={busy || !code}>Confirm</Button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => void submitPassword(event)} className="flex flex-col gap-4" noValidate>
          <PasswordField ref={passwordRef} id="reauth-password" label="Password" autoComplete="current-password"
            value={password} onChange={setPassword} disabled={busy} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={busy || !password}>Confirm</Button>
          </div>
          {allowPasskey && passkeyReady ? (
            <Button variant="secondary" onClick={() => void confirmWithPasskey()} disabled={busy}>Use a passkey instead</Button>
          ) : null}
        </form>
      )}
    </ModalDialog>
  );
}
