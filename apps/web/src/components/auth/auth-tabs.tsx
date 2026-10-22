import Link from "next/link";

/** "Sign in" / "Create account", as links (two pages), keeping `next`. */
export function AuthTabs({ active, next }: { active: "login" | "signup"; next: string }) {
  const query = next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  const tab = (key: "login" | "signup", href: string, label: string) => (
    <Link href={`${href}${query}`} aria-current={active === key ? "page" : undefined}
      className={`flex min-h-11 flex-1 items-center justify-center rounded-full px-4 text-sm font-semibold transition ${
        active === key ? "bg-amber-300 text-emerald-950" : "text-amber-100 hover:bg-white/10"}`}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Account access" className="mb-6 flex gap-1 rounded-full border border-white/15 bg-black/30 p-1">
      {tab("login", "/login", "Sign in")}
      {tab("signup", "/signup", "Create account")}
    </nav>
  );
}
