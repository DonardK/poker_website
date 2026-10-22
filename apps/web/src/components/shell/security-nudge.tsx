"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldIcon } from "@/components/ui/icons";
import { useAuthStore } from "@/stores/session";

const KEY = "poker-nudge-2fa:";
const HIDE_FOR_MS = 30 * 86_400_000;

function hiddenUntil(userId: string): number {
  try {
    const at = Number(window.localStorage.getItem(KEY + userId));
    return Number.isFinite(at) ? at + HIDE_FOR_MS : 0;
  } catch {
    return 0;
  }
}

/**
 * Two-step verification and passkeys are offered and recommended, never
 * forced (owner decision). This lobby card recommends them while the account
 * has neither; "Not now" hides it on this device for 30 days.
 */
export function SecurityNudge() {
  const user = useAuthStore((s) => s.user);
  const [hidden, setHidden] = useState(true);
  useEffect(() => { if (user) setHidden(hiddenUntil(user.id) > Date.now()); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user || hidden || user.twoFactorEnabled !== false || user.passkeyCount !== 0) return null;
  return (
    <aside aria-labelledby="security-nudge-title" className="max-w-xs rounded-2xl border border-amber-200/30 bg-black/30 px-5 py-4">
      <p id="security-nudge-title" className="flex items-center gap-2 font-semibold text-amber-100"><ShieldIcon /> Protect your account</p>
      <p className="mt-1 text-sm text-emerald-50">Add a passkey or two-step verification so a stolen password is not enough to get in.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link href="/account/security" className="min-h-10 rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-amber-200">
          Set it up
        </Link>
        <button type="button" className="min-h-10 px-2 text-sm text-amber-100 underline underline-offset-4"
          onClick={() => {
            setHidden(true);
            try { window.localStorage.setItem(KEY + user.id, String(Date.now())); } catch { /* hidden for this visit */ }
          }}>
          Not now
        </button>
      </div>
    </aside>
  );
}
