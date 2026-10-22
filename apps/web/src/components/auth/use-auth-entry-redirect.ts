"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { leaveAuthPage } from "@/lib/session-actions";
import { useAuthStore } from "@/stores/session";

/**
 * /login and /signup when a session already exists (the silent refresh found
 * one): go on to `next`. `paused` while this page completes its own sign-in,
 * which navigates by itself (sign-up goes to /welcome, not to `next`).
 */
export function useAuthEntryRedirect({ next, paused }: { next: string; paused: boolean }): boolean {
  const router = useRouter();
  const signedIn = useAuthStore((s) => s.hydrated && s.user !== null);
  const redirecting = signedIn && !paused;
  useEffect(() => {
    if (redirecting) leaveAuthPage(router, next);
  }, [redirecting, next, router]);
  return redirecting;
}
