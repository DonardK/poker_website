"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DepositView } from "@poker/shared";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { usePoll } from "@/components/wallet/use-poll";
import { useWallet } from "@/components/wallet/wallet-frame";
import { compareAmounts, formatMoney } from "@/lib/money";
import { cleanObjectId, fetchDeposit, LAST_DEPOSIT_KEY } from "@/lib/wallet-api";
import { DEPOSIT_TERMINAL, walletErrorMessage } from "@/lib/wallet-copy";

/**
 * Where the payment provider sends the browser back (success, pending, back
 * and failure all land here). SECURITY: the query string is never trusted
 * for the outcome; anyone can type "?status=success". The page only takes
 * the deposit id from it (or, failing that, the one this tab sent to the
 * provider) and reads the deposit's status from the API until it settles.
 */
export function DepositReturnScreen({ depositParam }: { depositParam: string | null }) {
  const { reload } = useWallet();
  const [depositId, setDepositId] = useState<string | null | undefined>(undefined);
  const [deposit, setDeposit] = useState<DepositView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.sessionStorage.getItem(LAST_DEPOSIT_KEY); } catch { /* none */ }
    setDepositId(cleanObjectId(depositParam) ?? cleanObjectId(stored));
  }, [depositParam]);

  const read = async () => {
    if (!depositId) return;
    try {
      const { deposit: fresh } = await fetchDeposit(depositId);
      setDeposit(fresh);
      setError(null);
      if (DEPOSIT_TERMINAL.has(fresh.status)) {
        try { window.sessionStorage.removeItem(LAST_DEPOSIT_KEY); } catch { /* fine */ }
        void reload();
      }
    } catch (err) {
      setError(walletErrorMessage(err));
    }
  };
  useEffect(() => { void read(); }, [depositId]); // eslint-disable-line react-hooks/exhaustive-deps
  const settled = deposit !== null && DEPOSIT_TERMINAL.has(deposit.status);
  const { timedOut } = usePoll(read, { active: Boolean(depositId) && !settled, intervalMs: 2_000, maxIntervalMs: 10_000, maxDurationMs: 2 * 60_000 });

  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Your deposit</h1>
      </header>
      {depositId === null ? (
        <Notice tone="warning" live={false}>
          We couldn&apos;t tell which payment this was. Your wallet shows every deposit that reached your balance.
        </Notice>
      ) : depositId === undefined || (!deposit && !error) ? (
        <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Confirming your payment…</p>
      ) : deposit ? (
        <Outcome deposit={deposit} timedOut={timedOut} />
      ) : null}
      {error && !deposit ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Link href="/wallet" className={buttonClass("primary")}>Back to wallet</Link>
        {deposit && (deposit.status === "FAILED" || deposit.status === "EXPIRED" || deposit.status === "CANCELLED") ? (
          <Link href={`/wallet/deposit?method=${deposit.method === "CRYPTO" ? "crypto" : "card"}`} className={buttonClass("secondary")}>Try again</Link>
        ) : null}
      </div>
    </>
  );
}

function Outcome({ deposit, timedOut }: { deposit: DepositView; timedOut: boolean }) {
  const amount = formatMoney(deposit.amount, deposit.asset);
  let title: string;
  let body: string | null = null;
  let tone: "success" | "warning" | "info" = "info";
  switch (deposit.status) {
    case "CREDITED": {
      tone = "success";
      title = `${formatMoney(deposit.creditedAmount ?? deposit.amount, deposit.asset)} added to your balance`;
      if (compareAmounts(deposit.refundHeldAmount, "0") === 1) {
        body = `${formatMoney(deposit.refundHeldAmount, deposit.asset)} of it is held for a refund (for example, because it was over your deposit limit).`;
      }
      break;
    }
    case "FAILED":
      tone = "warning";
      title = "Payment didn't go through";
      // statusReason is not shown: it may be a processor's code, which is not written for players.
      body = "Nothing was added to your balance. You can try again, or use another card or method.";
      break;
    case "EXPIRED":
      tone = "warning";
      title = "The payment session expired";
      body = "Nothing was charged. You can start a new deposit.";
      break;
    case "CANCELLED":
      tone = "warning";
      title = "The payment was cancelled";
      body = "Nothing was charged.";
      break;
    case "NEEDS_REVIEW":
      title = "We're checking this payment";
      body = `${amount} will appear in your balance once it's confirmed. We'll email you.`;
      break;
    case "REVERSED":
    case "PARTIALLY_REVERSED":
      tone = "warning";
      title = "This payment was reversed";
      body = "The reversed amount was taken back from your balance. Contact support if you didn't expect this.";
      break;
    case "CONFIRMED":
      title = "Payment received";
      body = `Adding ${amount} to your balance…`;
      break;
    default:
      title = "Confirming your payment…";
      body = timedOut
        ? "We're still waiting for the payment provider. You can leave this page: we'll add it to your balance as soon as it's confirmed."
        : `Waiting for the payment provider to confirm ${amount}.`;
  }
  return (
    <Card id="deposit-outcome" title={title}>
      {body ? <Notice tone={tone}>{body}</Notice> : null}
    </Card>
  );
}
