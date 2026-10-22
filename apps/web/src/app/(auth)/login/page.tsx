import type { Metadata } from "next";
import { LoginScreen } from "@/components/auth/login-screen";
import { PLAY_MONEY_NOTICE } from "@/lib/legal";
import { firstParam, safeNext, safeUsername } from "@/lib/safe-next";

export const metadata: Metadata = {
  title: "Sign in",
  description: `Sign in to Hold'em Live. ${PLAY_MONEY_NOTICE}. 18+.`,
};

/** ?notice= values other pages send here, and what they mean to the person arriving. */
const NOTICES: Record<string, string> = {
  reset: "Your password was changed. Sign in with your new password.",
  verified: "Email verified. Sign in to continue.",
  secured: "We signed you out everywhere. Set a new password to continue.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const notice = firstParam(params.notice);
  return (
    <LoginScreen
      next={safeNext(firstParam(params.next))}
      as={safeUsername(firstParam(params.as))}
      switching={firstParam(params.switch) === "1"}
      notice={notice && Object.hasOwn(NOTICES, notice) ? NOTICES[notice]! : null}
    />
  );
}
