import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Fraunces, Outfit } from "next/font/google";
import { AuthHydrator } from "@/components/auth-hydrator";
import { SiteFooter } from "@/components/site-footer";
import { TableIdleNotice } from "@/components/table-idle-notice";
import { SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "@/lib/site";
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
  metadataBase: new URL(siteOrigin()),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#071912",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SECURITY: the Content-Security-Policy (middleware.ts) allows scripts only
  // with a per-request nonce, which Next.js stamps on its own scripts while
  // rendering. A statically prerendered page would carry no nonce and every
  // script on it would be blocked, so every page is rendered per request.
  await connection();
  // Browsers hide a script's nonce from later script, so the Turnstile API
  // tag has to be rendered here with the request nonce. The widget only calls
  // turnstile.render. Omit the tag when no site key is configured.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const turnstile = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="flex min-h-screen flex-col antialiased" suppressHydrationWarning>
        {turnstile ? <script id="cf-turnstile-api" async nonce={nonce} src={TURNSTILE_SCRIPT_SRC} /> : null}
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
