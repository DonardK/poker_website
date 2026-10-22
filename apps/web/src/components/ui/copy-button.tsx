"use client";

import { useEffect, useState } from "react";
import { buttonClass } from "@/components/ui/button";

/** Copies `value`; "Copied" is announced politely. Clipboard failures (permissions, http) say so instead. */
export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const id = window.setTimeout(() => setState("idle"), 2_500);
    return () => window.clearTimeout(id);
  }, [state]);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={buttonClass("secondary", `min-h-10 px-4 py-2 text-sm ${className}`)}
        onClick={() => {
          if (!navigator.clipboard) { setState("failed"); return; }
          navigator.clipboard.writeText(value).then(() => setState("copied"), () => setState("failed"));
        }}
      >
        {label}
      </button>
      <span role="status" className="text-xs text-emerald-50/90">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text instead" : ""}
      </span>
    </span>
  );
}
