import { AppHeader } from "@/components/shell/app-header";
import { EmailVerificationBanner } from "@/components/shell/email-verification-banner";

/**
 * The signed-in frame of every page except the table (which is immersive):
 * the header with the balance and account menu, and the email banner while
 * the address is unconfirmed. Each page renders its own <main id="main-content">.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader />
      <EmailVerificationBanner />
      {children}
    </>
  );
}
