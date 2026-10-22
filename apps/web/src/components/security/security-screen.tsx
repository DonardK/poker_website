"use client";

import { DevicesCard } from "@/components/security/devices-card";
import { PasskeysCard } from "@/components/security/passkeys-card";
import { PasswordChangeCard } from "@/components/security/password-change-card";
import { SecurityEventsCard } from "@/components/security/security-events-card";
import { SecurityOverview } from "@/components/security/security-overview";
import { SessionsCard } from "@/components/security/sessions-card";
import { TotpCard } from "@/components/security/totp-card";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { useAccountSecurity } from "@/lib/account-cache";

/** /account/security: how this account signs in, and where it is signed in. */
export function SecurityScreen() {
  const { security, error, loading, reload } = useAccountSecurity();
  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Account &amp; security</h1>
        <p className="mt-2 text-emerald-50">Two-step verification and passkeys are optional, and strongly recommended.</p>
      </header>
      {error && !security ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="error">{error}</Notice>
          <Button variant="secondary" onClick={() => void reload()}>Try again</Button>
        </div>
      ) : null}
      {!security && loading && !error ? (
        <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading your security settings…</p>
      ) : null}
      {security ? (
        <>
          <SecurityOverview security={security} />
          <PasswordChangeCard passwordChangedAt={security.passwordChangedAt} />
          <TotpCard totp={security.totp} available={security.capabilities.totp} onChanged={reload} />
          <PasskeysCard passkeys={security.passkeys} onChanged={reload} />
        </>
      ) : null}
      <SessionsCard />
      <DevicesCard />
      <SecurityEventsCard />
    </>
  );
}
