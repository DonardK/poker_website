import type { Metadata } from "next";
import { SecurityScreen } from "@/components/security/security-screen";

export const metadata: Metadata = { title: "Account & security" };

export default function AccountSecurityPage() {
  return <SecurityScreen />;
}
