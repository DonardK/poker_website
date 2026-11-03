import type { Metadata } from "next";
import { DepositReturnScreen } from "@/components/wallet/deposit-return-screen";

export const metadata: Metadata = { title: "Your deposit" };

/**
 * Every provider return URL (success, pending, back, failure) lands here with
 * the deposit id; any outcome in the query string is ignored.
 */
export default async function DepositReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const pick = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);
  return <DepositReturnScreen depositParam={pick(params.deposit) ?? pick(params.d) ?? pick(params.depositId)} />;
}
