export type BadgeTone = "success" | "warning" | "neutral";

const TONES: Record<BadgeTone, string> = {
  success: "border-emerald-300/30 bg-emerald-400/15 text-emerald-100",
  warning: "border-amber-300/40 bg-amber-400/15 text-amber-100",
  neutral: "border-white/20 bg-white/10 text-emerald-50",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>
  );
}
