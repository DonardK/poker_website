"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CryptoAssetOption, InstrumentView, QuoteView, RealMoneySummary, StepUpRequirement, WithdrawalView } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { AddDestinationDialog } from "@/components/wallet/add-destination-dialog";
import { AmountField } from "@/components/wallet/amount-field";
import {
  BackToWallet, liveRealMoney, SecurityHoldNotice, useSecurityHold, useWallet, WalletOffCard,
} from "@/components/wallet/wallet-frame";
import { ReasonNotices, withdrawBlocked } from "@/components/wallet/wallet-status";
import { ApiError } from "@/lib/api";
import { compareAmounts, formatMoney, parseAmountInput } from "@/lib/money";
import { formatDateTime } from "@/lib/relative-time";
import { createWithdrawal, fetchInstruments, newIdempotencyKey, quoteWithdrawal, revokeInstrument } from "@/lib/wallet-api";
import { BindMismatch, checkRequirement, stepUpRequirementOf, withdrawalBind } from "@/lib/wallet-bind";
import { cardLabel, networkLabel, shortAddress, walletErrorMessage, withdrawalStatus } from "@/lib/wallet-copy";
import { setWalletFlash } from "@/lib/wallet-store";
import { useAuthStore } from "@/stores/session";

const MISMATCH = "We couldn't confirm this request safely, so nothing was sent. Review the withdrawal again.";

/** How a payout destination reads in lists, summaries and the confirmation dialog. */
export function destinationLabel(instrument: InstrumentView, options: CryptoAssetOption[]): string {
  if (instrument.kind === "CARD" && instrument.card) return cardLabel(instrument.card);
  const crypto = instrument.crypto;
  if (!crypto) return instrument.label ?? "Saved destination";
  const asset = options.find((o) => o.code === crypto.asset)?.label ?? crypto.asset;
  return `${instrument.label ? `${instrument.label}: ` : ""}${asset} ${shortAddress(crypto.address)}`;
}

function coolingOff(instrument: InstrumentView, now = Date.now()): boolean {
  const at = Date.parse(instrument.usableAfter);
  return Number.isFinite(at) && at > now;
}

/** /wallet/withdraw: choose where, how much, see the quote, confirm with a money step-up. */
export function WithdrawScreen() {
  const { summary } = useWallet();
  const money = liveRealMoney(summary);
  const hold = useSecurityHold();
  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Withdraw</h1>
        <p className="mt-2 text-emerald-50">Withdrawals go back the way your money came in: to the card you deposited with, or to a crypto address you saved.</p>
      </header>
      {!money ? <WalletOffCard /> : <WithdrawBody money={money} hold={hold} />}
      <BackToWallet />
    </>
  );
}

