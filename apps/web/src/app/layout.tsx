import type { Metadata } from "next";
import { Fraunces, Outfit } from "next/font/google";
import { AuthHydrator } from "@/components/auth-hydrator";
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
  description: "Real-time Texas Hold'em with autonomous AI opponents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="antialiased" suppressHydrationWarning>
        <AuthHydrator>{children}</AuthHydrator>
      </body>
    </html>
  );
}
