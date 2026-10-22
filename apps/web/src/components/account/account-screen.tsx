"use client";

import { EmailCard } from "@/components/account/email-card";
import { Avatar } from "@/components/shell/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { useAccountSecurity } from "@/lib/account-cache";
import { formatChipsWithUnit } from "@/lib/format";
import { PLAY_CHIPS_NOTICE } from "@/lib/legal";
import { useAuthStore } from "@/stores/session";

/** /account: who you are here, and the email that recovers the account. */
export function AccountScreen() {
  const user = useAuthStore((s) => s.user);
  const { security, error, loading, reload } = useAccountSecurity();
  if (!user) return null;
  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Your account</h1>
      </header>
      <Card id="profile" title="Profile">
        <div className="flex items-center gap-4">
          <Avatar username={user.username} hue={user.avatarHue} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-xl font-semibold text-emerald-50">{user.username}</p>
            <p className="text-sm text-emerald-50/90">Usernames can&apos;t be changed.</p>
          </div>
        </div>
        <p className="text-sm text-emerald-50">
          Play-chip balance: <span className="font-semibold">{formatChipsWithUnit(user.bankroll)}</span>. {PLAY_CHIPS_NOTICE}
        </p>
      </Card>
      {error && !security ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="error">{error}</Notice>
          <Button variant="secondary" onClick={() => void reload()}>Try again</Button>
        </div>
      ) : null}
      {!security && loading && !error ? (
        <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading…</p>
      ) : null}
      {security ? <EmailCard security={security} onChanged={reload} /> : null}
    </>
  );
}
