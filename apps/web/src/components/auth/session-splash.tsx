"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

/** While the session is being checked. The words appear only after 400 ms so a fast refresh does not flash them. */
export function SessionSplash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), 400);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <main aria-busy="true" className="grid min-h-[70vh] place-items-center px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <span aria-hidden="true" className="text-3xl text-amber-200">♠</span>
        <p className="font-[family-name:var(--font-display)] text-3xl">Hold&apos;em Live</p>
        <Spinner />
        <p role="status" className="min-h-6 text-emerald-50">{slow ? "Checking your session…" : ""}</p>
      </div>
    </main>
  );
}
