"use client";

import { useRef, useState } from "react";
import { Avatar } from "@/components/shell/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CloseIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/relative-time";
import type { RememberedAccount } from "@/lib/remembered-accounts";

/**
 * "Choose an account": the usernames this device remembers (never passwords).
 * Picking one goes to its password (or passkey); "Remove" forgets it on this
 * device and moves focus to the next row.
 */
export function AccountChooser({ accounts, onPick, onUseAnother, onRemove, onForgetAll, headingRef }: {
  accounts: RememberedAccount[];
  onPick: (account: RememberedAccount) => void;
  onUseAnother: () => void;
  onRemove: (username: string) => void;
  onForgetAll: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const useAnotherRef = useRef<HTMLButtonElement>(null);

  const remove = (index: number, username: string) => {
    onRemove(username);
    // After React drops the row: focus what is now at this position (the next row), else the previous, else "Use another account".
    window.requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-account-row]") ?? [];
      const target = rows[Math.min(index, rows.length - 1)];
      (target ?? useAnotherRef.current)?.focus();
    });
  };

  return (
    <section aria-labelledby="choose-heading" className="flex flex-col gap-4">
      <h2 id="choose-heading" ref={headingRef} tabIndex={-1} className="font-[family-name:var(--font-display)] text-2xl outline-none">
        Choose an account
      </h2>
      <ul ref={listRef} className="flex flex-col gap-2">
        {accounts.map((account, index) => (
          <li key={account.username.toLowerCase()} className="flex items-stretch gap-2">
            <button type="button" data-account-row onClick={() => onPick(account)}
              className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-left transition hover:border-amber-200/40 hover:bg-white/10">
              <Avatar username={account.username} hue={account.avatarHue} />
              <span className="min-w-0">
                <span className="block truncate font-semibold text-emerald-50">{account.username}</span>
                <span className="block text-xs text-emerald-50/90">Last used {formatRelativeTime(account.lastUsedAt)}</span>
              </span>
            </button>
            <button type="button" aria-label={`Remove ${account.username} from this device`} onClick={() => remove(index, account.username)}
              className="grid min-h-14 w-12 shrink-0 place-items-center rounded-2xl border border-white/15 text-amber-100 transition hover:bg-white/10">
              <CloseIcon />
            </button>
          </li>
        ))}
      </ul>
      <Button ref={useAnotherRef} variant="secondary" onClick={onUseAnother}>Use another account</Button>
      <button type="button" onClick={() => setConfirmForget(true)} className="self-center text-sm text-amber-100 underline underline-offset-4">
        Forget all accounts on this device
      </button>
      {confirmForget ? (
        <ConfirmDialog
          title="Forget all accounts?"
          body="This removes every remembered username from this device. It doesn't sign anyone out or change any account."
          confirmLabel="Forget all"
          onConfirm={() => { setConfirmForget(false); onForgetAll(); }}
          onCancel={() => setConfirmForget(false)}
        />
      ) : null}
    </section>
  );
}
