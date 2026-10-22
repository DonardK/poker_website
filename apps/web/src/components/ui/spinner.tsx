/** Decorative spinner; it stops under prefers-reduced-motion (globals.css). Pair it with text for screen readers. */
export function Spinner({ className = "h-10 w-10" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block shrink-0 animate-spin rounded-full border-2 border-amber-200/30 border-t-amber-200 ${className}`} />;
}
