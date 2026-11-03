"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { afterPasswordReset, NewPasswordForm } from "@/components/auth/reset-password-screen";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { errorCode, isUnavailable, lockdown, messageOf, retryAfterSeconds } from "@/lib/auth-api";
import { isWalletNotMeLink, takeFragmentToken, takeWalletNotMeToken } from "@/lib/fragment-token";
import { reportWalletNotMe } from "@/lib/wallet-api";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; token: string }
  | { kind: "secured"; resetToken: string }
  | { kind: "reset-expired" }
  | { kind: "wallet-ready"; token: string }
  | { kind: "wallet-secured" };

/**
 * /auth/not-me#t=<token>: the "This wasn't me" link in a sign-in alert or a
 * security notice. SECURITY: nothing happens on page load (mail scanners open
 * links); one deliberate click locks the account down: every session is
 * signed out, sign-in factors added since the incident are removed (and ones
 * removed since then restored), and a new password is required. The answer
 * carries a short-lived reset token, so the new password is set right here.
 *
 * /auth/not-me#w=<token> is the payments variant (a new payout address or a
 * withdrawal the player did not make): one click makes withdrawals manual,
 * removes the destination the email named and every payout destination added
 * in the last 72 hours, cancels withdrawals not yet sent and signs out every
 * session (POST /api/wallet/not-me). No session is needed.
 */
export function NotMeScreen() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isWalletNotMeLink()) {
      const token = takeWalletNotMeToken();
      setState(token ? { kind: "wallet-ready", token } : { kind: "missing" });
      return;
    }
    const token = takeFragmentToken();
    setState(token ? { kind: "ready", token } : { kind: "missing" });
  }, []);

  async function secureWallet(token: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reportWalletNotMe(token);
      setState({ kind: "wallet-secured" });
    } catch (err) {
      const wait = retryAfterSeconds(err);
      if (errorCode(err) === "TOKEN_INVALID") setError("This link is invalid or has expired. If you still think someone else is using your account, reset your password and contact support.");
      else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else if (isUnavailable(err)) setError(messageOf(err));
      else setError(messageOf(err, "Your payments could not be secured. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function secure(token: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { resetToken } = await lockdown(token);
      // Every session of the account was revoked (this browser's too, when it was signed in to it).
      afterPasswordReset();
      setState({ kind: "secured", resetToken });
    } catch (err) {
      const wait = retryAfterSeconds(err);
      if (errorCode(err) === "TOKEN_INVALID") setError("This link is invalid, has expired or was already used. If you still think someone else is using your account, reset your password.");
      else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else if (isUnavailable(err)) setError(messageOf(err));
      else setError(messageOf(err, "Your account could not be secured. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">
        {state.kind === "secured" ? "Choose a new password"
          : state.kind === "wallet-ready" || state.kind === "wallet-secured" ? "Secure your payments" : "Secure your account"}
      </h1>
      {state.kind === "loading" ? <Spinner className="h-6 w-6" /> : null}
      {state.kind === "missing" ? (
        <>
          <Notice tone="warning">This link is incomplete. Open the latest security email from us again.</Notice>
          <Link href="/reset-password" className={buttonClass("secondary", "self-start")}>Reset your password instead</Link>
        </>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <p className="text-emerald-50">
            If you didn&apos;t sign in or make this change, secure your account now. We will:
          </p>
          <ul className="list-disc space-y-1.5 pl-6 text-emerald-50 marker:text-amber-200">
            <li>sign out every session on every device;</li>
            <li>undo sign-in methods added since then, and restore ones that were removed;</li>
            <li>ask you to choose a new password.</li>
          </ul>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button variant="danger" busy={busy} disabled={busy} onClick={() => void secure(state.token)}>
            This wasn&apos;t me — secure my account
          </Button>
          <p className="text-sm text-emerald-50">
            It was you? Then there&apos;s nothing to do. <Link href="/" className="font-semibold text-amber-100 underline underline-offset-4">Go to the lobby</Link>
          </p>
        </>
      ) : null}
      {state.kind === "wallet-ready" ? (
        <>
          <p className="text-emerald-50">
            If you didn&apos;t add this payout destination or ask for this withdrawal, secure your payments now. We will:
          </p>
          <ul className="list-disc space-y-1.5 pl-6 text-emerald-50 marker:text-amber-200">
            <li>freeze withdrawals until our team has checked your account;</li>
            <li>remove that destination, and any added in the last 72 hours;</li>
            <li>cancel withdrawals that haven&apos;t been sent yet (the money goes back to your balance);</li>
            <li>sign out every session on every device.</li>
          </ul>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button variant="danger" busy={busy} disabled={busy} onClick={() => void secureWallet(state.token)}>
            This wasn&apos;t me — freeze my withdrawals
          </Button>
          <p className="text-sm text-emerald-50">
            It was you? Then there&apos;s nothing to do. <Link href="/" className="font-semibold text-amber-100 underline underline-offset-4">Go to the lobby</Link>
          </p>
        </>
      ) : null}
      {state.kind === "wallet-secured" ? (
        <>
          <Notice tone="success">
            Done. Withdrawals are frozen, recent payout destinations were removed, unsent withdrawals were cancelled and every session was
            signed out. If someone else may know your password, change it now.
          </Notice>
          <div className="flex flex-wrap gap-3">
            <Link href="/reset-password" className={buttonClass("primary")}>Reset your password</Link>
            <Link href="/account/security" className={buttonClass("secondary")}>Account &amp; security</Link>
          </div>
        </>
      ) : null}
      {state.kind === "secured" ? (
        <NewPasswordForm token={state.resetToken} onInvalidToken={() => setState({ kind: "reset-expired" })}
          intro={<Notice tone="success">Done. We signed out every session on your account. Choose a new password to finish.</Notice>} />
      ) : null}
      {state.kind === "reset-expired" ? (
        <>
          <Notice tone="error">That took too long. Your account is still secured: ask for a password reset link to choose a new password.</Notice>
          <Link href="/reset-password" className={buttonClass("primary", "self-start")}>Reset your password</Link>
        </>
      ) : null}
    </div>
  );
}
