"use client";

import { forwardRef, useState } from "react";
import { PasswordStrength } from "@/components/auth/password-strength";
import { TextField } from "@/components/ui/text-field";
import { warmStrengthEstimator } from "@/lib/password-strength";

export interface PasswordFieldProps {
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
  /** New passwords: the strength meter and its live text (zxcvbn loads on first focus). */
  withStrength?: boolean;
  /** Words that make a password weak here (username, email name, site words). */
  userInputs?: string[];
  labelAside?: React.ReactNode;
}

/**
 * A password input with a Show/Hide toggle. Paste is never blocked (password
 * managers), and a new-password field never limits length silently: the
 * 72-byte rule is explained by the form instead.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { id, label, autoComplete, value, onChange, error, hint, disabled, withStrength = false, userInputs = [], labelAside }, ref,
) {
  const [visible, setVisible] = useState(false);
  const strengthId = withStrength ? `${id}-strength` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <TextField
        ref={ref}
        id={id}
        label={label}
        labelAside={labelAside}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        disabled={disabled}
        hint={hint}
        error={error}
        aria-describedby={strengthId}
        onFocus={withStrength ? warmStrengthEstimator : undefined}
        onChange={(event) => onChange(event.target.value)}
        trailing={(
          <button type="button" aria-controls={id} disabled={disabled}
            onClick={() => setVisible((v) => !v)}
            className="min-h-11 shrink-0 rounded-xl border border-white/25 px-3 text-sm font-semibold text-amber-100 transition hover:bg-white/10 disabled:opacity-60">
            {visible ? "Hide" : "Show"}<span className="sr-only"> {label.toLowerCase()}</span>
          </button>
        )}
      />
      {withStrength ? <PasswordStrength id={strengthId!} password={value} userInputs={userInputs} /> : null}
    </div>
  );
});
