import type { Metadata } from "next";
import { KycReturnScreen } from "@/components/wallet/kyc-screen";

export const metadata: Metadata = { title: "Identity verification" };

export default function VerifyReturnPage() {
  return <KycReturnScreen />;
}
