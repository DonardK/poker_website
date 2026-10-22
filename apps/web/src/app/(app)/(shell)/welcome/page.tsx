import type { Metadata } from "next";
import { WelcomeScreen } from "@/components/auth/welcome-screen";
import { firstParam, safeNext } from "@/lib/safe-next";

export const metadata: Metadata = { title: "Welcome" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function WelcomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <WelcomeScreen next={safeNext(firstParam(params.next))} />;
}
