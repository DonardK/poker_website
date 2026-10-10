import type { Metadata } from "next";
import Link from "next/link";
import { PLAY_MONEY_NOTICE } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Page not found",
  description: "That page is not part of Hold'em Live.",
};

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center px-4 py-16 text-center">
      <p className="text-sm uppercase tracking-[0.28em] text-amber-200">404</p>
      <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight sm:text-5xl">
        Page not found
      </h1>
      <p className="mt-3 text-emerald-50">
        That address is not on this site. The lobby is where tables are listed.
      </p>
      <p className="mt-2 text-sm text-emerald-50">{PLAY_MONEY_NOTICE}.</p>
      <Link
        href="/"
        className="mx-auto mt-8 inline-flex min-h-12 items-center rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950"
      >
        Back to the lobby
      </Link>
    </main>
  );
}
