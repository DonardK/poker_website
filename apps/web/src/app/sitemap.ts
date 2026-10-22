import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal";
import { siteOrigin } from "@/lib/site";

/** Public pages only: sign-in, sign-up and the legal documents. Everything else needs an account. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const paths = ["/login", "/signup", ...LEGAL_PAGES.map((page) => page.href)];
  return paths.map((path) => ({
    url: new URL(path, origin).href,
    changeFrequency: "monthly",
    priority: path === "/login" || path === "/signup" ? 0.8 : 0.4,
  }));
}
