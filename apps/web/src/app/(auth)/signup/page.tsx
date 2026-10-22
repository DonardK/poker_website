import type { Metadata } from "next";
import { SignupScreen } from "@/components/auth/signup-screen";
import { PLAY_MONEY_NOTICE } from "@/lib/legal";
import { firstParam, safeNext } from "@/lib/safe-next";

export const metadata: Metadata = {
  title: "Create an account",
  description: `Create a Hold'em Live account to play real-time Texas Hold'em. ${PLAY_MONEY_NOTICE}. 18+.`,
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <SignupScreen next={safeNext(firstParam(params.next))} />;
}
