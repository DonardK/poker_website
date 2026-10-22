"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { EmailVerifiedResponse } from "@poker/shared";
import { useResendVerification } from "@/components/account/use-resend-verification";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { errorCode, fetchMe, isUnavailable, messageOf, retryAfterSeconds, verifyEmail } from "@/lib/auth-api";
import { takeFragmentToken } from "@/lib/fragment-token";
import { useAuthStore } from "@/stores/session";

type State =
  | { kind: "checking" }
  | { kind: "missing" }
  | { kind: "done" }
  | { kind: "failed"; message: string; retry: boolean };

/**
 * One request per token for this page load: React's development double mount
 * (and a quick re-render) must not spend the single-use token twice.
 */
const inflight = new Map<string, Promise<EmailVerifiedResponse>>();
function verifyOnce(token: string): Promise<EmailVerifiedResponse> {
  let pending = inflight.get(token);
  if (!pending) {
    pending = verifyEmail(token);
    inflight.set(token, pending);
    // A failure that may be retried (network, 503) can be sent again.
    pending.catch(() => inflight.delete(token));
  }
  return pending;
}

function failure(err: unknown): { message: string; retry: boolean } {
  const code = errorCode(err);
  const wait = retryAfterSeconds(err);
  if (code === "TOKEN_INVALID") return { message: "That link is invalid, has expired or was already used.", retry: false };
  if (wait !== null) return { message: `Too many attempts. Try again in ${wait} s.`, retry: true };
  if (isUnavailable(err)) return { message: messageOf(err), retry: true };
  return { message: messageOf(err, "Your email could not be confirmed."), retry: false };
}

/**
 * /verify-email#t=<token>: confirms the account's address (an email change
 * has its own page, /email-change). The token is read from the fragment and
 * removed from the address bar at once; the page then confirms it
 * automatically (a mail scanner opening the link cannot run this script, and
 * confirming an address proves nothing beyond owning the mailbox).
 */
export function VerifyEmailScreen() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const resend = useResendVerification();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [token, setToken] = useState<string | null>(null);

  async function run(value: string) {
    setState({ kind: "checking" });
    try {
      await verifyOnce(value);
      setState({ kind: "done" });
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
      setState({ kind: "failed", ...failure(err) });
    }
  }

  useEffect(() => {
    const value = takeFragmentToken();
    setToken(value);
    if (!value) { setState({ kind: "missing" }); return; }
    void run(value);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Confirm your email</h1>
      {state.kind === "checking" ? (
        <p role="status" className="flex items-center gap-3 text-emerald-50"><Spinner className="h-5 w-5" /> Confirming your email…</p>
      ) : null}
      {state.kind === "missing" ? (
        <>
          <Notice tone="warning">This link is incomplete. Open the latest email from us, or ask for a new one.</Notice>
          {hydrated && user ? <ResendBlock resend={resend} /> : null}
        </>
      ) : null}
      {state.kind === "done" ? (
        <>
          <Notice tone="success">Email confirmed. Thank you.</Notice>
          {hydrated && user
            ? <Link href="/" className={buttonClass("primary", "self-start")}>Continue to the lobby</Link>
            : <Link href="/login?notice=verified" className={buttonClass("primary", "self-start")}>Sign in</Link>}
        </>
      ) : null}
      {state.kind === "failed" ? (
        <>
          <Notice tone="error">{state.message}</Notice>
          {state.retry && token ? <Button className="self-start" onClick={() => void run(token)}>Try again</Button> : null}
          {!state.retry && hydrated && user && user.emailVerified !== true ? <ResendBlock resend={resend} /> : null}
          {!state.retry && hydrated && !user ? (
            <p className="text-sm text-emerald-50">
              <Link href="/login" className="font-semibold text-amber-100 underline underline-offset-4">Sign in</Link> to ask for a new link.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ResendBlock({ resend }: { resend: ReturnType<typeof useResendVerification> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" busy={resend.busy} disabled={resend.busy || resend.cooldown > 0} onClick={() => void resend.send()}>
        {resend.cooldown > 0 ? `Resend in ${resend.cooldown} s` : "Send a new link"}
      </Button>
      <span role="status" className="text-sm text-emerald-50">{resend.message}</span>
    </div>
  );
}
