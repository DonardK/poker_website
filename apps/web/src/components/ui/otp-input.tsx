"use client";

import { forwardRef } from "react";
import { TOTP_DIGITS } from "@poker/shared";
import { TextField } from "@/components/ui/text-field";

/**
 * A one-time code: one field (not six boxes), numeric keyboard, the
 * platform's one-time-code autofill, spaces and dashes stripped on paste, and
 * onComplete once the last digit is in (auto-submit).
 */
export const OtpInput = forwardRef<HTMLInputElement, {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  error?: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
  length?: number;
}>(function OtpInput({ id, label = "6-digit code", value, onChange, onComplete, error, hint, disabled, length = TOTP_DIGITS }, ref) {
  return (
    <TextField
      ref={ref}
      id={id}
      label={label}
      hint={hint}
      error={error}
      value={value}
      disabled={disabled}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={length + 4}
      spellCheck={false}
      className="font-mono text-lg tracking-[0.3em]"
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, length);
        onChange(digits);
        if (digits.length === length && digits !== value) onComplete?.(digits);
      }}
    />
  );
});
