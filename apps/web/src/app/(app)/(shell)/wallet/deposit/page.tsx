import type { Metadata } from "next";
import { DepositScreen, type DepositTab } from "@/components/wallet/deposit-screen";

export const metadata: Metadata = { title: "Deposit" };

export default async function DepositPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { method } = await searchParams;
  const tab: DepositTab | null = method === "card" || method === "crypto" ? method : null;
  return <DepositScreen initialTab={tab} />;
}
