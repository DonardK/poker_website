"use client";

import Link from "next/link";
import { useAuthStore } from "@/stores/session";

/** "← Lobby" for a signed-in visitor, "← Sign in" otherwise (the lobby is behind the sign-in gate). */
export function BackHomeLink({ variant = "text" }: { variant?: "text" | "button" }) {
  const signedIn = useAuthStore((s) => s.user !== null);
  const label = variant === "button" ? (signedIn ? "Back to the lobby" : "Sign in") : signedIn ? "← Lobby" : "← Sign in";
  const href = signedIn ? "/" : "/login";
  if (variant === "button") {
    return (
      <Link href={href} className="mx-auto mt-8 inline-flex min-h-12 items-center rounded-full bg-amber-300 px-6 py-3 font-semibold text-emerald-950">
        {label}
      </Link>
    );
  }
  return <Link href={href} className="text-sm text-amber-100 underline-offset-4 hover:underline">{label}</Link>;
}
