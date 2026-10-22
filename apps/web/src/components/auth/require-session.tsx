"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GuestRetiredPrompt } from "@/components/auth/guest-retired-prompt";
import { SessionSplash } from "@/components/auth/session-splash";
import { ServiceUnavailableScreen, SignedOutPanel } from "@/components/auth/signed-out-panels";
import { TermsUpdatePrompt } from "@/components/auth/terms-update-prompt";
import { TERMS_VERSION } from "@/lib/legal";
import { safeNext } from "@/lib/safe-next";
import { useAuthStore } from "@/stores/session";

/** /login with this page as `next` (validated, so it can never point elsewhere). */
function loginHref(): string {
  const here = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  return `/login?next=${encodeURIComponent(safeNext(here))}`;
}

/**
 * SECURITY: the authority of the sign-in gate (owner decision: no guest play,
 * signed-out visitors see only the legal and sign-in pages). Every page under
 * the (app) route group renders only for a signed-in account; the API refuses
 * data without a bearer token anyway, and no server component renders user
 * data. The middleware's hint-cookie redirect is only a fast path.
 *
 * The children are keyed by the user id: switching account remounts the
 * whole tree, so no component state of account A survives into account B
 * (on top of resetClientState). A token refresh keeps the id and the tree.
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const apiOffline = useAuthStore((s) => s.apiOffline);
  const exitTo = useAuthStore((s) => s.exitTo);
  const [href, setHref] = useState("/login");
  const signedOut = hydrated && !user && !apiOffline;

  useEffect(() => {
    if (!signedOut) return;
    const target = exitTo ?? loginHref();
    setHref(target);
    router.replace(target);
  }, [signedOut, exitTo, router]);

  if (!hydrated) return <SessionSplash />;
  if (!user && apiOffline) return <ServiceUnavailableScreen />;
  if (!user) return <SignedOutPanel href={href} />;
  if (user.isGuest) return <GuestRetiredPrompt />;
  // COMPLIANCE: an account on older terms (or none, null) accepts the current ones first. Undefined: an API
  // that does not report the field, so no prompt.
  if (user.termsVersion !== undefined && user.termsVersion !== TERMS_VERSION) return <TermsUpdatePrompt />;
  return <Fragment key={user.id}>{children}</Fragment>;
}