function WithdrawBody({ money, hold }: { money: RealMoneySummary; hold: string | null }) {
  const { reload } = useWallet();
  const { withStepUp, confirmMoney } = useStepUp();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const router = useRouter();
  const [instruments, setInstruments] = useState<InstrumentView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<{ quote: QuoteView; stepUp: StepUpRequirement; instrument: InstrumentView } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<InstrumentView | null>(null);
  // An attempt whose outcome is unknown (network failure, 5xx) is resent as it was: same grant, same key.
  const pendingSend = useRef<{ quoteId: string; grantId: string; key: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const allowCard = money.methods.withdraw.includes("CARD");
  const allowCrypto = money.methods.withdraw.includes("CRYPTO");

  const load = useCallback(async () => {
    try {
      const { instruments: list } = await fetchInstruments();
      const usable = list.filter((i) => i.status === "ACTIVE" && i.payoutEnabled
        && ((i.kind === "CARD" && allowCard) || (i.kind === "CRYPTO_ADDRESS" && allowCrypto)));
      setInstruments(usable);
      setLoadError(null);
      setSelected((current) => (current && usable.some((i) => i.id === current && !coolingOff(i)) ? current
        : usable.find((i) => !coolingOff(i))?.id ?? null));
    } catch (err) {
      setLoadError(walletErrorMessage(err));
    }
  }, [allowCard, allowCrypto]);
  useEffect(() => { void load(); }, [load]);

  const blocked = withdrawBlocked(money, hold);
  if (blocked) {
    return (
      <>
        {hold ? <SecurityHoldNotice until={hold} /> : <Notice tone="warning" live={false}>{blocked}</Notice>}
        <ReasonNotices money={money} />
      </>
    );
  }

  const instrument = instruments?.find((i) => i.id === selected) ?? null;

  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!instrument) { setError("Choose where to send the money."); return; }
    const parsed = parseAmountInput(amount);
    if (!parsed.ok) { setFieldError(parsed.error); amountRef.current?.focus(); return; }
    if (compareAmounts(parsed.amount, money.available) === 1) {
      setFieldError(`That's more than your available balance of ${formatMoney(money.available, money.asset)}.`);
      amountRef.current?.focus();
      return;
    }
    setFieldError(null);
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await withStepUp(() => quoteWithdrawal({ instrumentId: instrument.id, amount: parsed.amount }), { action: "review this withdrawal" });
      setQuote({ ...result, instrument });
    } catch (err) {
      if (!isStepUpCancelled(err)) setError(walletErrorMessage(err, { asset: money.asset }));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote || busy || !userId) return;
    const { quote: q, stepUp, instrument: target } = quote;
    const label = destinationLabel(target, money.cryptoAssets);
    setBusy(true);
    setError(null);
    try {
      // SECURITY: the grant is bound to what this page shows (wallet-bind.ts).
      const bind = await withdrawalBind({ userId, instrumentId: target.id, quote: q });
      checkRequirement(stepUp, { purpose: "withdrawal", bind });
      const ask = (methods: StepUpRequirement["methods"]) => confirmMoney({
        purpose: "withdrawal", bind, methods, action: `withdraw ${formatMoney(q.amount, q.asset)} to ${label}`,
      });
      const send = async (grantId: string): Promise<WithdrawalView> => {
        const reuse = pendingSend.current && pendingSend.current.quoteId === q.id && pendingSend.current.grantId === grantId;
        const key = reuse ? pendingSend.current!.key : newIdempotencyKey();
        pendingSend.current = { quoteId: q.id, grantId, key };
        try {
          const { withdrawal } = await withStepUp(() => createWithdrawal({ quoteId: q.id, stepUpGrantId: grantId }, key),
            { action: "request this withdrawal" });
          pendingSend.current = null;
          return withdrawal;
        } catch (err) {
          const unknown = err instanceof ApiError && (err.status === 0 || err.status >= 500);
          if (!unknown) pendingSend.current = null;
          throw err;
        }
      };
      let withdrawal: WithdrawalView;
      const resend = pendingSend.current && pendingSend.current.quoteId === q.id ? pendingSend.current.grantId : null;
      try {
        withdrawal = await send(resend ?? (await ask(stepUp.methods)).stepUpGrantId);
      } catch (err) {
        // The grant expired or was spent (e.g. a slow confirmation): one fresh confirmation for the same action.
        const again = stepUpRequirementOf(err);
        if (!again) throw err;
        checkRequirement(again, { purpose: "withdrawal", bind });
        withdrawal = await send((await ask(again.methods)).stepUpGrantId);
      }
      setWalletFlash(`Withdrawal requested: ${formatMoney(withdrawal.amount, withdrawal.asset)} to ${withdrawal.destination?.display ?? label}. `
        + `Status: ${withdrawalStatus(withdrawal.displayStatus).label}. We'll email you when it's sent.`);
      void reload();
      router.push("/wallet");
    } catch (err) {
      if (isStepUpCancelled(err)) { setBusy(false); return; }
      if (err instanceof BindMismatch) setError(MISMATCH);
      else {
        if (err instanceof ApiError && err.code === "QUOTE_EXPIRED") setQuote(null);
        setError(walletErrorMessage(err, { asset: money.asset }));
      }
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const target = removing;
    if (!target || busy) return;
    setBusy(true);
    try {
      await revokeInstrument(target.id);
      setNotice(`Removed ${destinationLabel(target, money.cryptoAssets)}.`);
      await load();
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  if (quote) {
    const { quote: q, instrument: target } = quote;
    const crypto = target.kind === "CRYPTO_ADDRESS";
    return (
      <Card id="withdraw-review" title="Review your withdrawal">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
          <dt className="text-emerald-50/90">Amount</dt>
          <dd className="font-semibold tabular-nums text-emerald-50">{formatMoney(q.amount, q.asset)}</dd>
          <dt className="text-emerald-50/90">Fee</dt>
          <dd className="tabular-nums text-emerald-50">{formatMoney(q.fee, q.asset)}</dd>
          <dt className="text-emerald-50/90">You receive</dt>
          <dd className="font-semibold tabular-nums text-emerald-50">
            {formatMoney(q.youReceive, q.asset)}
            {crypto && q.receiveEstimate ? <span className="font-normal"> (about {q.receiveEstimate} {q.receiveAsset.split("_")[0]})</span> : null}
          </dd>
          <dt className="text-emerald-50/90">To</dt>
          <dd className="break-all text-emerald-50">{destinationLabel(target, money.cryptoAssets)}</dd>
        </dl>
        <p className="text-sm text-emerald-50/90">
          This quote is valid until {formatDateTime(q.expiresAt)}.{crypto ? " The crypto amount is an estimate at today's rate." : ""}{" "}
          New withdrawals may be reviewed by our team before they are sent.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          <Button variant="secondary" disabled={busy} onClick={() => { setQuote(null); setError(null); pendingSend.current = null; }}>Change</Button>
          <Button busy={busy} disabled={busy} onClick={() => void confirm()}>Confirm withdrawal</Button>
        </div>
      </Card>
    );
  }

  return (
    <>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <Card id="withdraw-form" title="Withdrawal" description={`Available: ${formatMoney(money.available, money.asset)}`}>
        {loadError ? (
          <div className="flex flex-col items-start gap-3">
            <Notice tone="error">{loadError}</Notice>
            <Button variant="secondary" onClick={() => void load()}>Try again</Button>
          </div>
        ) : instruments === null ? (
          <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Loading your payout destinations…</p>
        ) : (
          <form onSubmit={(event) => void review(event)} className="flex flex-col gap-5" noValidate>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-emerald-50">Send it to</legend>
              {instruments.length === 0 ? (
                <p className="text-emerald-50">
                  {allowCrypto ? "No payout destinations yet. Deposit by card first, or add a crypto address." : "No payout destinations yet. Deposit by card first."}
                </p>
              ) : null}
              {instruments.map((option) => {
                const waiting = coolingOff(option);
                const hintId = `destination-${option.id}-hint`;
                return (
                  <div key={option.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/20 bg-black/20 px-4 py-3 has-[:checked]:border-amber-300">
                    <label className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 ${waiting ? "cursor-not-allowed" : "cursor-pointer"}`}>
                      <input type="radio" name="destination" value={option.id} checked={selected === option.id} disabled={waiting || busy}
                        aria-describedby={hintId} onChange={() => setSelected(option.id)} className="h-4 w-4 shrink-0 accent-amber-300" />
                      <span className="min-w-0">
                        <span className="block break-all font-semibold text-emerald-50">{destinationLabel(option, money.cryptoAssets)}</span>
                        <span id={hintId} className="block text-xs text-emerald-50/90">
                          {waiting ? `Available for withdrawals from ${formatDateTime(option.usableAfter)}`
                            : option.kind === "CARD" ? "Withdrawals return to this card, up to the amount you deposited with it."
                              : option.crypto ? networkLabel(option.crypto.network) : ""}
                        </span>
                      </span>
                    </label>
                    {option.kind === "CRYPTO_ADDRESS" ? (
                      <Button variant="ghost" className="text-sm" disabled={busy} onClick={() => setRemoving(option)}>
                        Remove<span className="sr-only"> {destinationLabel(option, money.cryptoAssets)}</span>
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {allowCrypto && money.cryptoAssets.length > 0 ? (
                <Button variant="secondary" className="self-start" disabled={busy} onClick={() => setAdding(true)}>Add a crypto address</Button>
              ) : null}
            </fieldset>
            <AmountField ref={amountRef} id="withdraw-amount" asset={money.asset} value={amount} max={money.available}
              onChange={(value) => { setAmount(value); setFieldError(null); }} error={fieldError} disabled={busy} />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <Button type="submit" className="self-start" busy={busy} disabled={busy || !instrument}>Review withdrawal</Button>
          </form>
        )}
      </Card>
      {adding && userId ? (
        <AddDestinationDialog options={money.cryptoAssets} userId={userId}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            setNotice(`Address saved. For your safety, you can withdraw to it from ${formatDateTime(saved.usableAfter)}. We've emailed you about this change.`);
            void load();
          }} />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title="Remove this payout address?"
          body={`${destinationLabel(removing, money.cryptoAssets)} will no longer receive withdrawals. Adding it again starts a new waiting period.`}
          confirmLabel="Remove address"
          tone="danger"
          busy={busy}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}
