"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/session-actions";

/**
 * A guest session from before guest play was retired (2026-10). The API
 * revokes those sessions, so this only shows if an old one is still being
 * served. The way on is a real account: sign out, then create one.
 */
export function GuestRetiredPrompt() {
  const [busy, setBusy] = useState(false);
  const leave = (to: "/signup" | "/login") => {
    setBusy(true);
    void signOut({ reason: "logout", exitTo: to });
  };
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center gap-4 px-6 py-16">
      <h1 className="font-[family-name:var(--font-display)] text-4xl">Guest play has ended</h1>
      <p className="text-emerald-50">
        Everyone now plays with an account. Create one to keep playing; guest play chips and seats cannot be moved to it.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={() => leave("/signup")}>Create an account</Button>
        <Button variant="secondary" disabled={busy} onClick={() => leave("/login")}>Sign out</Button>
      </div>
    </main>
  );
}
