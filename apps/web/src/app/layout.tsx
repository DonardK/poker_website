import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Fraunces, Outfit } from "next/font/google";
import { AuthHydrator } from "@/components/auth-hydrator";
import { SiteFooter } from "@/components/site-footer";
import { TableIdleNotice } from "@/components/table-idle-notice";
import { isTurnstilePath } from "@/lib/routes";
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
  // turnstile.render. SECURITY (G6): third-party script only where a form
  // needs it (/login, /signup, /reset-password; middleware passes the path),
  // never on the lobby, table or account pages. Omitted without a site key.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  const turnstile = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()) && isTurnstilePath(requestHeaders.get("x-pathname"));
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="flex min-h-screen flex-col antialiased" suppressHydrationWarning>
        <a href="#main-content"
          className="sr-only z-[80] rounded-full bg-amber-300 px-4 py-2 font-semibold text-emerald-950 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
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
