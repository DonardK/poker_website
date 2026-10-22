export type NoticeTone = "info" | "success" | "warning" | "error";

const TONES: Record<NoticeTone, string> = {
  info: "border-white/20 bg-black/30 text-emerald-50",
  success: "border-emerald-300/40 bg-emerald-950/60 text-emerald-50",
  warning: "border-amber-300/40 bg-amber-950/40 text-amber-100",
  error: "border-red-400/40 bg-red-950/40 text-red-100",
};

/**
 * A notice inside the page's <main>. Errors are role="alert" (announced at
 * once), everything else role="status" (announced politely). `live={false}`
 * renders a static note (no live region) for text that is there on load.
 */
export function Notice({ tone = "info", live = true, className = "", children, id }: {
  tone?: NoticeTone;
  live?: boolean;
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  const role = !live ? "note" : tone === "error" ? "alert" : "status";
  return (
    <div id={id} role={role} className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]} ${className}`}>
      {children}
    </div>
  );
}
