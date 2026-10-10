"use client";

import Link from "next/link";
import { useEffect } from "react";
import { PLAY_MONEY_NOTICE } from "@/lib/legal";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center px-4 py-16 text-center">
      <p className="text-sm uppercase tracking-[0.28em] text-amber-200">Something went wrong</p>
      <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight">
        This page could not be shown
      </h1>
      <p className="mt-3 text-emerald-50">
        Try again, or go back to the lobby. {PLAY_MONEY_NOTICE}.
      </p>
      {error.digest ? (
        <p className="mt-2 text-sm text-emerald-50">Reference {error.digest}</p>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="min-h-12 rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex min-h-12 items-center rounded-full border border-amber-200/40 px-6 py-3 font-semibold text-amber-100"
        >
          Back to the lobby
        </Link>
      </div>
    </main>
  );
}
