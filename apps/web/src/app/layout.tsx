import type { Metadata } from "next";
import { connection } from "next/server";
import { Fraunces, Outfit } from "next/font/google";
import { AuthHydrator } from "@/components/auth-hydrator";
import { SiteFooter } from "@/components/site-footer";
import { TableIdleNotice } from "@/components/table-idle-notice";
import "./globals.css";

const sans = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
});

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Hold'em Live",
  description: "Real-time multiplayer Texas Hold'em between human players. Play chips only: no cash value, not redeemable. 18+.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SECURITY: the Content-Security-Policy (middleware.ts) allows scripts only
  // with a per-request nonce, which Next.js stamps on its own scripts while
  // rendering. A statically prerendered page would carry no nonce and every
  // script on it would be blocked, so every page is rendered per request.
  await connection();
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="flex min-h-screen flex-col antialiased" suppressHydrationWarning>
        <AuthHydrator>
          <div className="flex-1">{children}</div>
          {/* A seated player's idle-closing warning, wherever they are in the app. */}
          <TableIdleNotice />
        </AuthHydrator>
        <SiteFooter />
      </body>
    </html>
  );
}
