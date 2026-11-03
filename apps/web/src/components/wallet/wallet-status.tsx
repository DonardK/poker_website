"use client";

import Link from "next/link";
import type { RealMoneyReason, RealMoneySummary } from "@poker/shared";
import { RG_LIMIT_PERIODS } from "@poker/shared";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { compareAmounts, formatMoney } from "@/lib/money";
import { REASON_COPY, untilText } from "@/lib/wallet-copy";

/** Reasons the KYC card explains; the rest are listed as notices. */
const KYC_REASONS: ReadonlySet<RealMoneyReason> = new Set(["KYC_REQUIRED", "KYC_PENDING"]);

const DEPOSIT_BLOCK: Partial<Record<RealMoneyReason, string>> = {
  NOT_LAUNCHED: "Deposits aren't available yet.",
  PAUSED: "Deposits are paused for maintenance.",
  REGION: "Deposits aren't available in your region.",
  KYC_REQUIRED: "Verify your identity to deposit.",
  KYC_PENDING: "Deposits open once your identity check is done.",
  LIMITS_SETUP_REQUIRED: "Choose your deposit limits first.",
  SELF_EXCLUDED: "Deposits are closed during your self-exclusion.",
  ACCOUNT_RESTRICTED: "Deposits are restricted on your account.",
  SOURCE_OF_FUNDS_REQUIRED: "We need to confirm where your funds come from first.",
};

const WITHDRAW_BLOCK: Partial<Record<RealMoneyReason, string>> = {
  NOT_LAUNCHED: "Withdrawals aren't available yet.",
  PAUSED: "Withdrawals are paused for maintenance.",
  KYC_REQUIRED: "Verify your identity to withdraw.",
  KYC_PENDING: "Withdrawals open once your identity check is done.",
  ACCOUNT_RESTRICTED: "Withdrawals are restricted on your account. Contact support.",
  SOURCE_OF_FUNDS_REQUIRED: "We need to confirm where your funds come from first.",
};

/** Why the deposit button is off, or null when deposits are open. */
export function depositBlocked(money: RealMoneySummary): string | null {
  if (money.canDeposit && money.methods.deposit.length > 0) return null;
  for (const reason of money.reasons) {
    const text = DEPOSIT_BLOCK[reason];
    if (text) return text;
  }
  return "Deposits aren't available right now.";
}

/** Why the withdraw button is off, or null when withdrawals are open. */
export function withdrawBlocked(money: RealMoneySummary, hold: string | null): string | null {
  if (hold) return `Withdrawals are paused for your security ${untilText(hold)}.`;
  if (money.canWithdraw && money.methods.withdraw.length > 0) {
    return compareAmounts(money.available, "0") === 1 ? null : "You have no balance to withdraw.";
  }
  for (const reason of money.reasons) {
    const text = WITHDRAW_BLOCK[reason];
    if (text) return text;
  }
  return "Withdrawals aren't available right now.";
}

/** A link styled as a button, or a muted, aria-disabled stand-in that names why (never a bare disabled control). */
export function ActionLink({ href, label, blocked, id, primary = false }: {
  href: string; label: string; blocked: string | null; id: string; primary?: boolean;
}) {
  if (!blocked) return <Link href={href} className={buttonClass(primary ? "primary" : "secondary")}>{label}</Link>;
  return (
    <span className="flex flex-col gap-1">
      <button type="button" aria-disabled="true" aria-describedby={`${id}-reason`}
        className="inline-flex min-h-12 cursor-not-allowed items-center justify-center rounded-full border border-dashed border-white/25 px-6 py-3 font-semibold text-emerald-50">
        {label}
      </button>
      <span id={`${id}-reason`} className="max-w-[16rem] text-xs text-emerald-50/90">{blocked}</span>
    </span>
  );
}

