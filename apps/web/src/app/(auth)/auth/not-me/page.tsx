import type { Metadata } from "next";
import { NotMeScreen } from "@/components/auth/not-me-screen";

export const metadata: Metadata = {
  title: "Secure your account",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function NotMePage() {
  return <NotMeScreen />;
}
