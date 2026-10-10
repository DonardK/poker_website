import { TERMS_VERSION } from "@/lib/legal";

/**
 * COMPLIANCE NOTE (decision D10): every legal document stays visibly marked as
 * a draft until counsel approves it. A player must never mistake an unreviewed
 * text for the operator's binding, approved terms.
 */
export function DraftBanner() {
  return (
    <div role="note" aria-label="Draft notice"
      className="rounded-2xl border-2 border-amber-300 bg-amber-950/80 px-4 py-3 text-amber-50 sm:px-5">
      <p className="font-semibold uppercase tracking-[0.14em] text-amber-200">Draft — pending legal review</p>
      <p className="mt-1 text-sm">
        This document (version {TERMS_VERSION}) has not yet been approved by counsel. It describes how the service works
        today, but its wording may change before it becomes final. Material changes will be announced and, where
        required, you will be asked to accept the new version.
      </p>
    </div>
  );
}