/** Every reason that is not about identity verification, as one notice each. */
export function ReasonNotices({ money }: { money: RealMoneySummary }) {
  const reasons = money.reasons.filter((reason) => !KYC_REASONS.has(reason));
  if (reasons.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {reasons.map((reason) => (
        <Notice key={reason} tone="warning" live={false}>
          {REASON_COPY[reason] ?? "Some payments aren't available on your account right now."}
          {reason === "LIMITS_SETUP_REQUIRED" ? <> <Link href="/wallet/limits" className="underline underline-offset-4">Set your limits</Link></> : null}
          {reason === "SELF_EXCLUDED" ? <> <Link href="/wallet/limits" className="underline underline-offset-4">Your break</Link> · <Link href="/responsible-gaming" className="underline underline-offset-4">About self-exclusion</Link></> : null}
        </Notice>
      ))}
    </div>
  );
}

/**
 * Identity verification (KYC): required before the first deposit and for
 * every withdrawal (design-wallet D-W5). Starting it opens /wallet/verify
 * with a full page load: only that page's policy allows the provider.
 */
export function KycCard({ money, sandbox }: { money: RealMoneySummary; sandbox: boolean }) {
  const status = money.kyc.status;
  const needed = money.kyc.requiredForDeposit || money.reasons.some((reason) => KYC_REASONS.has(reason));
  if (status === "VERIFIED" || (!needed && status === "UNVERIFIED")) return null;
  const badge = status === "PENDING" ? <Badge tone="warning">In progress</Badge>
    : status === "REJECTED" ? <Badge tone="neutral">Not verified</Badge> : <Badge tone="warning">Needed</Badge>;
  return (
    <Card id="verification" title="Identity verification" action={badge}>
      {status === "UNVERIFIED" ? (
        <>
          <p className="text-emerald-50">
            We&apos;re required to check who you are before you deposit or withdraw. It takes a few minutes: have an identity
            document ready, and allow your camera when asked.
          </p>
          {sandbox ? <p className="text-sm text-emerald-50/90">Sandbox: the test verification needs no documents.</p> : null}
          {/* A full page load: the verification page has its own security policy. */}
          <a href="/wallet/verify" className={buttonClass("primary", "self-start")}>Start verification</a>
        </>
      ) : status === "PENDING" ? (
        <>
          <p className="text-emerald-50">We&apos;re checking your documents. This usually takes a few minutes; we&apos;ll email you when it&apos;s done.</p>
          <a href="/wallet/verify" className={buttonClass("secondary", "self-start")}>Check status</a>
        </>
      ) : (
        <p className="text-emerald-50">
          We couldn&apos;t verify your identity, so deposits and withdrawals stay closed. If you think this is a mistake,{" "}
          <Link href="/complaints" className="text-amber-100 underline underline-offset-4">contact us through our complaints process</Link>.
        </p>
      )}
    </Card>
  );
}

const PERIOD_LABEL = { DAY: "Daily", WEEK: "Weekly", MONTH: "Monthly" } as const;

/** The deposit limits in force (responsible gaming), from the summary. */
export function LimitsCard({ money }: { money: RealMoneySummary }) {
  const setupNeeded = money.reasons.includes("LIMITS_SETUP_REQUIRED");
  return (
    <Card id="limits" title="Deposit limits"
      description="Limits help you stay in control. A lower limit applies at once; a higher one, or removing one, after 24 hours.">
      <dl className="grid gap-2 sm:grid-cols-3">
        {RG_LIMIT_PERIODS.map((period) => (
          <div key={period} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <dt className="text-sm text-emerald-50/90">{PERIOD_LABEL[period]}</dt>
            <dd className="mt-1 font-semibold tabular-nums text-emerald-50">
              {money.limits[period] ? formatMoney(money.limits[period], money.asset) : "No limit"}
            </dd>
          </div>
        ))}
      </dl>
      <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Link href="/wallet/limits" className="text-amber-100 underline underline-offset-4">
          {setupNeeded ? "Set your deposit limits" : "Change your limits"}
        </Link>
        <Link href="/responsible-gaming" className="text-amber-100 underline underline-offset-4">Responsible gaming</Link>
      </p>
    </Card>
  );
}
