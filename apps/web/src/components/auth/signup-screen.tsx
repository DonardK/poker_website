"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgeTermsGate, hasConsent, NO_CONSENT, type AgeTermsConsent } from "@/components/age-terms-gate";
import { AuthTabs } from "@/components/auth/auth-tabs";
import { PasswordField } from "@/components/auth/password-field";
import { useAuthEntryRedirect } from "@/components/auth/use-auth-entry-redirect";
import { TurnstileWidget, needsTurnstileToken, turnstileTokenField } from "@/components/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { TextField } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api";
import { errorCode, isUnavailable, messageOf, register, retryAfterSeconds } from "@/lib/auth-api";
import { focusSoon } from "@/lib/focus";
import { PLAY_CHIPS_NOTICE, PLAY_MONEY_NOTICE, termsAcceptance, termsErrorMessage } from "@/lib/legal";
import { loadedStrengthEstimator, MIN_ACCEPTED_SCORE, passwordRuleProblem } from "@/lib/password-strength";
import { completeSignIn } from "@/lib/session-actions";

const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Field = "username" | "email" | "password";
type FieldErrors = Partial<Record<Field, string>>;

/** Words that make a password guessable on this site, for the strength estimate. */
function siteWords(username: string, email: string): string[] {
  return [username, email.split("@")[0] ?? "", "holdem", "poker", "holdemlive"].filter((word) => word.length >= 3);
}

/**
 * Create an account: username, email, password (with a strength meter),
 * "Stay signed in", the 18+ and terms boxes (both unticked; the button stays
 * disabled until both are ticked, COMPLIANCE D10) and the browser check. Two-
 * step verification is offered right after, on /welcome; it is recommended,
 * never forced (owner decision).
 */
export function SignupScreen({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [consent, setConsent] = useState<AgeTermsConsent>(NO_CONSENT);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const refs = {
    username: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  const redirecting = useAuthEntryRedirect({ next, paused: completing });
  const needsToken = needsTurnstileToken(turnstileToken);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!USERNAME.test(username)) errors.username = "Use 3–24 letters, numbers or underscores.";
    if (email.length > 254 || !EMAIL.test(email)) errors.email = "Enter a valid email address.";
    const rule = passwordRuleProblem(password, username);
    if (rule) errors.password = rule;
    else {
      // Once the estimator has loaded, a password it rates as easy to guess is refused here too (the server checks breaches).
      const estimate = loadedStrengthEstimator();
      if (estimate && estimate(password, siteWords(username, email)).score < MIN_ACCEPTED_SCORE) {
        errors.password = "This password is too easy to guess. Add another word or two.";
      }
    }
    return errors;
  }

  function focusFirst(errors: FieldErrors) {
    const first = (["username", "email", "password"] as const).find((field) => errors[field]);
    if (first) refs[first].current?.focus();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !hasConsent(consent) || needsToken) return;
    const errors = validate();
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length > 0) {
      focusFirst(errors);
      return;
    }
    setBusy(true);
    try {
      const data = await register({
        username, email, password, remember, ...termsAcceptance(), ...turnstileTokenField(turnstileToken),
      });
      setCompleting(true);
      const welcome = next !== "/" ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome";
      completeSignIn(data, { remember, next: welcome, router });
    } catch (err) {
      setTurnstileResetKey((key) => key + 1);
      const terms = termsErrorMessage(err);
      const code = errorCode(err);
      const wait = retryAfterSeconds(err);
      if (terms) setError(terms);
      else if (err instanceof ApiError && err.status === 409 && err.message === "Username unavailable") {
        setFieldErrors({ username: "That username is taken. Try another." });
        focusSoon(refs.username);
      } else if (err instanceof ApiError && err.status === 400 && !code && /username/i.test(err.message)) {
        setFieldErrors({ username: err.message });
        focusSoon(refs.username);
      } else if (code === "PASSWORD_BREACHED" || code === "PASSWORD_WEAK") {
        setFieldErrors({ password: code === "PASSWORD_BREACHED"
          ? "This password has appeared in a data breach. Choose a different one."
          : messageOf(err, "Choose a password that doesn't contain your username.") });
        focusSoon(refs.password);
      } else if (code === "TURNSTILE_FAILED") setError("We couldn't verify this browser. Try again.");
      else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else if (isUnavailable(err)) setError(messageOf(err));
      else setError(messageOf(err, "Your account could not be created. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (redirecting || completing) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-4">
        <Spinner />
        <p role="status" className="text-emerald-50">{completing ? "Creating your account…" : "Signing you in…"}</p>
      </div>
    );
  }

  const emailLocal = email.split("@")[0] ?? "";
  return (
    <div className="flex flex-col gap-5">
      <AuthTabs active="signup" next={next} />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl">Create your account</h1>
        <p className="mt-2 text-sm text-emerald-50">One account keeps your play chips, seat and hand history, on any device.</p>
      </header>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" aria-label="Create your account">
        <TextField ref={refs.username} id="username" label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false}
          maxLength={24} hint="3–24 letters, numbers or underscores. Shown at the table." value={username} disabled={busy}
          error={fieldErrors.username} onChange={(event) => setUsername(event.target.value)} />
        <TextField ref={refs.email} id="email" type="email" label="Email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          maxLength={254} hint="For sign-in alerts and account recovery. Never shown to other players." value={email} disabled={busy}
          error={fieldErrors.email} onChange={(event) => setEmail(event.target.value)} />
        <PasswordField ref={refs.password} id="new-password" label="Password" autoComplete="new-password" value={password}
          onChange={setPassword} disabled={busy} error={fieldErrors.password} withStrength
          userInputs={[username, emailLocal, "holdem", "poker"]} />
        <Checkbox id="stay-signed-in" label="Stay signed in on this device" hint="Untick on a shared computer."
          checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
        <AgeTermsGate value={consent} onChange={setConsent} disabled={busy} />
        <TurnstileWidget action="signup" resetKey={turnstileResetKey} onToken={setTurnstileToken} />
        {needsToken ? <p className="text-xs text-emerald-50/90" role="status">Checking your browser…</p> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" busy={busy} disabled={busy || !hasConsent(consent) || needsToken}>Create account</Button>
      </form>
      <p className="text-sm text-emerald-50">{PLAY_MONEY_NOTICE}. {PLAY_CHIPS_NOTICE}</p>
      <p className="text-sm text-emerald-50">
        Already have an account?{" "}
        <Link href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="font-semibold text-amber-100 underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}
