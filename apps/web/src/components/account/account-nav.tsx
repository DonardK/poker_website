"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/account", label: "Profile" },
  { href: "/account/security", label: "Security" },
] as const;

/** The account section's own navigation: a sidebar on wide screens, a row of tabs on phones. */
export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account sections">
      <ul className="flex gap-1 rounded-full border border-white/15 bg-black/30 p-1 lg:flex-col lg:rounded-2xl lg:p-2">
        {ITEMS.map((item) => {
          const current = pathname === item.href;
          return (
            <li key={item.href} className="flex-1 lg:flex-none">
              <Link href={item.href} aria-current={current ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold transition lg:justify-start lg:rounded-xl ${
                  current ? "bg-amber-300 text-emerald-950" : "text-amber-100 hover:bg-white/10"}`}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
