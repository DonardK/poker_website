import Link from "next/link";
import { LEGAL_PAGES, PLAY_CHIPS_NOTICE } from "@/lib/legal";

/** Links to every legal document, on every page (decision D10). */
export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-8 pt-4 text-sm text-emerald-50/90 sm:px-8">
      <div className="border-t border-white/15 pt-5">
        <nav aria-label="Legal">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {LEGAL_PAGES.map((page) => (
              <li key={page.href}>
                <Link href={page.href} className="underline decoration-white/40 underline-offset-4 hover:decoration-amber-200">
                  {page.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className="mt-3">
          18+ only. {PLAY_CHIPS_NOTICE} Real-money play is not offered and will only start under a Malta Gaming Authority
          licence.
        </p>
      </div>
    </footer>
  );
}
