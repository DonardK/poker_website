import { AccountNav } from "@/components/account/account-nav";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" className="mx-auto grid w-full max-w-6xl items-start gap-6 px-4 py-8 sm:px-8 sm:py-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <AccountNav />
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </main>
  );
}
