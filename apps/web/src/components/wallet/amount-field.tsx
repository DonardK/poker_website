"use client";

import { forwardRef } from "react";
import { TextField } from "@/components/ui/text-field";
import { assetLabel, formatMoney } from "@/lib/money";

/**
 * A money amount as the player types it: a text field with the decimal
 * keyboard (never type="number", which would turn "20.50" into a float and
 * drop what it cannot parse). parseAmountInput (lib/money.ts) checks it with
 * string arithmetic; the API checks it again. Presets fill it in one tap.
 */
export const AmountField = forwardRef<HTMLInputElement, {
  id: string;
  asset: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
  /** Quick amounts as decimal strings ("20.00"). */
  presets?: readonly string[];
  /** A "Max" shortcut that fills this amount. */
  max?: string | null;
}>(function AmountField({ id, asset, value, onChange, error, hint, disabled, presets = [], max }, ref) {
  return (
    <div className="flex flex-col gap-2">
      <TextField
        ref={ref}
        id={id}
        label={`Amount (${asset === "EUR" ? "€" : asset})`}
        hint={hint}
        error={error}
        value={value}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={20}
        onChange={(event) => onChange(event.target.value)}
        className="tabular-nums"
        trailing={max ? (
          <button type="button" disabled={disabled} onClick={() => onChange(max)}
            aria-label={`Use your whole available balance, ${formatMoney(max, asset)}`}
            className="min-h-11 shrink-0 rounded-xl border border-amber-200/40 px-4 text-sm font-semibold text-amber-100 transition hover:bg-white/10 disabled:opacity-50">
            Max
          </button>
        ) : undefined}
      />
      {presets.length > 0 ? (
        <div role="group" aria-label={`Quick amounts in ${assetLabel(asset)}`} className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button key={preset} type="button" disabled={disabled} aria-pressed={value === preset}
              onClick={() => onChange(preset)}
              className="min-h-11 rounded-full border border-white/25 px-4 text-sm font-semibold text-emerald-50 transition hover:bg-white/10 aria-[pressed=true]:border-amber-300 aria-[pressed=true]:bg-amber-300 aria-[pressed=true]:text-emerald-950 disabled:opacity-50">
              {formatMoney(preset, asset)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
