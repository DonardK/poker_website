"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/shell/account-menu";
import { BalancePill } from "@/components/shell/balance-pill";

const NAV = [{ href: "/", label: "Lobby" }] as const;

/** The signed-in header: brand (a link, not a heading), the main nav on wide screens, balance and account menu. */
export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#071912]/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-8">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-[family-name:var(--font-display)] text-xl font-semibold text-emerald-50">Hold&apos;em Live</Link>
          <nav aria-label="Main" className="hidden sm:block">
            <ul className="flex gap-4 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} aria-current={pathname === item.href ? "page" : undefined}
                    className="text-emerald-50 underline-offset-4 hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-amber-100">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <BalancePill />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
