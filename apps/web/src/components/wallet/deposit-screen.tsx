"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CryptoAssetOption, DepositNext, DepositView, PaymentMethod, RealMoneySummary } from "@poker/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Notice } from "@/components/ui/notice";
import { QrCode } from "@/components/ui/qr-code";
import { AmountField } from "@/components/wallet/amount-field";
import { usePoll } from "@/components/wallet/use-poll";
import { BackToWallet, liveRealMoney, useWallet, WalletOffCard } from "@/components/wallet/wallet-frame";
import { depositBlocked, ReasonNotices } from "@/components/wallet/wallet-status";
import { ApiError } from "@/lib/api";
import { formatMoney, parseAmountInput } from "@/lib/money";
import { formatDateTime } from "@/lib/relative-time";
import { createDeposit, fetchDeposit, LAST_DEPOSIT_KEY, newIdempotencyKey, safeProviderUrl } from "@/lib/wallet-api";
import { DEPOSIT_TERMINAL, depositStatus, groupedAddress, networkLabel, walletErrorMessage } from "@/lib/wallet-copy";

const PRESETS = ["10.00", "20.00", "50.00", "100.00"] as const;

export type DepositTab = "card" | "crypto";

const TAB_METHOD: Readonly<Record<DepositTab, PaymentMethod>> = { card: "CARD", crypto: "CRYPTO" };
const TAB_LABEL: Readonly<Record<DepositTab, string>> = { card: "Card", crypto: "Crypto" };

/**
 * One idempotency key per submission (design-wallet section 11): kept while
 * the outcome is unknown (network failure, 5xx), so a retry of the same form
 * can never create a second deposit; replaced once the API gave an answer or
 * the form changed.
 */
function useSubmissionKey(): { key: (fingerprint: string) => string; settle: (err: unknown) => void } {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    key(fingerprint) {
      if (!current.current || current.current.fingerprint !== fingerprint) current.current = { fingerprint, key: newIdempotencyKey() };
      return current.current.key;
    },
    settle(err) {
      const unknown = err instanceof ApiError && (err.status === 0 || err.status >= 500);
      if (!unknown) current.current = null;
    },
  };
}

/** Hand the browser to the provider's page; the return page re-reads the deposit from the API. */
function goToProvider(deposit: DepositView, url: string): boolean {
  const target = safeProviderUrl(url);
  if (!target) return false;
  try { window.sessionStorage.setItem(LAST_DEPOSIT_KEY, deposit.id); } catch { /* the return page also reads ?deposit= */ }
  window.location.assign(target);
  return true;
}

