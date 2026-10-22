export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
}

export function Checkbox({ id, label, hint, ...rest }: CheckboxProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex items-start gap-3 text-sm text-emerald-50">
      <input id={id} type="checkbox" aria-describedby={hintId} className="mt-0.5 h-5 w-5 shrink-0 accent-amber-300" {...rest} />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id}>{label}</label>
        {hint ? <span id={hintId} className="text-xs text-emerald-50/90">{hint}</span> : null}
      </div>
    </div>
  );
}
