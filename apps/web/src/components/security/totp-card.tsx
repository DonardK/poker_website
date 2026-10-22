"use client";

import { useState } from "react";
import type { AccountSecurity } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { BackupCodesPanel } from "@/components/security/backup-codes-panel";
import { TotpSetupDialog } from "@/components/security/totp-setup-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { disableTotp, errorCode, messageOf, regenerateBackupCodes } from "@/lib/auth-api";
import { formatDate } from "@/lib/relative-time";
import { useAuthStore } from "@/stores/session";

/**
 * Two-step verification with an authenticator app (TOTP) and backup codes.
 * Offered and recommended, never forced (owner decision). Turning it off and
 * new backup codes need a fresh step-up that includes the second factor.
 */
export function TotpCard({ totp, available, onChanged }: {
  totp: AccountSecurity["totp"];
  /** The deployment offers TOTP (AccountSecurity.capabilities.totp). */
  available: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const { withStepUp } = useStepUp();
  const username = useAuthStore((s) => s.user?.username ?? "");
  const [dialog, setDialog] = useState<"setup" | "disable" | "regenerate" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function turnOff() {
    setBusy(true);
    setMessage(null);
    try {
      await withStepUp(() => disableTotp(), { action: "turn off two-step verification" });
      useAuthStore.getState().patchUser({ twoFactorEnabled: false });
      setDialog(null);
      setMessage({ tone: "success", text: "Two-step verification is off." });
      await onChanged();
    } catch (err) {
      setDialog(null);
      if (isStepUpCancelled(err)) return;
      setMessage({ tone: "error", text: errorCode(err) === "TOTP_NOT_ENABLED" ? "Two-step verification was already off." : messageOf(err) });
      if (errorCode(err) === "TOTP_NOT_ENABLED") await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setMessage(null);
    try {
      const { backupCodes } = await withStepUp(() => regenerateBackupCodes(), { action: "make new backup codes" });
      setDialog(null);
      setCodes(backupCodes);
    } catch (err) {
      setDialog(null);
      if (!isStepUpCancelled(err)) setMessage({ tone: "error", text: messageOf(err, "New backup codes could not be made.") });
    } finally {
      setBusy(false);
    }
  }

  const remaining = totp.backupCodesRemaining;
  return (
    <Card id="two-step" title="Two-step verification"
      description="A 6-digit code from an authenticator app on your phone, as well as your password, so a stolen password alone isn't enough."
      action={totp.enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Recommended</Badge>}>
      {totp.enabled ? (
        <>
          <p className="text-sm text-emerald-50">
            {totp.enabledAt ? `On since ${formatDate(totp.enabledAt)}` : "On"} · {remaining === 1 ? "1 backup code left" : `${remaining} backup codes left`}
          </p>
          {remaining <= 2 ? (
            <Notice tone="warning" live={false}>
              {remaining === 0
                ? "You have no backup codes left. Make new ones so you can still sign in if you lose your phone."
                : "You're running low on backup codes. Make new ones soon."}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" disabled={busy} onClick={() => { setMessage(null); setDialog("regenerate"); }}>Make new backup codes</Button>
            <Button variant="danger" disabled={busy} onClick={() => { setMessage(null); setDialog("disable"); }}>Turn off</Button>
          </div>
        </>
      ) : available ? (
        <Button className="self-start" onClick={() => { setMessage(null); setDialog("setup"); }}>Set up</Button>
      ) : (
        <p className="text-sm text-emerald-50">Two-step verification isn&apos;t available right now. Try again later.</p>
      )}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {dialog === "setup" ? (
        <TotpSetupDialog onClose={() => setDialog(null)} onEnabled={() => void onChanged()} />
      ) : null}
      {dialog === "disable" ? (
        <ConfirmDialog title="Turn off two-step verification?"
          body="Your password alone will sign you in again, and your backup codes stop working. You'll be asked to confirm it's you."
          confirmLabel="Turn off" tone="danger" busy={busy} onConfirm={() => void turnOff()} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog === "regenerate" ? (
        <ConfirmDialog title="Make new backup codes?"
          body="Your current backup codes will stop working. You'll be asked to confirm it's you."
          confirmLabel="Make new codes" busy={busy} onConfirm={() => void regenerate()} onCancel={() => setDialog(null)} />
      ) : null}
      {codes ? (
        <ModalDialog title="Your new backup codes" onClose={() => undefined} dismissible={false}>
          <BackupCodesPanel codes={codes} username={username} onDone={() => { setCodes(null); void onChanged(); }} />
        </ModalDialog>
      ) : null}
    </Card>
  );
}
