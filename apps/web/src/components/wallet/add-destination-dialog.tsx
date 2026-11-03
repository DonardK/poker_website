"use client";

import { useRef, useState } from "react";
import type { CryptoAssetOption, InstrumentView, StepUpRequirement } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { INPUT_CLASS, TextField } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api";
import { addCryptoDestination, newIdempotencyKey, prepareCryptoDestination } from "@/lib/wallet-api";
import { BindMismatch, checkRequirement, payoutDestinationBind, stepUpRequirementOf } from "@/lib/wallet-bind";
import { addressFormatProblem, groupedAddress, networkLabel, walletErrorMessage } from "@/lib/wallet-copy";

const MISMATCH = "We couldn't confirm this address safely, so it wasn't saved. Start again.";

/**
 * Save a crypto payout address (design-wallet section 10.5):
 * 1. a format check here, then POST .../crypto/prepare, which normalises and
 *    checks the address and answers the step-up `bind`;
 * 2. the player reads the normalised address back (clipboard-hijacking
 *    malware swaps addresses; the first and last characters are the check);
 * 3. a money step-up for purpose payout_destination, bound to exactly that
 *    address (recomputed here, wallet-bind.ts), then POST .../crypto with the
 *    grant. The address can receive withdrawals only after its cooling-off.
 */
export function AddDestinationDialog({ options, userId, onSaved, onClose }: {
  options: CryptoAssetOption[];
  userId: string;
  onSaved: (instrument: InstrumentView) => void;
  onClose: () => void;
}) {
  const { withStepUp, confirmMoney } = useStepUp();
  const [asset, setAsset] = useState(options[0]?.code ?? "");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{ asset: string; normalized: string; bind: string } | null>(null);
  const key = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const option = options.find((o) => o.code === asset) ?? null;

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !option) return;
    const problem = addressFormatProblem(option.network, address);
    if (problem) { setAddressError(problem); addressRef.current?.focus(); return; }
    setAddressError(null);
    setError(null);
    setBusy(true);
    try {
      const result = await withStepUp(() => prepareCryptoDestination({ asset: option.code, address: address.trim(), memo: null }),
        { action: "add a payout address" });
      const expected = await payoutDestinationBind({ userId, asset: option.code, network: option.network, address: result.normalized, memo: null });
      if (expected !== result.bind) throw new BindMismatch();
      setPrepared({ asset: option.code, normalized: result.normalized, bind: expected });
      window.requestAnimationFrame(() => saveRef.current?.focus());
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      if (err instanceof BindMismatch) setError(MISMATCH);
      else if (err instanceof ApiError && (err.code === "ADDRESS_INVALID" || err.code === "MEMO_REQUIRED" || err.code === "ADDRESS_BLOCKED")) {
        setAddressError(walletErrorMessage(err, { network: option.network }));
        addressRef.current?.focus();
      } else setError(walletErrorMessage(err, { network: option.network }));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!prepared || busy || !option) return;
    setBusy(true);
    setError(null);
    const { normalized, bind } = prepared;
    const ask = (methods: StepUpRequirement["methods"] | undefined) => confirmMoney({
      purpose: "payout_destination", bind, methods, action: `save the ${option.label} address ending ${normalized.slice(-6)}`,
    });
    const send = async (grantId: string) => {
      // One key per grant: a resend of the same request after a lost answer reuses it.
      if (!key.current || key.current.fingerprint !== grantId) key.current = { fingerprint: grantId, key: newIdempotencyKey() };
      const { instrument } = await withStepUp(() => addCryptoDestination({
        asset: prepared.asset, address: normalized, memo: null, ...(label.trim() ? { label: label.trim() } : {}), stepUpGrantId: grantId,
      }, key.current!.key), { action: "save this payout address" });
      return instrument;
    };
    try {
      let instrument: InstrumentView;
      try {
        instrument = await send((await ask(undefined)).stepUpGrantId);
      } catch (err) {
        const again = stepUpRequirementOf(err);
        if (!again) throw err;
        checkRequirement(again, { purpose: "payout_destination", bind });
        instrument = await send((await ask(again.methods)).stepUpGrantId);
      }
      onSaved(instrument);
    } catch (err) {
      if (!isStepUpCancelled(err)) setError(err instanceof BindMismatch ? MISMATCH : walletErrorMessage(err, { network: option.network }));
      setBusy(false);
    }
  }

  const normalized = prepared?.normalized ?? "";
  return (
    <ModalDialog
      title={prepared ? "Check the address" : "Add a crypto address"}
      description={prepared
        ? <p>Compare it with the address in your wallet app, especially the first and last 6 characters.</p>
        : <p>Withdrawals are sent only to addresses you save here. Use an address in your own name.</p>}
      onClose={onClose}
      dismissible={!busy}
      initialFocusRef={prepared ? saveRef : selectRef}
    >
      {prepared && option ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-white/15 bg-black/30 px-4 py-3">
            <p className="text-sm text-emerald-50/90">{option.label} · {networkLabel(option.network)}</p>
            <p data-testid="prepared-address" className="mt-1 break-all font-mono text-lg text-emerald-50">{groupedAddress(normalized)}</p>
            <p className="mt-2 text-sm text-emerald-50">
              Starts <span className="font-mono font-semibold">{normalized.slice(0, 6)}</span>, ends <span className="font-mono font-semibold">{normalized.slice(-6)}</span>
            </p>
            {label.trim() ? <p className="mt-1 text-sm text-emerald-50/90">Name: {label.trim()}</p> : null}
          </div>
          <p className="text-sm text-emerald-50">
            For your safety, a new address can receive withdrawals only after a waiting period, and we email you about it.
          </p>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busy} onClick={() => { setPrepared(null); setError(null); }}>Back</Button>
            <Button ref={saveRef} busy={busy} disabled={busy} onClick={() => void save()}>Save address</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void prepare(event)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="destination-asset" className="text-sm font-medium text-emerald-50">Currency and network</label>
            <select ref={selectRef} id="destination-asset" value={asset} disabled={busy} onChange={(event) => { setAsset(event.target.value); setAddressError(null); }}
              className={INPUT_CLASS}>
              {options.map((o) => <option key={o.code} value={o.code}>{o.label} ({networkLabel(o.network)})</option>)}
            </select>
          </div>
          <TextField ref={addressRef} id="destination-address" label="Address" value={address} error={addressError} disabled={busy}
            autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={140} className="font-mono"
            hint={option ? `Only a ${networkLabel(option.network)} address. Anything sent on another network is lost.` : undefined}
            onChange={(event) => { setAddress(event.target.value); setAddressError(null); }} />
          <TextField id="destination-label" label="Name (optional)" value={label} disabled={busy} maxLength={40} autoComplete="off"
            hint="For example, the name of your wallet app." onChange={(event) => setLabel(event.target.value)} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={busy || !address.trim()}>Continue</Button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
