"use client";

import { useEffect, useState } from "react";
import type { RealMoneySummary, WalletSummary } from "@poker/shared";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import {
  liveRealMoney, SecurityHoldNotice, useSecurityHold, useWallet, WalletOffCard,
} from "@/components/wallet/wallet-frame";
import { TransactionsCard, WithdrawalsCard } from "@/components/wallet/wallet-history";
import {
  ActionLink, depositBlocked, KycCard, LimitsCard, ReasonNotices, withdrawBlocked,
} from "@/components/wallet/wallet-status";
import { formatChips } from "@/lib/format";
import { PLAY_CHIPS_NOTICE } from "@/lib/legal";
import { compareAmounts, formatMoney } from "@/lib/money";
import { setWalletFlash } from "@/lib/wallet-store";

/** /wallet: balances, what the player can do now (and why not), limits and history. */
export function WalletScreen() {
  const { summary, reload, flash: storedFlash } = useWallet();
  // Shown once: read on mount, then cleared from the store.
  const [flash] = useState(storedFlash);
  useEffect(() => { if (storedFlash) setWalletFlash(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const money = liveRealMoney(summary);
  const hold = useSecurityHold();

  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Wallet</h1>
        <p className="mt-2 text-emerald-50">
          {money ? (summary.mode === "sandbox" ? "Your play chips and your test-money balance." : "Your play chips and your real-money balance.")
            : "Your play chips."}
        </p>
      </header>
      {flash ? <Notice tone="success">{flash}</Notice> : null}
      {money ? (
        <>
          {hold ? <SecurityHoldNotice until={hold} /> : null}
          <ReasonNotices money={money} />
          <KycCard money={money} sandbox={summary.mode === "sandbox"} />
          <BalancesCard summary={summary} money={money} hold={hold} />
          <LimitsCard money={money} />
          <WithdrawalsCard mode={summary.mode} cryptoAssets={money.cryptoAssets} onChanged={() => void reload()} />
          <TransactionsCard asset={money.asset} />
        </>
      ) : (
        <>
          <BalancesCard summary={summary} money={null} hold={null} />
          <WalletOffCard />
        </>
      )}
    </>
  );
}

function BalancesCard({ summary, money, hold }: { summary: WalletSummary; money: RealMoneySummary | null; hold: string | null }) {
  const held = money && compareAmounts(money.pendingWithdrawals, "0") === 1;
  return (
    <Card id="balances" title="Balances">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
          <dt className="text-sm text-emerald-50/90">Play chips</dt>
          <dd className="mt-1">
            <span data-testid="wallet-play-chips" className="text-3xl font-semibold tabular-nums text-emerald-50">{formatChips(summary.play.chips)}</span>
            <span className="mt-1 block text-xs text-emerald-50/90">{PLAY_CHIPS_NOTICE}</span>
          </dd>
        </div>
        {money ? (
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <dt className="text-sm text-emerald-50/90">{money.asset === "TEST_EUR" ? "Test money (TEST_EUR)" : "Cash balance"}</dt>
            <dd className="mt-1">
              <span data-testid="wallet-available" className="text-3xl font-semibold tabular-nums text-emerald-50">{formatMoney(money.available, money.asset)}</span>
              <span className="mt-1 block text-xs text-emerald-50/90">
                {held ? `${formatMoney(money.pendingWithdrawals, money.asset)} held for withdrawals in progress.` : "Available to withdraw."}
                {money.asset === "TEST_EUR" ? " Test money has no value." : ""}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      {money ? (
        <div className="flex flex-wrap items-start gap-3">
          <ActionLink href="/wallet/deposit" label="Deposit" id="deposit-action" primary blocked={depositBlocked(money)} />
          <ActionLink href="/wallet/withdraw" label="Withdraw" id="withdraw-action" blocked={withdrawBlocked(money, hold)} />
        </div>
      ) : null}
    </Card>
  );
}