export function DepositScreen({ initialTab }: { initialTab: DepositTab | null }) {
  const { summary } = useWallet();
  const money = liveRealMoney(summary);
  const router = useRouter();
  const tabs = (["card", "crypto"] as const).filter((tab) => money?.methods.deposit.includes(TAB_METHOD[tab]));
  const [tab, setTab] = useState<DepositTab | null>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0] ?? null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  if (!money) {
    return (
      <>
        <Heading />
        <WalletOffCard />
        <BackToWallet />
      </>
    );
  }
  const blocked = depositBlocked(money);
  if (blocked || !tab) {
    return (
      <>
        <Heading />
        <Notice tone="warning" live={false}>{blocked ?? "Deposits aren't available right now."}</Notice>
        <ReasonNotices money={money} />
        {money.reasons.includes("KYC_REQUIRED") ? <a href="/wallet/verify" className="self-start text-amber-100 underline underline-offset-4">Start verification</a> : null}
        <BackToWallet />
      </>
    );
  }

  const select = (next: DepositTab) => {
    setTab(next);
    router.replace(`/wallet/deposit?method=${next}`, { scroll: false });
  };
  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    const next = tabs[nextIndex]!;
    select(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <Heading />
      <div role="tablist" aria-label="How to deposit" className="flex gap-1 self-start rounded-full border border-white/15 bg-black/30 p-1">
        {tabs.map((value, index) => (
          <button key={value} ref={(el) => { tabRefs.current[value] = el; }} type="button" role="tab" id={`deposit-tab-${value}`}
            aria-selected={tab === value} aria-controls={`deposit-panel-${value}`} tabIndex={tab === value ? 0 : -1}
            onClick={() => select(value)} onKeyDown={(event) => onTabKey(event, index)}
            className="min-h-11 rounded-full px-5 text-sm font-semibold text-amber-100 transition hover:bg-white/10 aria-selected:bg-amber-300 aria-selected:text-emerald-950">
            {TAB_LABEL[value]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`deposit-panel-${tab}`} aria-labelledby={`deposit-tab-${tab}`} className="flex flex-col gap-6">
        {tab === "card" ? <CardDeposit money={money} sandbox={summary.mode === "sandbox"} />
          : <CryptoDeposit money={money} sandbox={summary.mode === "sandbox"} />}
      </div>
      <BackToWallet />
    </>
  );
}

function Heading() {
  return (
    <header>
      <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Deposit</h1>
      <p className="mt-2 text-emerald-50">
        Only deposit what you can afford to lose. <Link href="/responsible-gaming" className="text-amber-100 underline underline-offset-4">Responsible gaming</Link>
      </p>
    </header>
  );
}

function CardDeposit({ money, sandbox }: { money: RealMoneySummary; sandbox: boolean }) {
  const [amount, setAmount] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submission = useSubmissionKey();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = parseAmountInput(amount);
    if (!parsed.ok) { setFieldError(parsed.error); inputRef.current?.focus(); return; }
    setFieldError(null);
    setError(null);
    setBusy(true);
    let leaving = false;
    try {
      const started = await createDeposit({ method: "CARD", amount: parsed.amount }, submission.key(`card:${parsed.amount}`));
      submission.settle(null);
      if (started.next?.type === "REDIRECT") {
        leaving = goToProvider(started.deposit, started.next.url);
        if (!leaving) setError("The payment page address wasn't safe to open, so we stopped. Nothing was charged.");
      } else {
        // Already finished (an idempotent replay): show where it stands.
        router.push(`/wallet/deposit/return?deposit=${encodeURIComponent(started.deposit.id)}`);
        leaving = true;
      }
    } catch (err) {
      submission.settle(err);
      setError(walletErrorMessage(err, { asset: money.asset }));
    } finally {
      if (!leaving) setBusy(false);
    }
  }

  return (
    <Card id="card-deposit" title="Pay by card"
      description={sandbox ? "You'll go to the sandbox test payment page. No card is charged and no card number is asked for."
        : "You'll pay on our payment provider's secure page. We never see your card number."}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <AmountField ref={inputRef} id="card-amount" asset={money.asset} value={amount} onChange={(value) => { setAmount(value); setFieldError(null); }}
          error={fieldError} presets={PRESETS} disabled={busy} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" className="self-start" busy={busy} disabled={busy}>Continue to secure payment</Button>
      </form>
    </Card>
  );
}

function CryptoDeposit({ money, sandbox }: { money: RealMoneySummary; sandbox: boolean }) {
  const options = money.cryptoAssets;
  const [asset, setAsset] = useState<string>(options[0]?.code ?? "");
  const [amount, setAmount] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<{ deposit: DepositView; next: Extract<DepositNext, { type: "CRYPTO_INVOICE" }>; option: CryptoAssetOption } | null>(null);
  const submission = useSubmissionKey();
  const inputRef = useRef<HTMLInputElement>(null);

  if (options.length === 0) return <Notice tone="warning" live={false}>Crypto deposits aren&apos;t available right now.</Notice>;
  if (invoice) return <CryptoInvoice {...invoice} money={money} sandbox={sandbox} onDone={() => setInvoice(null)} />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const option = options.find((o) => o.code === asset);
    if (!option) { setError("Choose a currency."); return; }
    const parsed = parseAmountInput(amount);
    if (!parsed.ok) { setFieldError(parsed.error); inputRef.current?.focus(); return; }
    setFieldError(null);
    setError(null);
    setBusy(true);
    let leaving = false;
    try {
      const started = await createDeposit({ method: "CRYPTO", amount: parsed.amount, payAsset: option.code },
        submission.key(`crypto:${option.code}:${parsed.amount}`));
      submission.settle(null);
      if (started.next?.type === "CRYPTO_INVOICE") setInvoice({ deposit: started.deposit, next: started.next, option });
      else if (started.next?.type === "REDIRECT") {
        leaving = goToProvider(started.deposit, started.next.url);
        if (!leaving) setError("The payment page address wasn't safe to open, so we stopped.");
      } else setError("This deposit is no longer waiting for a payment. Check its status in your wallet.");
    } catch (err) {
      submission.settle(err);
      setError(walletErrorMessage(err, { asset: money.asset }));
    } finally {
      if (!leaving) setBusy(false);
    }
  }

  return (
    <Card id="crypto-deposit" title="Pay with crypto"
      description="You send crypto; our payment provider converts it at the time it arrives and we credit the amount it settles.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-emerald-50">Currency and network</legend>
          {options.map((option) => (
            <label key={option.code}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-white/20 bg-black/20 px-4 py-3 text-emerald-50 has-[:checked]:border-amber-300">
              <input type="radio" name="crypto-asset" value={option.code} checked={asset === option.code} disabled={busy}
                onChange={() => setAsset(option.code)} className="h-4 w-4 accent-amber-300" />
              <span className="font-semibold">{option.label}</span>
              <span className="text-sm text-emerald-50/90">{networkLabel(option.network)}</span>
            </label>
          ))}
        </fieldset>
        <AmountField ref={inputRef} id="crypto-amount" asset={money.asset} value={amount} onChange={(value) => { setAmount(value); setFieldError(null); }}
          error={fieldError} presets={PRESETS} disabled={busy}
          hint="How much you want to add to your balance. We show the amount of crypto to send next." />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" className="self-start" busy={busy} disabled={busy}>Get a deposit address</Button>
      </form>
    </Card>
  );
}

