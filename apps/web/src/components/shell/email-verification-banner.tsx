"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useResendVerification } from "@/components/account/use-resend-verification";
import { useAuthStore } from "@/stores/session";

const DISMISS_KEY = "poker-email-banner-dismissed:";
/** These pages show their own email card. */
const HIDDEN_ON = new Set(["/welcome", "/account"]);

function readDismissed(userId: string): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY + userId) === "1";
  } catch {
    return false;
  }
}

/** Shown while the account's email is known to be unverified; "Dismiss" hides it for this tab only. */
export function EmailVerificationBanner() {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(true);
  const resend = useResendVerification();
  useEffect(() => { if (user) setDismissed(readDismissed(user.id)); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user || user.emailVerified !== false || dismissed || HIDDEN_ON.has(pathname)) return null;
  return (
    <div className="border-b border-amber-300/30 bg-amber-950/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 text-sm text-amber-100 sm:px-8">
        <p>Confirm your email to secure your account and get sign-in alerts.</p>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className="text-xs">{resend.message}</span>
          <button type="button" disabled={resend.busy || resend.cooldown > 0} onClick={() => void resend.send()}
            className="min-h-10 rounded-full border border-amber-200/40 px-4 font-semibold transition hover:bg-white/10 disabled:opacity-50">
            {resend.cooldown > 0 ? `Resend in ${resend.cooldown} s` : "Resend email"}
          </button>
          <button type="button" className="min-h-10 px-2 underline underline-offset-4"
            onClick={() => {
              setDismissed(true);
              try { window.sessionStorage.setItem(DISMISS_KEY + user.id, "1"); } catch { /* this render only */ }
            }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
