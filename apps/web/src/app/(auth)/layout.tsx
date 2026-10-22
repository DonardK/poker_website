import { AuthShell } from "@/components/auth/auth-shell";

/** Sign-in, sign-up and the email-link pages: the brand hero beside the form card. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
