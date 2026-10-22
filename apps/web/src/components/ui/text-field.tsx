import { forwardRef } from "react";

export const INPUT_CLASS =
  "min-h-11 w-full rounded-xl border border-white/25 bg-black/30 px-4 py-3 text-emerald-50 aria-[invalid=true]:border-red-300 disabled:opacity-60";

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  /** Extra content on the label row (e.g. a "Forgot password?" link). */
  labelAside?: React.ReactNode;
  /** Rendered after the input inside its row (e.g. a show/hide toggle). */
  trailing?: React.ReactNode;
}

/**
 * A labelled input. The visible label is always there (never placeholder-only);
 * the hint and the error are tied to the input with aria-describedby, and an
 * error sets aria-invalid.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, hint, error, labelAside, trailing, className = "", ...rest }, ref,
) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [rest["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-emerald-50">{label}</label>
        {labelAside}
      </div>
      <div className="flex items-stretch gap-2">
        <input
          ref={ref}
          id={id}
          {...rest}
          aria-describedby={describedBy}
          aria-invalid={error ? true : rest["aria-invalid"]}
          className={`${INPUT_CLASS} ${className}`}
        />
        {trailing}
      </div>
      {hint ? <p id={hintId} className="text-xs text-emerald-50/90">{hint}</p> : null}
      {error ? <p id={errorId} className="text-sm font-medium text-red-100">{error}</p> : null}
    </div>
  );
});
