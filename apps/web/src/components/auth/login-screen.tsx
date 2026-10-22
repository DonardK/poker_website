"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  isMfaChallenge, LOGIN_IDENTIFIER_MAX_LENGTH, type AuthResponse, type MfaChallenge, type SecondFactorMethod,
} from "@poker/shared";
import { AccountChooser } from "@/components/auth/account-chooser";
import { AuthTabs } from "@/components/auth/auth-tabs";
import { passkeySignIn, passkeySignInError } from "@/components/auth/passkey-sign-in";
import { PasswordField } from "@/components/auth/password-field";
import { SecondFactorStep } from "@/components/auth/second-factor-step";
import { useAuthEntryRedirect } from "@/components/auth/use-auth-entry-redirect";
import { usePasskeySupport } from "@/components/auth/use-passkey-support";
import { Avatar } from "@/components/shell/avatar";
import { TurnstileWidget, needsTurnstileToken, turnstileTokenField } from "@/components/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FingerprintIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { TextField } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api";
import { completeMfaLogin, errorCode, login, messageOf, retryAfterSeconds } from "@/lib/auth-api";
import { focusSoon } from "@/lib/focus";
import {
  forgetAccount, forgetAllAccounts, readRememberedAccounts, subscribeRememberedAccounts, type RememberedAccount,
} from "@/lib/remembered-accounts";
import { completeSignIn, signOut } from "@/lib/session-actions";
import { cancelPasskeyCeremony } from "@/lib/webauthn";
import { useAuthStore } from "@/stores/session";

type Step =
  | { kind: "choose" }
  | { kind: "credentials"; identifier: string; locked: boolean }
  | { kind: "second-factor"; identifier: string; challenge: MfaChallenge; method: SecondFactorMethod }
  | { kind: "finishing" };

interface UiError {
  message: string;
  link?: { href: string; label: string };
}

export interface LoginScreenProps {
  /** Where to go after signing in (validated by safeNext). */
  next: string;
  /** Prefill this username (?as=). */
  as: string | null;
  /** Arrived from "Switch account" (?switch=1). */
  switching: boolean;
  /** A message from the page that sent the visitor here (?notice=). */
  notice: string | null;
}

/**
 * Sign in: remembered accounts → username or email and password → second
 * factor when the account has TOTP. Passkeys work at every step: offered in
 * the username field's autofill (conditional mediation) and by a button.
 *
 * SECURITY: every wrong-credential answer reads the same (no account
 * enumeration), the password field is cleared after a refusal, and a Turnstile
 * token is never sent twice (G1/G2).
 */
