import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal";
import { siteOrigin } from "@/lib/site";

/** Public pages only. Live tables are session-specific and omitted. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const paths = ["/", "/login", ...LEGAL_PAGES.map((page) => page.href)];
  return paths.map((path) => ({
    url: new URL(path, origin).href,
    changeFrequency: path === "/" ? "daily" : "monthly",
    priority: path === "/" ? 1 : path === "/login" ? 0.6 : 0.4,
  }));
}
