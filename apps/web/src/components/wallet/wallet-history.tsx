"use client";

import { useCallback, useEffect, useState } from "react";
import type { CryptoAssetOption, PaymentsMode, WalletTxView, WithdrawalView } from "@poker/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { usePoll } from "@/components/wallet/use-poll";
import { compareAmounts, formatMoney } from "@/lib/money";
import { formatDateTime } from "@/lib/relative-time";
import { cancelWithdrawal, fetchTransactions, fetchWithdrawals } from "@/lib/wallet-api";
import { historyStatus, txKindLabel, walletErrorMessage, WITHDRAWAL_OPEN, withdrawalStatus } from "@/lib/wallet-copy";

const PAGE = 20;

/** Withdrawals that may still be cancelled (the API decides; ALLOW_WITHDRAWAL_CANCEL is off by default). */
const CANCELLABLE: ReadonlySet<string> = new Set(["HELD", "UNDER_REVIEW"]);

const EXPLORERS: Readonly<Record<string, (hash: string) => string>> = {
  bitcoin: (hash) => `https://mempool.space/tx/${hash}`,
  ethereum: (hash) => `https://etherscan.io/tx/${hash}`,
  tron: (hash) => `https://tronscan.org/#/transaction/${hash}`,
};

/**
 * SECURITY: a block-explorer link is built here, from an allow-list of hosts
 * and a hash that is only hex, never from a URL the API sent. None in sandbox
 * mode: a sandbox transaction is not on any chain.
 */
function explorerUrl(mode: PaymentsMode, network: string | null, hash: string | null): string | null {
  if (mode !== "live" || !network || !hash || !/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) return null;
  const build = EXPLORERS[network];
  return build ? build(hash) : null;
}

function StatusBadge({ status }: { status: { label: string; tone: "success" | "warning" | "neutral" } | null }) {
  return status ? <Badge tone={status.tone}>{status.label}</Badge> : null;
}

/** Open and recent withdrawals, with their player-facing status; re-read while any is still moving. */
export function WithdrawalsCard({ mode, cryptoAssets, onChanged }: {
  mode: PaymentsMode;
  cryptoAssets: CryptoAssetOption[];
  /** A cancellation moved money back: the balances need a reload. */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<WithdrawalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<WithdrawalView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await fetchWithdrawals();
      setItems(page.withdrawals);
      setError(null);
    } catch (err) {
      setError(walletErrorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (items ?? []).some((w) => WITHDRAWAL_OPEN.has(w.displayStatus));
  usePoll(load, { active: open, intervalMs: 10_000, maxIntervalMs: 60_000, maxDurationMs: 10 * 60_000 });

  async function confirmCancel() {
    const target = cancelling;
    if (!target || busy) return;
    setBusy(true);
    try {
      await cancelWithdrawal(target.id);
      setNotice(`Withdrawal cancelled. ${formatMoney(target.amount, target.asset)} is back in your balance.`);
      onChanged();
      await load();
    } catch (err) {
      setNotice(null);
      setError(walletErrorMessage(err, { asset: target.asset }));
    } finally {
      setBusy(false);
      setCancelling(null);
    }
  }

  const networkOf = (asset: string | null) => cryptoAssets.find((option) => option.code === asset)?.network ?? null;

  return (
    <Card id="withdrawals" title="Withdrawals">
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {items === null && !error ? (
        <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading withdrawals…</p>
      ) : null}
      {items && items.length === 0 ? <p className="text-emerald-50">No withdrawals yet.</p> : null}
      {items && items.length > 0 ? (
        <ul aria-label="Your withdrawals" className="flex flex-col divide-y divide-white/10">
          {items.map((w) => {
            const link = explorerUrl(mode, networkOf(w.payoutAsset), w.txHash);
            return (
              <li key={w.id} data-testid="withdrawal-row" className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-emerald-50">
                    {formatMoney(w.amount, w.asset)}
                    {w.destination ? <span className="font-normal"> to {w.destination.display}</span> : null}
                  </p>
                  <p className="text-sm text-emerald-50/90">
                    {formatDateTime(w.createdAt)}
                    {compareAmounts(w.fee, "0") === 1 ? ` · fee ${formatMoney(w.fee, w.asset)}, you receive ${formatMoney(w.youReceive, w.asset)}` : ""}
                  </p>
                  {w.failureReason && (w.displayStatus === "FAILED" || w.displayStatus === "REJECTED") ? (
                    <p className="text-sm text-emerald-50/90">{w.failureReason}</p>
                  ) : null}
                  {link ? (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm text-amber-100 underline underline-offset-4">
                      View the transaction<span className="sr-only"> (opens a block explorer in a new tab)</span>
                    </a>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusBadge status={withdrawalStatus(w.displayStatus)} />
                  {CANCELLABLE.has(w.status) ? (
                    <Button variant="ghost" className="text-sm" onClick={() => setCancelling(w)}>
                      Cancel<span className="sr-only"> the withdrawal of {formatMoney(w.amount, w.asset)}</span>
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {cancelling ? (
        <ConfirmDialog
          title="Cancel this withdrawal?"
          body={`${formatMoney(cancelling.amount, cancelling.asset)} goes back to your available balance.`}
          confirmLabel="Cancel withdrawal"
          cancelLabel="Keep it"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelling(null)}
        />
      ) : null}
    </Card>
  );
}

/** Every change of the available balance, newest first, a page at a time. */
export function TransactionsCard({ asset }: { asset: string }) {
  const [items, setItems] = useState<WalletTxView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor: string | null) => {
    setBusy(true);
    try {
      const page = await fetchTransactions({ cursor, limit: PAGE });
      setItems((before) => (cursor && before ? [...before, ...page.items] : page.items));
      setNext(page.next);
      setError(null);
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  return (
    <Card id="history" title="History" description="Deposits, withdrawals and every other change to your balance.">
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="error">{error}</Notice>
          <Button variant="secondary" onClick={() => void load(null)}>Try again</Button>
        </div>
      ) : null}
      {items === null && !error ? (
        <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading your history…</p>
      ) : null}
      {items && items.length === 0 ? <p className="text-emerald-50">No transactions yet.</p> : null}
      {items && items.length > 0 ? (
        <ul aria-label="Balance history" className="flex flex-col divide-y divide-white/10">
          {items.map((tx) => (
            <li key={tx.id} data-testid="history-row" className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-semibold text-emerald-50">{txKindLabel(tx.kind)}</p>
                <p className="text-sm text-emerald-50/90">{formatDateTime(tx.createdAt)}</p>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <p className="font-semibold tabular-nums text-emerald-50">{formatMoney(tx.amount, asset, { signed: true })}</p>
                <p className="text-xs tabular-nums text-emerald-50/90">Balance {formatMoney(tx.balanceAfter, asset)}</p>
                <StatusBadge status={historyStatus(tx.ref?.type ?? null, tx.status)} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <Button variant="secondary" className="self-start" busy={busy} disabled={busy} onClick={() => void load(next)}>Load more</Button>
      ) : null}
    </Card>
  );
}
