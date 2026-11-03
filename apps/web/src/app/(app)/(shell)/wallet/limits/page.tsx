import type { Metadata } from "next";
import { LimitsScreen } from "@/components/wallet/limits-screen";

export const metadata: Metadata = { title: "Deposit limits" };

export default function LimitsPage() {
  return <LimitsScreen />;
}
