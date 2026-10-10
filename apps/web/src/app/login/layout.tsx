import type { Metadata } from "next";
import { PLAY_MONEY_NOTICE } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Sign in",
  description: `Sign in or create an account at Hold'em Live. ${PLAY_MONEY_NOTICE}. 18+.`,
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
