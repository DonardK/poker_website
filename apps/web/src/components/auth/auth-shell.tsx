import Link from "next/link";
import { FingerprintIcon, ShieldIcon } from "@/components/ui/icons";

/**
 * The frame of the sign-in, sign-up and email-link pages: a brand hero
 * beside the card on wide screens, a compact brand bar above it on phones.
 * The site footer (every legal link) stays below, as on every page.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:items-start lg:gap-12">
      <div className="flex items-center gap-3 lg:hidden">
        <span aria-hidden="true" className="text-2xl text-amber-200">♠</span>
        <p className="font-[family-name:var(--font-display)] text-2xl font-semibold">Hold&apos;em Live</p>
      </div>
      <aside className="relative hidden overflow-hidden rounded-3xl border border-amber-200/20 bg-emerald-950/60 p-8 shadow-2xl lg:block">
        <div aria-hidden="true" className="absolute -right-12 -top-12 h-44 w-44 rounded-full border-[24px] border-amber-300/10" />
        <p className="relative text-sm uppercase tracking-[0.28em] text-amber-200">No-limit Hold&apos;em · play chips</p>
        <p className="relative mt-3 font-[family-name:var(--font-display)] text-4xl font-semibold leading-tight">
          Real-time poker against real people
        </p>
        <div aria-hidden="true" className="relative mt-8 flex gap-2">
          <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-red-700 shadow-xl">A♥</span>
          <span className="grid h-20 w-14 place-items-center rounded-lg border border-white bg-stone-100 text-2xl font-bold text-zinc-900 shadow-xl">K♠</span>
        </div>
        <ul className="relative mt-8 flex flex-col gap-3 text-emerald-50">
          <li className="flex items-center gap-3">
            <ShieldIcon className="h-5 w-5 text-amber-200" />
            <span>Provably fair — <Link href="/fairness" className="text-amber-100 underline underline-offset-4">verify every hand</Link></span>
          </li>
          <li className="flex items-center gap-3">
            <FingerprintIcon className="h-5 w-5 text-amber-200" />
            <span>Passkeys and two-step verification</span>
          </li>
          <li className="flex items-center gap-3">
            <span aria-hidden="true" className="w-5 text-center font-bold text-amber-200">18</span>
            <span>18+ · <Link href="/responsible-gaming" className="text-amber-100 underline underline-offset-4">play responsibly</Link></span>
          </li>
        </ul>
      </aside>
      <div className="rounded-3xl border border-amber-200/25 bg-black/40 p-6 shadow-2xl sm:p-8">{children}</div>
    </main>
  );
}