const BITCOIN_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;

function CryptoInvoice({ deposit: initial, next, option, money, sandbox, onDone }: {
  deposit: DepositView;
  next: Extract<DepositNext, { type: "CRYPTO_INVOICE" }>;
  option: CryptoAssetOption;
  money: RealMoneySummary;
  sandbox: boolean;
  onDone: () => void;
}) {
  const { reload } = useWallet();
  const [deposit, setDeposit] = useState(initial);
  const terminal = DEPOSIT_TERMINAL.has(deposit.status);
  const { timedOut } = usePoll(async () => {
    const { deposit: fresh } = await fetchDeposit(initial.id);
    setDeposit(fresh);
    if (fresh.status === "CREDITED") void reload();
  }, { active: !terminal, intervalMs: 5_000, maxIntervalMs: 30_000, maxDurationMs: 30 * 60_000 });
  useEffect(() => { if (deposit.status === "CREDITED") void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const address = next.address;
  const network = networkLabel(next.network);
  const openInWallet = next.network === "bitcoin" && BITCOIN_ADDRESS.test(address)
    ? `bitcoin:${address}${next.payAmount && /^\d+(\.\d+)?$/.test(next.payAmount) ? `?amount=${next.payAmount}` : ""}` : null;
  const status = depositStatus(deposit.status);
  const confirmations = deposit.confirmations ?? 0;

  return (
    <Card id="crypto-invoice" title={`Send ${option.label}`}
      description={`To add ${formatMoney(deposit.amount, money.asset)} to your balance.`}>
      {sandbox ? (
        <Notice tone="warning" live={false}>Sandbox address: it isn&apos;t on any real chain. Never send real crypto to it.</Notice>
      ) : null}
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <div className="rounded-xl bg-white p-2"><QrCode value={address} label={`QR code of the ${option.label} deposit address`} size={176} /></div>
        <div className="flex min-w-0 flex-col gap-3">
          {next.payAmount ? (
            <p className="text-emerald-50">Amount to send: <span className="font-semibold tabular-nums">{next.payAmount} {option.code.split("_")[0]}</span></p>
          ) : null}
          <div>
            <p className="text-sm text-emerald-50/90">Deposit address ({network})</p>
            <p data-testid="deposit-address" className="mt-1 break-all font-mono text-lg text-emerald-50">{groupedAddress(address)}</p>
          </div>
          {next.memo ? <p className="text-emerald-50">Memo or tag (required): <span className="font-mono">{next.memo}</span></p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton value={address} label="Copy address" />
            {openInWallet ? <a href={openInWallet} className="text-sm text-amber-100 underline underline-offset-4">Open in wallet app</a> : null}
          </div>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-emerald-50">
        <li>Send only {option.label} on {network}. Anything else sent to this address will be lost.</li>
        <li>After pasting the address, check that its first and last 6 characters are <span className="font-mono">{address.slice(0, 6)}</span> and <span className="font-mono">{address.slice(-6)}</span>.</li>
        <li>We credit your balance after {next.minConfirmations} network {next.minConfirmations === 1 ? "confirmation" : "confirmations"}.</li>
        {next.expiresAt ? <li>Send before {formatDateTime(next.expiresAt)}.</li> : null}
      </ul>
      <p role="status" className="rounded-xl border border-white/15 bg-black/20 px-4 py-3 text-emerald-50">
        {deposit.status === "CREDITED" ? `${formatMoney(deposit.creditedAmount ?? deposit.amount, money.asset)} added to your balance.`
          : deposit.status === "CONFIRMED" || (deposit.status === "PENDING" && confirmations > 0)
            ? `Payment seen: ${Math.min(confirmations, next.minConfirmations)} of ${next.minConfirmations} confirmations.`
            : terminal ? `Status: ${status.label}.` : timedOut ? "Still waiting for your payment. You can leave this page; we'll credit it when it arrives."
              : "Waiting for your payment…"}
      </p>
      <button type="button" className="self-start text-sm text-amber-100 underline underline-offset-4" onClick={onDone}>Deposit a different amount</button>
    </Card>
  );
}
