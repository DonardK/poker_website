import { forwardRef } from "react";
import { Spinner } from "@/components/ui/spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-amber-300 text-emerald-950 hover:bg-amber-200",
  secondary: "border border-amber-200/40 text-amber-100 hover:bg-white/10",
  ghost: "text-amber-100 underline-offset-4 hover:underline",
  danger: "border border-red-300/50 bg-red-950/60 text-red-50 hover:bg-red-900/60",
};

/** The site's button classes (decision: primitives encode the existing styles so new screens do not drift). */
export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  const shape = variant === "ghost" ? "min-h-11 px-2" : "min-h-12 rounded-full px-6 py-3";
  return `inline-flex items-center justify-center gap-2 ${shape} font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${extra}`.trim();
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Shows a spinner and aria-busy; the label stays, so the button keeps its accessible name. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", busy = false, className = "", type = "button", children, ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} aria-busy={busy || undefined} className={buttonClass(variant, className)} {...rest}>
      {busy ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});
