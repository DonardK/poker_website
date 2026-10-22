"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/shell/avatar";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChevronDownIcon } from "@/components/ui/icons";
import { formatChips } from "@/lib/format";
import { PLAY_CHIPS_NOTICE } from "@/lib/legal";
import { signOut, switchAccount } from "@/lib/session-actions";
import { useAuthStore } from "@/stores/session";

const ITEM = "flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm text-emerald-50 transition hover:bg-white/10";

/**
 * The account menu: the APG disclosure pattern (a button with aria-expanded
 * that shows a panel of links and buttons), not role="menu", so it works with
 * Tab and plain semantics. Closes on Escape (focus back on the button), an
 * outside click and a route change. Switch account and Sign out ask first
 * while the player holds a seat.
 */
export function AccountMenu() {
  const user = useAuthStore((s) => s.user);
  const activeTableId = useAuthStore((s) => s.activeTableId);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"logout" | "switch" | null>(null);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!user) return null;

  const run = (action: "logout" | "switch") => {
    setOpen(false);
    setConfirm(null);
    void (action === "switch" ? switchAccount() : signOut({ reason: "logout" }));
  };
  const request = (action: "logout" | "switch") => {
    if (activeTableId) { setOpen(false); setConfirm(action); } else run(action);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="account-menu-button"
        aria-label={`Account menu, signed in as ${user.username}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/30 py-1 pl-1 pr-3 text-sm text-emerald-50 transition hover:border-amber-200/40"
      >
        <Avatar username={user.username} hue={user.avatarHue} size="sm" />
        <span className="hidden max-w-[10rem] truncate font-semibold sm:inline">{user.username}</span>
        <ChevronDownIcon className="h-4 w-4" />
      </button>
      {open ? (
        <div id={panelId}
          className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-amber-200/25 bg-[#0b2a20] p-2 shadow-2xl">
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar username={user.username} hue={user.avatarHue} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-emerald-50">{user.username}</p>
              {user.email ? <p className="truncate text-xs text-emerald-50/90">{user.email}</p> : null}
              {user.emailVerified === true ? <Badge tone="success">Email verified</Badge>
                : user.emailVerified === false ? <Badge tone="warning">Email not verified</Badge> : null}
            </div>
          </div>
          <div className="mx-3 my-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
            <p className="flex items-baseline justify-between text-sm text-emerald-50">
              <span>Play chips</span><span className="font-semibold tabular-nums">{formatChips(user.bankroll)}</span>
            </p>
            <p className="mt-1 text-xs text-emerald-50/90">{PLAY_CHIPS_NOTICE}</p>
          </div>
          <nav aria-label="Account" className="mt-1 flex flex-col">
            <Link href="/" className={`${ITEM} sm:hidden`}>Lobby</Link>
            <Link href="/account" className={ITEM}>Account</Link>
            <Link href="/account/security" className={ITEM}>Account &amp; security</Link>
            <Link href="/responsible-gaming" className={ITEM}>Responsible gaming</Link>
          </nav>
          <div className="mt-1 border-t border-white/10 pt-1">
            <button type="button" className={ITEM} onClick={() => request("switch")}>Switch account</button>
            <button type="button" className={ITEM} onClick={() => request("logout")}>Sign out</button>
          </div>
        </div>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={confirm === "switch" ? "Switch account?" : "Sign out?"}
          body="You're seated at a table. Signing out keeps your seat, but you'll be sat out automatically if you miss your turn."
          confirmLabel={confirm === "switch" ? "Switch anyway" : "Sign out anyway"}
          onConfirm={() => run(confirm)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
