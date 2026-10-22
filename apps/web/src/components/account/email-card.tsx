"use client";

import { useRef, useState } from "react";
import type { AccountSecurity } from "@poker/shared";
import { useResendVerification } from "@/components/account/use-resend-verification";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Notice } from "@/components/ui/notice";
import { TextField } from "@/components/ui/text-field";
import { changeEmail, errorCode, messageOf, retryAfterSeconds } from "@/lib/auth-api";
import { focusSoon } from "@/lib/focus";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ChangeEmailDialog({ current, onClose, onRequested }: {
  current: string | null;
  onClose: () => void;
  onRequested: (pendingEmail: string) => void;
}) {
  const { withStepUp } = useStepUp();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = email.trim();
    if (value.length > 254 || !EMAIL.test(value)) { setError("Enter a valid email address."); inputRef.current?.focus(); return; }
    if (current && value.toLowerCase() === current.toLowerCase()) { setError("That's already your email address."); inputRef.current?.focus(); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await withStepUp(() => changeEmail(value), { action: "change your email" });
      onRequested(result?.pendingEmail ?? value.toLowerCase());
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      const wait = retryAfterSeconds(err);
      if (errorCode(err) === "EMAIL_ALREADY_VERIFIED") setError("That's already your email address.");
      else if (errorCode(err) === "MAIL_UNAVAILABLE") setError("We can't send email right now. Try again later.");
      else if (wait !== null) setError(`Too many requests. Try again in ${wait} s.`);
      else setError(messageOf(err, "Your email could not be changed. Try again."));
      focusSoon(inputRef);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog title={current ? "Change your email" : "Add an email"} onClose={onClose} dismissible={!busy} initialFocusRef={inputRef}
      description={<p>We&apos;ll send a link to the new address. {current ? "Your current address keeps working until you open it." : ""}</p>}>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <TextField ref={inputRef} id="new-email" type="email" label="New email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={error} disabled={busy} />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy} disabled={busy}>Send link</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** The account's email: confirmation status, a new link, and a change (confirmed from the new address; needs a step-up). */
export function EmailCard({ security, onChanged }: { security: AccountSecurity; onChanged: () => Promise<void> | void }) {
  const resend = useResendVerification();
  const [changing, setChanging] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);
  const pending = requested ?? security.pendingEmail;
  return (
    <Card id="email" title="Email"
      description="For sign-in alerts, security notices and account recovery. Never shown to other players."
      action={security.email ? (security.emailVerified ? <Badge tone="success">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>) : null}>
      <p className="break-all text-lg font-semibold text-emerald-50">{security.email ?? "No email address"}</p>
      {security.email && !security.emailVerified ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-emerald-50">Open the link we emailed you to confirm this address.</p>
          <Button variant="secondary" className="min-h-10 px-4 py-2 text-sm" busy={resend.busy} disabled={resend.busy || resend.cooldown > 0}
            onClick={() => void resend.send()}>
            {resend.cooldown > 0 ? `Resend in ${resend.cooldown} s` : "Resend link"}
          </Button>
          <span role="status" className="text-sm text-emerald-50">{resend.message}</span>
        </div>
      ) : null}
      {pending ? (
        <Notice tone="info">
          We sent a confirmation link to <strong className="break-all">{pending}</strong>. Your current address stays in use until you open it.
        </Notice>
      ) : null}
      <Button variant="secondary" className="self-start" onClick={() => setChanging(true)}>
        {security.email ? "Change email" : "Add an email"}
      </Button>
      {changing ? (
        <ChangeEmailDialog current={security.email} onClose={() => setChanging(false)}
          onRequested={(email) => { setChanging(false); setRequested(email); void onChanged(); }} />
      ) : null}
    </Card>
  );
}
