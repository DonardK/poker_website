import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WalletScreen } from "@/components/wallet/wallet-screen";
import { cleanObjectId, depositReturnPath } from "@/lib/wallet-ids";

export const metadata: Metadata = { title: "Wallet" };

/**
 * The payments Worker sends a player back from the provider's payment page
 * to /wallet?deposit=<id> (apps/edge/src/payments/deposits.ts returnUrl):
 * that lands on the deposit's outcome page, which reads the status from the
 * API. Nothing else in the query string is looked at.
 */
export default async function WalletPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { deposit } = await searchParams;
  const depositId = cleanObjectId(typeof deposit === "string" ? deposit : null);
  if (depositId) redirect(depositReturnPath(depositId));
  return <WalletScreen />;
}
