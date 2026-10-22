"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PasskeySummary } from "@poker/shared";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { usePasskeySupport } from "@/components/auth/use-passkey-support";
import { useAddPasskey } from "@/components/security/use-add-passkey";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FingerprintIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { INPUT_CLASS } from "@/components/ui/text-field";
import { messageOf, removePasskey, renamePasskey } from "@/lib/auth-api";
import { formatDate, formatRelativeTime } from "@/lib/relative-time";
import { useAuthStore } from "@/stores/session";

function PasskeyRow({ passkey, onRenamed, onRemove, disabled }: {
  passkey: PasskeySummary;
  onRenamed: () => void;
  onRemove: (passkey: PasskeySummary) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const stop = () => {
    setEditing(false);
    setName(passkey.name);
    setError(null);
    window.requestAnimationFrame(() => renameRef.current?.focus());
  };

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) { setError("Use 1–64 characters."); return; }
    if (trimmed === passkey.name) { stop(); return; }
    setBusy(true);
    setError(null);
    try {
      await renamePasskey(passkey.id, trimmed);
      setEditing(false);
      onRenamed();
      window.requestAnimationFrame(() => renameRef.current?.focus());
    } catch (err) {
      setError(messageOf(err, "The passkey could not be renamed."));
    } finally {
      setBusy(false);
    }
  }

  const fieldId = `passkey-name-${passkey.id}`;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <FingerprintIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
        {editing ? (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={fieldId} className="text-sm font-medium text-emerald-50">Passkey name</label>
            <input ref={inputRef} id={fieldId} value={name} maxLength={64} disabled={busy} className={INPUT_CLASS}
              aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`} aria-invalid={error ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); void save(); }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stop(); }
              }} />
            <p id={`${fieldId}-hint`} className="text-xs text-emerald-50/90">Enter saves, Escape cancels.</p>
            {error ? <p id={`${fieldId}-error`} className="text-sm text-red-100">{error}</p> : null}
          </div>
        ) : (
          <div className="min-w-0">
            <p className="truncate font-semibold text-emerald-50">{passkey.name}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-emerald-50/90">
              <Badge tone={passkey.backedUp ? "success" : "neutral"}>{passkey.backedUp ? "Synced" : "This device only"}</Badge>
              <span>Added {formatDate(passkey.createdAt)}</span>
              <span>{passkey.lastUsedAt ? `Last used ${formatRelativeTime(passkey.lastUsedAt)}` : "Not used yet"}</span>
            </p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {editing ? (
          <>
            <Button variant="secondary" className="min-h-10 px-4 py-2 text-sm" disabled={busy} onClick={stop}>Cancel</Button>
            <Button className="min-h-10 px-4 py-2 text-sm" busy={busy} disabled={busy} onClick={() => void save()}>Save</Button>
          </>
        ) : (
          <>
            <Button ref={renameRef} variant="secondary" className="min-h-10 px-4 py-2 text-sm" disabled={disabled} onClick={() => setEditing(true)}
              aria-label={`Rename ${passkey.name}`}>Rename</Button>
            <Button variant="danger" className="min-h-10 px-4 py-2 text-sm" disabled={disabled} onClick={() => onRemove(passkey)}
              aria-label={`Remove ${passkey.name}`}>Remove</Button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Passkeys on this account: sign in with a fingerprint, face or screen lock;
 * phishing-resistant, and with user verification they count as two factors.
 * Adding and removing one needs a fresh step-up; renaming does not.
 */
export function PasskeysCard({ passkeys, onChanged }: { passkeys: PasskeySummary[]; onChanged: () => Promise<void> | void }) {
  const { withStepUp } = useStepUp();
  const support = usePasskeySupport();
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const added = useCallback((passkey: PasskeySummary) => {
    setMessage({ tone: "success", text: `Passkey added: ${passkey.name}.` });
    void onChanged();
  }, [onChanged]);
  const adder = useAddPasskey(added);

  async function remove(passkey: PasskeySummary) {
    setBusy(true);
    setMessage(null);
    try {
      await withStepUp(() => removePasskey(passkey.id), { action: "remove a passkey" });
      const user = useAuthStore.getState().user;
      useAuthStore.getState().patchUser({ passkeyCount: Math.max(0, (user?.passkeyCount ?? 1) - 1) });
      setRemoving(null);
      setMessage({ tone: "success", text: `Passkey removed: ${passkey.name}.` });
      await onChanged();
    } catch (err) {
      setRemoving(null);
      if (!isStepUpCancelled(err)) setMessage({ tone: "error", text: messageOf(err, "The passkey could not be removed.") });
    } finally {
      setBusy(false);
    }
  }

  const available = support?.enabled === true;
  return (
    <Card id="passkeys" title="Passkeys"
      description="Sign in with your fingerprint, face or screen lock instead of a password. Passkeys can't be phished."
      action={passkeys.length > 0 ? <Badge tone="success">{passkeys.length === 1 ? "1 passkey" : `${passkeys.length} passkeys`}</Badge> : null}>
      {passkeys.length > 0 ? (
        <ul aria-label="Your passkeys" className="flex flex-col gap-2">
          {passkeys.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} disabled={busy || adder.busy} onRenamed={() => void onChanged()}
              onRemove={(row) => { setMessage(null); setRemoving(row); }} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-emerald-50">No passkeys yet.</p>
      )}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {adder.error ? <Notice tone="error">{adder.error}</Notice> : null}
      {support === null ? null : available ? (
        <Button className="self-start" busy={adder.busy} disabled={adder.busy || busy} onClick={() => { setMessage(null); void adder.add(); }}>
          <FingerprintIcon /> Add a passkey
        </Button>
      ) : (
        <p className="text-sm text-emerald-50">
          {support.supported ? "Passkeys aren't available on this site right now." : "This browser doesn't support passkeys."}
        </p>
      )}
      {removing ? (
        <ConfirmDialog
          title="Remove this passkey?"
          body={`“${removing.name}” will no longer sign you in. You can still sign in with your password.`}
          confirmLabel="Remove passkey"
          tone="danger"
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </Card>
  );
}
