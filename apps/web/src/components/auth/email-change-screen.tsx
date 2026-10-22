"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { resetAccountCache } from "@/lib/account-cache";
import { confirmEmailChange, errorCode, fetchMe, isUnavailable, messageOf, retryAfterSeconds } from "@/lib/auth-api";
import { takeFragmentToken } from "@/lib/fragment-token";
import { useAuthStore } from "@/stores/session";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; token: string }
  | { kind: "done"; email: string }
  | { kind: "failed"; message: string };

function failure(err: unknown): { message: string; retry: boolean } {
  const wait = retryAfterSeconds(err);
  if (errorCode(err) === "TOKEN_INVALID") {
    return { message: "That link is invalid, has expired or was already used. Ask for a new one in your account settings.", retry: false };
  }
  if (errorCode(err) === "EMAIL_UNAVAILABLE") return { message: "This email address can't be used for your account.", retry: false };
  if (wait !== null) return { message: `Too many attempts. Try again in ${wait} s.`, retry: true };
  if (isUnavailable(err)) return { message: messageOf(err), retry: true };
  return { message: messageOf(err, "Your email could not be changed."), retry: false };
}

/**
 * /email-change#t=<token>: the link sent to a new address after an email
 * change (apps/edge/src/mail/notify.ts EMAIL_LINK_PAGES). The token is read
 * from the fragment and removed from the address bar at once. SECURITY:
 * nothing happens on page load (mail scanners open links, and this changes
 * where security notices and recovery links go); one deliberate click
 * confirms it. Works signed in or out: the token names the account.
 */
export function EmailChangeScreen() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = takeFragmentToken();
    setState(token ? { kind: "ready", token } : { kind: "missing" });
  }, []);

  async function confirm(token: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { email } = await confirmEmailChange(token);
      setState({ kind: "done", email });
      resetAccountCache();
      // The link may belong to another account than the one signed in here: ask the API what is true for this one.
      if (useAuthStore.getState().user) {
        void fetchMe().then(({ user: latest }) => {
          if (latest.id !== useAuthStore.getState().user?.id) return;
          useAuthStore.getState().patchUser({
            email: latest.email,
            ...(latest.emailVerified !== undefined ? { emailVerified: latest.emailVerified } : {}),
          });
        }).catch(() => undefined);
      }
    } catch (err) {
      const { message, retry } = failure(err);
      // A refusal that may be retried keeps the button; anything else is final for this link.
      if (retry) setError(message);
      else setState({ kind: "failed", message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Confirm your new email</h1>
      {state.kind === "loading" ? <Spinner className="h-6 w-6" /> : null}
      {state.kind === "missing" ? (
        <Notice tone="warning">This link is incomplete. Open the latest email from us, or start the change again in your account settings.</Notice>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <p className="text-emerald-50">
            Use this address for your account from now on? Sign-in alerts, security notices and recovery links will go here,
            and we&apos;ll let your old address know.
          </p>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button className="self-start" busy={busy} disabled={busy} onClick={() => void confirm(state.token)}>
            Confirm new email
          </Button>
          <p className="text-sm text-emerald-50">Didn&apos;t ask for this? Close this page: nothing changes.</p>
        </>
      ) : null}
      {state.kind === "done" ? (
        <>
          <Notice tone="success">
            Email changed. We&apos;ll use <strong className="break-all">{state.email}</strong> from now on.
          </Notice>
          {hydrated && user
            ? <Link href="/account" className={buttonClass("primary", "self-start")}>Back to your account</Link>
            : <Link href="/login" className={buttonClass("primary", "self-start")}>Sign in</Link>}
        </>
      ) : null}
      {state.kind === "failed" ? (
        <>
          <Notice tone="error">{state.message}</Notice>
          {hydrated && !user ? (
            <p className="text-sm text-emerald-50">
              <Link href="/login" className="font-semibold text-amber-100 underline underline-offset-4">Sign in</Link> to change your email again.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
