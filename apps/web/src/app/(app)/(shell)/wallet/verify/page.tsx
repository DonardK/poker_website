import type { Metadata } from "next";
import { KycScreen } from "@/components/wallet/kyc-screen";

export const metadata: Metadata = { title: "Verify your identity" };

/** SECURITY: the only page whose policy allows the KYC provider's WebSDK (src/lib/routes.ts KYC_SDK_PATH). */
export default function VerifyPage() {
  return <KycScreen />;
}
