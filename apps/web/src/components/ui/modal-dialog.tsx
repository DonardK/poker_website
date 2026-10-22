"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Modal behaviour as the table's dialogs (buy-in-dialog.tsx): rendered in a
 * portal, the rest of the page is inert, focus is trapped and returns where
 * it was on close, Escape closes. Dialogs stack (a "Confirm it's you" dialog
 * over a settings dialog): only the topmost one handles keys and focus.
 */
const stack: string[] = [];

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export interface ModalDialogProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  /** Focused on open; the panel itself otherwise. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** "alertdialog" for confirmations. */
  role?: "dialog" | "alertdialog";
  /** Escape and the backdrop do not close it (e.g. while a request is running). */
  dismissible?: boolean;
  children: React.ReactNode;
}

export function ModalDialog({ title, description, onClose, initialFocusRef, role = "dialog", dismissible = true, children }: ModalDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    stack.push(id);
    const top = () => stack[stack.length - 1] === id;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || !(el instanceof HTMLElement) || el.inert) continue;
      el.inert = true;
      inerted.push(el);
    }
    (initialFocusRef?.current ?? panelRef.current)?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || !top()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!top()) return;
      if (event.target instanceof Node && !host.contains(event.target)) panelRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
      for (const el of inerted) el.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    // Mount-time setup only: the refs carry the latest callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={hostRef}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget && dismissibleRef.current) onCloseRef.current(); }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className="my-auto w-full max-w-md rounded-2xl border border-amber-200/30 bg-[#0b2a20] p-5 text-emerald-50 shadow-[0_24px_80px_rgba(0,0,0,0.7)] outline-none sm:p-6"
      >
        <h2 id={titleId} className="font-[family-name:var(--font-display)] text-2xl">{title}</h2>
        {description ? <div id={descriptionId} className="mt-2 text-sm text-emerald-50">{description}</div> : null}
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
