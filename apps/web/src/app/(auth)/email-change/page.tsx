import type { Metadata } from "next";
import { EmailChangeScreen } from "@/components/auth/email-change-screen";

/** The token is in the URL fragment; no-referrer keeps even the path out of other sites' logs. */
export const metadata: Metadata = {
  title: "Confirm your new email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function EmailChangePage() {
  return <EmailChangeScreen />;
}
