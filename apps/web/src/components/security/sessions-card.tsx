"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeviceIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { fetchSessions, messageOf, revokeSession, signOutOtherSessions, type AuthSessionView } from "@/lib/auth-api";
import { formatRelativeTime } from "@/lib/relative-time";
import { signOut } from "@/lib/session-actions";
import { describeUserAgent } from "@/lib/user-agent";

const ACTIVE_NOW_MS = 5 * 60_000;

/**
 * Where this account is signed in. Any other session can be signed out here
 * (its sockets close at once); this device's row signs out normally.
 */
export function SessionsCard() {
  const [sessions, setSessions] = useState<AuthSessionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const { sessions: rows } = await fetchSessions();
      // This device first, then the most recently used.
      setSessions([...rows].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)));
      setLoadError(null);
    } catch (err) {
      setLoadError(messageOf(err, "Your sessions could not be loaded."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function end(session: AuthSessionView) {
    setMessage(null);
    if (session.current) { void signOut({ reason: "logout" }); return; }
    setBusyId(session.id);
    try {
      await revokeSession(session.id);
      setMessage({ tone: "success", text: `Signed out ${describeUserAgent(session.userAgent)}.` });
      await load();
    } catch (err) {
      setMessage({ tone: "error", text: messageOf(err, "That session could not be signed out.") });
    } finally {
      setBusyId(null);
    }
  }

  async function endOthers() {
    setBusyId("others");
    setMessage(null);
    try {
      const { revoked } = await signOutOtherSessions();
      setConfirmAll(false);
      setMessage({ tone: "success", text: revoked === 1 ? "Signed out of 1 other session." : `Signed out of ${revoked} other sessions.` });
      await load();
    } catch (err) {
      setConfirmAll(false);
      setMessage({ tone: "error", text: messageOf(err, "The other sessions could not be signed out.") });
    } finally {
      setBusyId(null);
    }
  }

  const others = sessions?.filter((session) => !session.current).length ?? 0;
  return (
    <Card id="sessions" title="Where you're signed in"
      description="If you don't recognise a session, sign it out and change your password.">
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {sessions === null && !loadError ? (
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-50"><Spinner className="h-4 w-4" /> Loading sessions…</p>
      ) : null}
      {sessions ? (
        <ul aria-label="Active sessions" className="flex flex-col gap-2">
          {sessions.map((session) => {
            const lastUsed = Date.parse(session.lastUsedAt);
            const activeNow = Number.isFinite(lastUsed) && Date.now() - lastUsed < ACTIVE_NOW_MS;
            const device = describeUserAgent(session.userAgent);
            return (
              <li key={session.id} data-testid="session-row"
                className="flex flex-col gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <DeviceIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-emerald-50">
                      {device}{session.current ? <Badge tone="success">This device</Badge> : null}
                    </p>
                    <p className="text-xs text-emerald-50/90">
                      {[session.ip, activeNow ? "Active now" : `Last active ${formatRelativeTime(session.lastUsedAt)}`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                <Button variant="secondary" className="min-h-10 shrink-0 px-4 py-2 text-sm" busy={busyId === session.id}
                  disabled={busyId !== null} onClick={() => void end(session)}
                  aria-label={session.current ? "Sign out on this device" : `Sign out ${device}`}>
                  Sign out
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {others > 0 ? (
        <Button variant="secondary" className="self-start" disabled={busyId !== null} onClick={() => { setMessage(null); setConfirmAll(true); }}>
          Sign out of all other sessions
        </Button>
      ) : null}
      {confirmAll ? (
        <ConfirmDialog title="Sign out everywhere else?"
          body="Every other browser and device signed in to this account is signed out. This one stays signed in."
          confirmLabel="Sign out others" busy={busyId === "others"} onConfirm={() => void endOthers()} onCancel={() => setConfirmAll(false)} />
      ) : null}
    </Card>
  );
}
