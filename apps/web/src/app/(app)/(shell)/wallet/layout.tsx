import { WalletFrame } from "@/components/wallet/wallet-frame";

/** Every wallet page: one <main>, the summary loaded once, the sandbox banner when it applies. */
export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
      <WalletFrame>{children}</WalletFrame>
    </main>
  );
}
