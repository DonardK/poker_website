import type { Metadata } from "next";
import { WithdrawScreen } from "@/components/wallet/withdraw-screen";

export const metadata: Metadata = { title: "Withdraw" };

export default function WithdrawPage() {
  return <WithdrawScreen />;
}
