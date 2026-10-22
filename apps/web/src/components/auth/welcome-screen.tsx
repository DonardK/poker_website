"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useResendVerification } from "@/components/account/use-resend-verification";
import { usePasskeySupport } from "@/components/auth/use-passkey-support";
import { TotpSetupDialog } from "@/components/security/totp-setup-dialog";
import { useAddPasskey } from "@/components/security/use-add-passkey";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckIcon, FingerprintIcon, KeyIcon, MailIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { fetchMe } from "@/lib/auth-api";
import { useAuthConfig } from "@/lib/auth-config";
import { useAuthStore } from "@/stores/session";

/** "r***@example.test": enough to recognise the address on a shared screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Right after sign-up: confirm the email, then protect the account with a
 * passkey or an authenticator app. Recommended, never required (owner
 * decision): "Skip for now" goes straight on. The fresh sign-in counts as the
 * step-up, so no password is asked again here.
 */
export function WelcomeScreen({ next }: { next: string }) {
  const user = useAuthStore((s) => s.user);
  const config = useAuthConfig();
  const passkeys = usePasskeySupport();
  const resend = useResendVerification();
  const [totpOpen, setTotpOpen] = useState(false);
  const [protectedWith, setProtectedWith] = useState<"passkey" | "totp" | null>(null);
  const passkeyAdded = useCallback(() => setProtectedWith("passkey"), []);
  const adder = useAddPasskey(passkeyAdded);

  // Back from the mail app: the address may be confirmed now.
  useEffect(() => {
    const onFocus = () => {
      if (useAuthStore.getState().user?.emailVerified !== false) return;
      void fetchMe().then(({ user: latest }) => {
        if (latest.id !== useAuthStore.getState().user?.id) return;
        if (latest.emailVerified !== undefined) useAuthStore.getState().patchUser({ emailVerified: latest.emailVerified });
      }).catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!user) return null;
  const showPasskey = passkeys?.enabled === true;
  const showTotp = config?.totpEnabled !== false;
  return (
    <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
      <header>
        <p className="text-sm uppercase tracking-[0.28em] text-amber-200">Account created</p>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-4xl font-semibold sm:text-5xl">You&apos;re in, {user.username}</h1>
      </header>

      {user.emailVerified === false ? (
        <Card id="confirm-email" title="Confirm your email"
          action={<MailIcon className="h-6 w-6 text-amber-200" />}
          description={user.email
            ? <>We sent a link to <strong>{maskEmail(user.email)}</strong>. It expires in 24 hours.</>
            : "Add an email address so you can recover your account."}>
          <div className="flex flex-wrap items-center gap-3">
            {user.email ? (
              <Button variant="secondary" busy={resend.busy} disabled={resend.busy || resend.cooldown > 0} onClick={() => void resend.send()}>
                {resend.cooldown > 0 ? `Resend in ${resend.cooldown} s` : "Resend email"}
              </Button>
            ) : null}
            <Link href="/account#email" className={buttonClass("ghost")}>Use a different email</Link>
          </div>
          <p role="status" className="text-sm text-emerald-50">{resend.message}</p>
        </Card>
      ) : user.emailVerified === true ? (
        <Notice tone="success"><span className="inline-flex items-center gap-2"><CheckIcon className="h-4 w-4" /> Email confirmed</span></Notice>
      ) : null}

      <Card id="protect" title="Protect your account" action={<Badge tone="warning">Recommended</Badge>}
        description="Add a second way to prove it's you, so a stolen password alone can't get in. It takes a minute.">
        {protectedWith ? (
          <Notice tone="success">
            {protectedWith === "passkey" ? "Passkey added. You can now sign in with it." : "Two-step verification is on."}
          </Notice>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {showPasskey ? (
              <div className="flex flex-col gap-3 rounded-xl border border-white/15 bg-white/5 p-4">
                <p className="flex items-center gap-2 font-semibold text-emerald-50"><FingerprintIcon className="h-5 w-5 text-amber-200" /> Add a passkey</p>
                <p className="text-sm text-emerald-50">Sign in with your fingerprint, face or screen lock. Phishing-resistant.</p>
                <Button className="mt-auto" busy={adder.busy} disabled={adder.busy} onClick={() => void adder.add()}>Add a passkey</Button>
              </div>
            ) : null}
            {showTotp ? (
              <div className="flex flex-col gap-3 rounded-xl border border-white/15 bg-white/5 p-4">
                <p className="flex items-center gap-2 font-semibold text-emerald-50"><KeyIcon className="h-5 w-5 text-amber-200" /> Use an authenticator app</p>
                <p className="text-sm text-emerald-50">6-digit codes from Google Authenticator, Microsoft Authenticator, 1Password or Authy.</p>
                <Button variant={showPasskey ? "secondary" : "primary"} className="mt-auto" onClick={() => setTotpOpen(true)}>Set up</Button>
              </div>
            ) : null}
          </div>
        )}
        {adder.error ? <Notice tone="error">{adder.error}</Notice> : null}
      </Card>

      <div className="flex flex-wrap items-center gap-4">
        <Link href={next} className={buttonClass(protectedWith ? "primary" : "secondary")}>
          {protectedWith ? "Continue to the lobby" : "Skip for now"}
        </Link>
        <p className="text-sm text-emerald-50">You can do this later in Account &amp; security.</p>
      </div>
      {totpOpen ? (
        <TotpSetupDialog onClose={() => setTotpOpen(false)} onEnabled={() => setProtectedWith("totp")} />
      ) : null}
    </main>
  );
}
