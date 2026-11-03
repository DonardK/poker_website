"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { DepositLimitsResponse, RealMoneySummary, RgLimitPeriod, SelfExclusionStatus } from "@poker/shared";
import { RG_LIMIT_PERIODS } from "@poker/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { AmountField } from "@/components/wallet/amount-field";
import { BackToWallet, liveRealMoney, useWallet, WalletOffCard } from "@/components/wallet/wallet-frame";
import { formatMoney, parseAmountInput } from "@/lib/money";
import { formatDateTime } from "@/lib/relative-time";
import { fetchDepositLimits, fetchSelfExclusion, requestSelfExclusionReturn, setDepositLimit } from "@/lib/wallet-api";
import { walletErrorMessage } from "@/lib/wallet-copy";

const PERIOD = {
  DAY: { title: "Daily limit", noun: "day", adjective: "daily" },
  WEEK: { title: "Weekly limit", noun: "week", adjective: "weekly" },
  MONTH: { title: "Monthly limit", noun: "month", adjective: "monthly" },
} as const;

interface Draft { amount: string; none: boolean }

/**
 * /wallet/limits: deposit limits (responsible gaming; GET and PUT
 * /api/wallet/limits). A stricter limit applies at once; a looser one, or
 * removing one, waits 24 hours (the database sets the timing). Before the
 * first deposit the player must make a choice, which may be "no limit". A
 * self-exclusion shows here too, because it does not end by itself: the player
 * asks to come back, and deposits reopen 24 hours later (7 days after our team
 * accepts, for an indefinite one).
 */
export function LimitsScreen() {
  const { summary } = useWallet();
  const money = liveRealMoney(summary);
  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Deposit limits</h1>
        <p className="mt-2 text-emerald-50">
          Set how much you can deposit each day, week and month. <Link href="/responsible-gaming" className="text-amber-100 underline underline-offset-4">Responsible gaming</Link>
        </p>
      </header>
      {money ? <><BreakCard /><LimitsForm money={money} /></> : (
        <>
          <Notice tone="info" live={false}>Deposit limits are available with real-money play.</Notice>
          <WalletOffCard />
        </>
      )}
      <BackToWallet />
    </>
  );
}

/** What the player reads about their break, by where it stands. */
function breakText(status: SelfExclusionStatus): string {
  if (status.requestedAt) {
    return status.accessRestoredAt
      ? `You asked to come back. Deposits reopen on ${formatDateTime(status.accessRestoredAt)}.`
      : "You asked to come back. Our team will review your request. Deposits reopen 7 days after they accept it.";
  }
  if (status.kind === "INDEFINITE") {
    return "Your self-exclusion has no end date. If you want to come back, ask here. Our team reviews every request, and deposits reopen 7 days after they accept it.";
  }
  if (status.canRequestReturn) {
    return `Your break ended on ${formatDateTime(status.endsAt!)}. Deposits stay closed until you ask to come back, and reopen 24 hours after you ask.`;
  }
  return `You're on a break until ${formatDateTime(status.endsAt!)}. Once it ends, deposits stay closed until you ask to come back here. You can still withdraw your balance.`;
}

function BreakCard() {
  const { reload } = useWallet();
  const [status, setStatus] = useState<SelfExclusionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchSelfExclusion().then(setStatus, (err) => setError(walletErrorMessage(err)));
  }, []);

  async function comeBack() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await requestSelfExclusionReturn());
      void reload();
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !status) return <Notice tone="error">{error}</Notice>;
  if (!status?.active) return null;
  return (
    <Card id="self-exclusion" title="Your break" description={breakText(status)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.canRequestReturn ? <Button type="button" className="self-start" busy={busy} disabled={busy} onClick={() => void comeBack()}>Ask to come back</Button> : null}
    </Card>
  );
}

