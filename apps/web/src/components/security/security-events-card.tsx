"use client";

import { useEffect, useState } from "react";
import type { SecurityEventSummary, SecurityEventType } from "@poker/shared";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { fetchSecurityEvents, messageOf } from "@/lib/auth-api";
import { formatDateTime } from "@/lib/relative-time";
import { describeUserAgent } from "@/lib/user-agent";

/** Each event in words people use; an unknown type (a newer API) reads as a generic change, never a raw code. */
const LABELS: Record<SecurityEventType, string> = {
  SIGN_IN: "Signed in",
  SIGN_IN_NEW_DEVICE: "Signed in from a new device",
  LOGIN_LOCKOUT: "Sign-in paused after wrong passwords",
  MFA_LOCKOUT: "Sign-in paused after wrong codes",
  PASSWORD_CHANGED: "Password changed",
  PASSWORD_RESET_REQUESTED: "Password reset requested",
  PASSWORD_RESET: "Password reset",
  EMAIL_VERIFIED: "Email confirmed",
  EMAIL_CHANGE_REQUESTED: "Email change requested",
  EMAIL_CHANGED: "Email changed",
  TOTP_ENABLED: "Two-step verification turned on",
  TOTP_DISABLED: "Two-step verification turned off",
  TOTP_CHANGED: "Two-step verification restored or removed after a report",
  BACKUP_CODES_REGENERATED: "New backup codes made",
  BACKUP_CODE_USED: "A backup code was used",
  PASSKEY_ADDED: "Passkey added",
  PASSKEY_REMOVED: "Passkey removed",
  DEVICE_FORGOTTEN: "Device forgotten",
  LOGOUT_ALL: "Signed out of other sessions",
  REFRESH_REUSE: "A session was ended because it was used from two places",
  NOT_ME_REPORTED: "Reported “This wasn't me”: signed out everywhere",
  ACCOUNT_LOCKDOWN: "Account secured by support",
  STEP_UP: "Confirmed it's you",
};

function label(type: string): string {
  return (LABELS as Record<string, string>)[type] ?? "Account security change";
}

/** The last 20 security events on this account, newest first. */
export function SecurityEventsCard() {
  const [events, setEvents] = useState<SecurityEventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchSecurityEvents(20)
      .then(({ events: rows }) => { if (live) setEvents(rows); })
      .catch((err: unknown) => { if (live) setError(messageOf(err, "Recent activity could not be loaded.")); });
    return () => { live = false; };
  }, []);

  return (
    <Card id="activity" title="Recent security activity" description="Sign-ins and changes to how you sign in.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {events === null && !error ? (
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-50"><Spinner className="h-4 w-4" /> Loading activity…</p>
      ) : null}
      {events && events.length === 0 ? <p className="text-sm text-emerald-50">Nothing yet.</p> : null}
      {events && events.length > 0 ? (
        <ol aria-label="Recent security activity" className="flex flex-col divide-y divide-white/10">
          {events.map((event) => (
            <li key={event.id} className="flex flex-col gap-0.5 py-2.5">
              <span className="font-semibold text-emerald-50">{label(event.type)}</span>
              <span className="text-xs text-emerald-50/90">
                {[formatDateTime(event.createdAt), event.userAgent ? describeUserAgent(event.userAgent) : null, event.country, event.ip]
                  .filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}
