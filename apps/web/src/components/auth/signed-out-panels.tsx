"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, buttonClass } from "@/components/ui/button";
import { API_UNAVAILABLE_MESSAGE } from "@/lib/api";
import { refreshSessionNow } from "@/lib/session-control";

/** Nobody is signed in: the gate is on its way to /login. */
export function SignedOutPanel({ href }: { href: string }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-3xl">You&apos;re signed out</h1>
      <p role="status" className="text-emerald-50">Taking you to sign in…</p>
      <Link href={href} className={buttonClass("primary")}>Sign in</Link>
    </main>
  );
}

/**
 * The session could not be checked because the API did not answer. No
 * redirect: the session may well still be valid, and signing in again would
 * not help. The hydrator keeps retrying; "Try again" retries now.
 */
export function ServiceUnavailableScreen() {
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="font-[family-name:var(--font-display)] text-3xl">Game server unavailable</h1>
      <p role="status" className="text-emerald-50">{API_UNAVAILABLE_MESSAGE}</p>
      <Button busy={busy} disabled={busy} onClick={() => {
        setBusy(true);
        void refreshSessionNow().finally(() => setBusy(false));
      }}>
        Try again
      </Button>
    </main>
  );
}