function LimitsForm({ money }: { money: RealMoneySummary }) {
  const { reload } = useWallet();
  const [limits, setLimits] = useState<DepositLimitsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<RgLimitPeriod, Draft> | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RgLimitPeriod, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setupNeeded = money.reasons.includes("LIMITS_SETUP_REQUIRED");

  const apply = useCallback((response: DepositLimitsResponse) => {
    setLimits(response);
    const next = {} as Record<RgLimitPeriod, Draft>;
    for (const period of RG_LIMIT_PERIODS) {
      const active = response.deposit[period].active;
      next[period] = { amount: active ?? "", none: active === null };
    }
    setDrafts(next);
  }, []);

  useEffect(() => {
    void fetchDepositLimits().then(apply, (err) => setError(walletErrorMessage(err)));
  }, [apply]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!drafts || !limits || busy) return;
    const wanted: { period: RgLimitPeriod; amount: string | null }[] = [];
    const problems: Partial<Record<RgLimitPeriod, string>> = {};
    for (const period of RG_LIMIT_PERIODS) {
      const draft = drafts[period];
      let amount: string | null = null;
      if (!draft.none) {
        const parsed = parseAmountInput(draft.amount);
        if (!parsed.ok) {
          // Zero is not a limit: the choice that blocks nothing is "no limit", and the way to stop depositing is a break.
          problems[period] = /^0*([.,]0*)?$/.test(draft.amount.trim()) && draft.amount.trim()
            ? `Enter a limit above zero, or tick "No ${PERIOD[period].adjective} limit".` : parsed.error;
          continue;
        }
        amount = parsed.amount;
      }
      const view = limits.deposit[period];
      const current = view.pending ? view.pending.amount : view.active;
      // Unchanged periods are not sent, except before the first deposit: the choice itself must be recorded.
      if (setupNeeded || amount !== current) wanted.push({ period, amount });
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let latest = limits;
      for (const change of wanted) latest = await setDepositLimit(change);
      apply(latest);
      const waits = RG_LIMIT_PERIODS.some((period) => latest.deposit[period].pending);
      setNotice(waits ? "Saved. Lower limits apply now; higher limits and removals take effect after 24 hours." : "Saved. Your limits apply now.");
      void reload();
    } catch (err) {
      setError(walletErrorMessage(err, { asset: money.asset }));
    } finally {
      setBusy(false);
    }
  }

  if (!drafts || !limits) {
    return error ? <Notice tone="error">{error}</Notice>
      : <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading your limits…</p>;
  }

  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-6" noValidate>
      {setupNeeded ? (
        <Notice tone="warning" live={false}>Before your first deposit, choose your limits. You can choose no limit, and change them any time.</Notice>
      ) : null}
      {RG_LIMIT_PERIODS.map((period) => {
        const view = limits.deposit[period];
        const draft = drafts[period];
        return (
          <Card key={period} id={`limit-${period.toLowerCase()}`} title={PERIOD[period].title}
            description={view.active ? `Now: ${formatMoney(view.active, money.asset)} a ${PERIOD[period].noun}.` : `Now: no ${PERIOD[period].adjective} limit.`}>
            {view.pending ? (
              <Notice tone="info" live={false}>
                {view.pending.amount ? `Changes to ${formatMoney(view.pending.amount, money.asset)}` : "The limit is removed"} on {formatDateTime(view.pending.effectiveFrom)}.
              </Notice>
            ) : null}
            <Checkbox id={`limit-${period}-none`} checked={draft.none} disabled={busy} label={`No ${PERIOD[period].adjective} limit`}
              onChange={(event) => setDrafts({ ...drafts, [period]: { ...draft, none: event.target.checked } })} />
            {!draft.none ? (
              <AmountField id={`limit-${period}-amount`} asset={money.asset} value={draft.amount} disabled={busy} error={errors[period] ?? null}
                onChange={(value) => setDrafts({ ...drafts, [period]: { ...draft, amount: value } })} />
            ) : null}
          </Card>
        );
      })}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <Button type="submit" className="self-start" busy={busy} disabled={busy}>Save limits</Button>
    </form>
  );
}
