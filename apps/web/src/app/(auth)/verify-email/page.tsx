import type { Metadata } from "next";
import { VerifyEmailScreen } from "@/components/auth/verify-email-screen";

/** The token is in the URL fragment; no-referrer keeps even the path out of other sites' logs. */
export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function VerifyEmailPage() {
  return <VerifyEmailScreen />;
}
