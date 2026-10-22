"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

/** A yes/no question. Cancel has the initial focus so Enter never confirms a destructive action by accident. */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", tone = "primary", busy = false, onConfirm, onCancel, children }: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog role="alertdialog" title={title} description={body} onClose={onCancel} initialFocusRef={cancelRef} dismissible={!busy}>
      {children}
      <div className="mt-2 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} busy={busy} disabled={busy}>{confirmLabel}</Button>
      </div>
    </ModalDialog>
  );
}
