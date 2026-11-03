"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import type { RealMoneySummary, WalletSummary } from "@poker/shared";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { useAccountSecurity } from "@/lib/account-cache";
import { OFF_BODY, OFF_TITLE, SANDBOX_BODY, SANDBOX_TITLE, securityHoldText } from "@/lib/wallet-copy";
import { useWalletSummary, type WalletState } from "@/lib/wallet-store";

/**
 * The wallet section's frame (src/app/(app)/(shell)/wallet/layout.tsx): it
 * loads GET /api/wallet once and hands the summary to every wallet page.
 * The summary decides everything (design-wallet section 12.3): "off" (or an
 * API without the route) shows the play-chip balance and no money forms;
 * "sandbox" carries a permanent test-money banner on every wallet page;
 * "live" shows none. The API enforces every gate again.
 */
interface WalletContextValue extends Omit<WalletState, "summary"> {
  summary: WalletSummary;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet needs the wallet layout");
  return value;
}

/** The real-money part when money can move on this deployment at all; null while it is off. */
export function liveRealMoney(summary: WalletSummary): RealMoneySummary | null {
  return summary.mode === "off" ? null : summary.realMoney;
}

export function WalletFrame({ children }: { children: React.ReactNode }) {
  const state = useWalletSummary();
  const { summary, error, reload } = state;
  if (!summary) {
    return error ? (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Wallet</h1>
        <Notice tone="error">{error}</Notice>
        <Button variant="secondary" onClick={() => void reload()}>Try again</Button>
      </div>
    ) : (
      <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading your wallet…</p>
    );
  }
  return (
    <WalletContext.Provider value={{ ...state, summary }}>
      {summary.mode === "sandbox" ? <SandboxBanner /> : null}
      {children}
    </WalletContext.Provider>
  );
}

/** Permanent on every wallet page in sandbox mode: nothing here is real money. */
export function SandboxBanner() {
  return (
    <div role="note" aria-label="Sandbox notice" data-testid="sandbox-banner"
      className="rounded-2xl border-2 border-dashed border-amber-300/70 bg-amber-950/60 px-5 py-4 text-amber-100">
      <p className="font-semibold">{SANDBOX_TITLE}</p>
      <p className="mt-1 text-sm">{SANDBOX_BODY}</p>
    </div>
  );
}

/** Real money is off on this deployment: say so plainly, with no forms. */
export function WalletOffCard({ id = "real-money" }: { id?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="rounded-2xl border border-white/15 bg-black/30 p-5 sm:p-6">
      <h2 id={`${id}-title`} className="font-[family-name:var(--font-display)] text-2xl font-semibold">{OFF_TITLE}</h2>
      <p className="mt-2 text-emerald-50">{OFF_BODY}</p>
      <p className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Link href="/responsible-gaming" className="text-amber-100 underline underline-offset-4">Responsible gaming</Link>
        <Link href="/fairness" className="text-amber-100 underline underline-offset-4">Fairness</Link>
      </p>
    </section>
  );
}

/**
 * User.securityHoldUntil (from the security overview) while it is in the
 * future: withdrawals and new payout addresses wait after a credential
 * change or a "This wasn't me" report. The API refuses them too
 * (403 SECURITY_HOLD); this explains it before the player tries.
 */
export function useSecurityHold(): string | null {
  const { security } = useAccountSecurity();
  const until = security?.securityHoldUntil ?? null;
  return until && Date.parse(until) > Date.now() ? until : null;
}

export function SecurityHoldNotice({ until }: { until: string }) {
  return (
    <Notice tone="warning" live={false} className="flex flex-col gap-1">
      <span className="font-semibold">Withdrawals are paused for your security</span>
      <span>{securityHoldText(until)} If you didn&apos;t make that change, <Link href="/account/security" className="underline underline-offset-4">review your account security</Link>.</span>
    </Notice>
  );
}

/** "Back to wallet" for the sub-pages. */
export function BackToWallet({ fullPage = false }: { fullPage?: boolean }) {
  const className = "self-start text-sm text-amber-100 underline underline-offset-4";
  // SECURITY: the verification page leaves with a full page load, so the provider's script and policy do not follow.
  return fullPage ? <a href="/wallet" className={className}>← Back to wallet</a> : <Link href="/wallet" className={className}>← Back to wallet</Link>;
}
