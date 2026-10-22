"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PasswordField } from "@/components/auth/password-field";
import { TurnstileWidget, needsTurnstileToken, turnstileTokenField } from "@/components/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { TextField } from "@/components/ui/text-field";
import { broadcastSignedOut } from "@/lib/api";
import { errorCode, forgotPassword, isUnavailable, messageOf, resetPassword, retryAfterSeconds } from "@/lib/auth-api";
import { focusSoon } from "@/lib/focus";
import { takeFragmentToken } from "@/lib/fragment-token";
import { loadedStrengthEstimator, MIN_ACCEPTED_SCORE, passwordRuleProblem } from "@/lib/password-strength";
import { clearPendingLogout } from "@/lib/pending-logout";
import { resetClientState } from "@/lib/session-actions";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_AFTER_S = 60;

/** Signed out everywhere by a password reset: this tab and the others drop the (already revoked) session. */
export function afterPasswordReset(): void {
  clearPendingLogout();
  resetClientState();
  broadcastSignedOut("logout");
}

/** "Choose a new password" with a single-use reset token (from the email, or from "This wasn't me"). */
export function NewPasswordForm({ token, intro, onInvalidToken }: { token: string; intro?: React.ReactNode; onInvalidToken: () => void }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const rule = passwordRuleProblem(password);
    const estimate = loadedStrengthEstimator();
    const weak = !rule && estimate && estimate(password, ["holdem", "poker"]).score < MIN_ACCEPTED_SCORE;
    const problem = rule ?? (weak ? "This password is too easy to guess. Add another word or two." : null);
    setFieldError(problem);
    if (problem) { inputRef.current?.focus(); return; }
    setBusy(true);
    try {
      await resetPassword({ token, newPassword: password });
      setDone(true);
      afterPasswordReset();
      // No automatic sign-in: signing in fresh also lets the password manager save the new password.
      router.replace("/login?notice=reset");
    } catch (err) {
      const code = errorCode(err);
      const wait = retryAfterSeconds(err);
      if (code === "TOKEN_INVALID") onInvalidToken();
      else if (code === "PASSWORD_BREACHED") { setFieldError("This password has appeared in a data breach. Choose a different one."); focusSoon(inputRef); }
      else if (code === "PASSWORD_WEAK") { setFieldError(messageOf(err)); focusSoon(inputRef); }
      else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else setError(messageOf(err, "Your password could not be changed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p role="status" className="flex items-center gap-3 text-emerald-50"><Spinner className="h-5 w-5" /> Password changed. Taking you to sign in…</p>;
  }
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" aria-label="Choose a new password">
      {intro}
      <PasswordField ref={inputRef} id="reset-new-password" label="New password" autoComplete="new-password" value={password}
        onChange={setPassword} error={fieldError} disabled={busy} withStrength userInputs={["holdem", "poker"]} />
      <Notice tone="info" live={false}>
        You&apos;ll be signed out on every device. If you use two-step verification, you&apos;ll still need your code to sign in.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" busy={busy} disabled={busy}>Set new password</Button>
    </form>
  );
}

function RequestForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const needsToken = needsTurnstileToken(turnstileToken);

  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [resendAt]);
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy || needsToken || wait > 0) return;
    const value = email.trim();
    if (value.length > 254 || !EMAIL.test(value)) {
      setFieldError("Enter the email address on your account.");
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      await forgotPassword({ email: value, ...turnstileTokenField(turnstileToken) });
      // The same answer whether or not an account uses this address (no account enumeration).
      setSentTo(value);
      setResendAt(Date.now() + RESEND_AFTER_S * 1000);
      setNow(Date.now());
    } catch (err) {
      const retry = retryAfterSeconds(err);
      if (errorCode(err) === "TURNSTILE_FAILED") setError("We couldn't verify this browser. Try again.");
      else if (retry !== null) setError(`Too many requests. Try again in ${retry} s.`);
      else if (isUnavailable(err)) setError(messageOf(err));
      else setError(messageOf(err, "The reset link could not be sent. Try again."));
    } finally {
      setBusy(false);
      setTurnstileResetKey((key) => key + 1);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" aria-label="Reset your password">
      <p className="text-sm text-emerald-50">Enter your account&apos;s email and we&apos;ll send you a link to choose a new password.</p>
      <TextField ref={inputRef} id="reset-email" type="email" label="Email" autoComplete="email" autoCapitalize="none" spellCheck={false}
        maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={fieldError} disabled={busy} />
      <TurnstileWidget action="forgot" resetKey={turnstileResetKey} onToken={setTurnstileToken} />
      {needsToken ? <p className="text-xs text-emerald-50/90" role="status">Checking your browser…</p> : null}
      {sentTo ? (
        <Notice tone="success">
          If an account uses <strong className="break-all">{sentTo}</strong>, we&apos;ve sent it a link. It expires in 30 minutes. The email
          also reminds you of your username.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" busy={busy} disabled={busy || needsToken || wait > 0}>
        {sentTo ? (wait > 0 ? `Send again in ${wait} s` : "Send again") : "Email me a reset link"}
      </Button>
      <p className="text-sm text-emerald-50">
        Remembered it? <Link href="/login" className="font-semibold text-amber-100 underline underline-offset-4">Sign in</Link>
      </p>
    </form>
  );
}

/**
 * /reset-password: without a token, ask for a reset link; with #t=<token>
 * (stripped from the address bar at once), choose the new password. The
 * reset signs out every session and does not sign in; two-step verification
 * still applies at the next sign-in.
 */
export function ResetPasswordScreen() {
  const [mode, setMode] = useState<{ kind: "loading" } | { kind: "request"; expired: boolean } | { kind: "set"; token: string }>({ kind: "loading" });
  useEffect(() => {
    const token = takeFragmentToken();
    setMode(token ? { kind: "set", token } : { kind: "request", expired: false });
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">{mode.kind === "set" ? "Choose a new password" : "Reset your password"}</h1>
      {mode.kind === "request" && mode.expired ? (
        <Notice tone="error">This link is invalid or has expired. Ask for a new one below.</Notice>
      ) : null}
      {mode.kind === "loading" ? <Spinner className="h-6 w-6" /> : null}
      {mode.kind === "request" ? <RequestForm /> : null}
      {mode.kind === "set" ? <NewPasswordForm token={mode.token} onInvalidToken={() => setMode({ kind: "request", expired: true })} /> : null}
    </div>
  );
}