export function LoginScreen({ next, as, switching, notice }: LoginScreenProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const signOutNotice = useAuthStore((s) => s.signOutNotice);
  const passkeys = usePasskeySupport();
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "credentials", identifier: as ?? "", locked: false });
  const [remembered, setRemembered] = useState<RememberedAccount[]>([]);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [completing, setCompleting] = useState(false);
  const [conditionalKey, setConditionalKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const firstStep = useRef(true);

  const redirecting = useAuthEntryRedirect({ next, paused: completing || switching });

  // The first step depends on this device's remembered accounts (client only).
  useEffect(() => {
    const accounts = readRememberedAccounts();
    setRemembered(accounts);
    const known = as ? accounts.find((a) => a.username.toLowerCase() === as.toLowerCase()) : undefined;
    if (as) setStep({ kind: "credentials", identifier: known?.username ?? as, locked: Boolean(known) });
    else if (accounts.length > 0) setStep({ kind: "choose" });
    setMounted(true);
    return subscribeRememberedAccounts(() => setRemembered(readRememberedAccounts()));
  }, [as]);

  // Nothing left to choose from: straight to the form.
  useEffect(() => {
    if (step.kind === "choose" && mounted && remembered.length === 0) setStep({ kind: "credentials", identifier: "", locked: false });
  }, [step.kind, remembered.length, mounted]);

  // Each new step moves focus to its heading (not on the first render: the page's own order applies there).
  useEffect(() => {
    if (!mounted) return;
    if (firstStep.current) { firstStep.current = false; return; }
    if (step.kind === "credentials" && step.locked) passwordRef.current?.focus();
    else headingRef.current?.focus();
  }, [step.kind, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rate-limit countdown on the submit button.
  useEffect(() => {
    if (retryAt === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= retryAt) setRetryAt(null);
    }, 1_000);
    return () => window.clearInterval(id);
  }, [retryAt]);
  const waitSeconds = retryAt !== null ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;

  const finish = useCallback((data: AuthResponse) => {
    setCompleting(true);
    setStep({ kind: "finishing" });
    completeSignIn(data, { remember: rememberRef.current, next, router });
  }, [next, router]);

  // Passkeys in the username field's autofill, while the form is waiting for a username.
  const awaitingIdentifier = step.kind === "credentials" && !step.locked;
  useEffect(() => {
    if (!mounted || !awaitingIdentifier || !hydrated || user || !passkeys?.enabled || !passkeys.autofill) return;
    let live = true;
    void passkeySignIn({ remember: () => rememberRef.current, autofill: true, cancelled: () => !live })
      .then((data) => { if (live) finish(data); })
      .catch((err: unknown) => {
        if (!live) return;
        // Quiet unless the person actually picked a passkey and the site refused it: the autofill offer itself
        // failing (no passkeys on this address, an IP-address host, a browser quirk) is not their problem.
        if (err instanceof ApiError && err.code === "PASSKEY_INVALID") setError({ message: passkeySignInError(err) ?? err.message });
        // An expired autofill request is renewed quietly.
        if (err instanceof ApiError && err.code === "CHALLENGE_INVALID") setConditionalKey((k) => k + 1);
      });
    return () => { live = false; cancelPasskeyCeremony(); };
  }, [mounted, awaitingIdentifier, hydrated, user, passkeys?.enabled, passkeys?.autofill, conditionalKey, finish]);

  function backToCredentials(identifier: string, message: string | null) {
    const locked = remembered.some((a) => a.username.toLowerCase() === identifier.toLowerCase()) && step.kind !== "credentials";
    setStep({ kind: "credentials", identifier, locked });
    setPassword("");
    setError(message ? { message } : null);
  }

  function loginError(err: unknown): UiError {
    const wait = retryAfterSeconds(err);
    if (wait !== null) {
      setRetryAt(Date.now() + wait * 1000);
      setNow(Date.now());
      return { message: "Too many attempts. Wait a moment, then try again." };
    }
    const code = errorCode(err);
    if (err instanceof ApiError && err.status === 401) return { message: "That username or email and password don't match." };
    if (code === "TURNSTILE_FAILED") return { message: "We couldn't verify this browser. Try again." };
    if (code === "PASSWORD_RESET_REQUIRED") {
      return {
        message: "For your security, set a new password before signing in.",
        link: { href: "/reset-password", label: "Set a new password" },
      };
    }
    if (code === "SECURITY_NOT_CONFIGURED") return { message: "Two-step sign-in is unavailable right now. Try again later." };
    return { message: messageOf(err, "Sign-in failed. Try again.") };
  }

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (step.kind !== "credentials" || busy || waitSeconds > 0 || needsTurnstileToken(turnstileToken)) return;
    const identifier = step.identifier.trim();
    if (!identifier) {
      setError({ message: "Enter your username or email." });
      identifierRef.current?.focus();
      return;
    }
    if (!password) {
      setError({ message: "Enter your password." });
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await login({ identifier, password, remember, ...turnstileTokenField(turnstileToken) });
      if (isMfaChallenge(result)) {
        setPassword("");
        setTurnstileResetKey((k) => k + 1);
        setStep({ kind: "second-factor", identifier, challenge: result, method: result.methods.includes("totp") ? "totp" : "backup_code" });
      } else {
        finish(result);
      }
    } catch (err) {
      setTurnstileResetKey((k) => k + 1);
      const ui = loginError(err);
      setError(ui);
      if (err instanceof ApiError && err.status === 401) {
        setPassword("");
        focusSoon(passwordRef);
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitSecondFactor(method: SecondFactorMethod, code: string): Promise<boolean> {
    if (step.kind !== "second-factor") return false;
    setBusy(true);
    setError(null);
    try {
      const data = await completeMfaLogin({ mfaTicket: step.challenge.mfaTicket, method, code, remember });
      finish(data);
      return true;
    } catch (err) {
      const wait = retryAfterSeconds(err);
      if (errorCode(err) === "MFA_TICKET_INVALID") {
        backToCredentials(step.identifier, "This sign-in timed out. Enter your password again.");
      } else if (wait !== null) {
        setError({ message: `Too many wrong codes. Try again in ${wait} s.` });
      } else if (errorCode(err) === "MFA_INVALID") {
        const left = err instanceof ApiError && typeof err.details.attemptsRemaining === "number" ? err.details.attemptsRemaining : null;
        setError({ message: `That code didn't work.${left !== null ? ` ${left} ${left === 1 ? "attempt" : "attempts"} left.` : ""}` });
      } else {
        setError({ message: messageOf(err, "Verification failed. Try again.") });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      finish(await passkeySignIn({ remember: () => rememberRef.current }));
    } catch (err) {
      const message = passkeySignInError(err);
      if (message) setError({ message });
    } finally {
      setBusy(false);
      // The button's ceremony replaced the autofill one: offer autofill again.
      setConditionalKey((k) => k + 1);
    }
  }

  const passkeyButton = passkeys?.enabled ? (
    <Button variant="secondary" onClick={() => void signInWithPasskey()} disabled={busy} className="w-full">
      <FingerprintIcon /> Sign in with a passkey
    </Button>
  ) : null;

  if (redirecting || step.kind === "finishing") {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-4">
        <Spinner />
        <p role="status" className="text-emerald-50">Signing you in…</p>
      </div>
    );
  }

  if (switching && hydrated && user) {
    return (
      <section aria-labelledby="signed-in-heading" className="flex flex-col gap-4">
        <h1 id="signed-in-heading" className="font-[family-name:var(--font-display)] text-3xl">You&apos;re signed in as {user.username}</h1>
        <Button onClick={() => router.replace(next)}>Continue as {user.username}</Button>
        <Button variant="secondary" onClick={() => void signOut({ reason: "switch" })}>Use another account</Button>
      </section>
    );
  }

  const stayField = (
    <Checkbox id="stay-signed-in" label="Stay signed in on this device" hint="Untick on a shared computer."
      checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
  );
  const needsToken = needsTurnstileToken(turnstileToken);
  const errorNotice = error ? (
    <Notice tone="error">
      {error.message}
      {error.link ? <> <Link href={error.link.href} className="font-semibold underline underline-offset-4">{error.link.label}</Link></> : null}
    </Notice>
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      <AuthTabs active="login" next={next} />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl">Welcome back</h1>
        <p className="mt-2 text-sm text-emerald-50">Sign in to take your seat. Your play chips, hands and settings stay with your account.</p>
      </header>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {signOutNotice ? <Notice tone="warning">{signOutNotice}</Notice> : null}

      {step.kind === "choose" ? (
        <>
          <AccountChooser
            accounts={remembered}
            headingRef={headingRef}
            onPick={(account) => { setError(null); setStep({ kind: "credentials", identifier: account.username, locked: true }); }}
            onUseAnother={() => { setError(null); setStep({ kind: "credentials", identifier: "", locked: false }); }}
            onRemove={(username) => forgetAccount(username)}
            onForgetAll={() => forgetAllAccounts()}
          />
          {errorNotice}
          {passkeyButton}
        </>
      ) : null}

      {step.kind === "credentials" ? (
        <form aria-labelledby="credentials-heading" noValidate onSubmit={(event) => void submitCredentials(event)} className="flex flex-col gap-4">
          <h2 id="credentials-heading" ref={headingRef} tabIndex={-1} className="sr-only">Sign in with your password</h2>
          {step.locked ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-white/5 px-4 py-3">
              <span className="flex min-w-0 items-center gap-3">
                <Avatar username={step.identifier} hue={remembered.find((a) => a.username === step.identifier)?.avatarHue ?? 0} />
                <span className="truncate font-semibold text-emerald-50">{step.identifier}</span>
              </span>
              <button type="button" className="shrink-0 text-sm text-amber-100 underline underline-offset-4"
                onClick={() => { setError(null); setPassword(""); setStep(remembered.length > 0 ? { kind: "choose" } : { kind: "credentials", identifier: "", locked: false }); }}>
                Not you?
              </button>
              <input hidden readOnly type="text" name="username" autoComplete="username" value={step.identifier} />
            </div>
          ) : (
            <TextField ref={identifierRef} id="identifier" name="username" label="Username or email" autoComplete="username webauthn"
              autoCapitalize="none" spellCheck={false} maxLength={LOGIN_IDENTIFIER_MAX_LENGTH} disabled={busy}
              value={step.identifier} onChange={(event) => setStep({ kind: "credentials", identifier: event.target.value, locked: false })} />
          )}
          <PasswordField ref={passwordRef} id="password" label="Password" autoComplete="current-password" value={password}
            onChange={setPassword} disabled={busy}
            labelAside={<Link href="/reset-password" className="text-sm text-amber-100 underline-offset-4 hover:underline">Forgot password?</Link>} />
          {stayField}
          <TurnstileWidget action="login" resetKey={turnstileResetKey} onToken={setTurnstileToken} />
          {needsToken ? <p className="text-xs text-emerald-50/90" role="status">Checking your browser…</p> : null}
          {errorNotice}
          <Button type="submit" busy={busy} disabled={busy || needsToken || waitSeconds > 0}>
            {waitSeconds > 0 ? `Try again in ${waitSeconds} s` : "Sign in"}
          </Button>
          {passkeyButton ? (
            <>
              <p className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-emerald-50/90">
                <span aria-hidden="true" className="h-px flex-1 bg-white/15" />or<span aria-hidden="true" className="h-px flex-1 bg-white/15" />
              </p>
              {passkeyButton}
            </>
          ) : null}
        </form>
      ) : null}

      {step.kind === "second-factor" ? (
        <SecondFactorStep
          challenge={step.challenge}
          method={step.method}
          headingRef={headingRef}
          busy={busy}
          error={error?.message ?? null}
          onMethodChange={(method) => { setError(null); setStep({ ...step, method }); }}
          onSubmit={submitSecondFactor}
          onBack={() => backToCredentials(step.identifier, null)}
          onExpired={() => backToCredentials(step.identifier, "This sign-in timed out. Enter your password again.")}
          passkeyButton={passkeyButton}
        />
      ) : null}

      {step.kind !== "second-factor" ? (
        <p className="text-sm text-emerald-50">
          New here?{" "}
          <Link href={next !== "/" ? `/signup?next=${encodeURIComponent(next)}` : "/signup"} className="font-semibold text-amber-100 underline underline-offset-4">
            Create an account
          </Link>
        </p>
      ) : null}
    </div>
  );
}
