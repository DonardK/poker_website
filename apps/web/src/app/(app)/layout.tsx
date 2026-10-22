import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { StepUpProvider } from "@/components/auth/step-up";

/** Account pages are never indexed: a signed-out visitor only ever sees the sign-in page here. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * SECURITY: everything in this route group needs a signed-in account
 * (RequireSession is the authority; the middleware's hint redirect is only a
 * fast path). The step-up provider ("Confirm it's you") is per account: it
 * sits inside the gate's per-user remount.
 */
export default function SignedInLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireSession>
      <StepUpProvider>{children}</StepUpProvider>
    </RequireSession>
  );
}
