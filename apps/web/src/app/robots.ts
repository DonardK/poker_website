import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

/** Only the sign-in pages and the legal documents are public; account, table and email-link pages are not useful to index. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/table/", "/account", "/wallet", "/welcome", "/auth/", "/reset-password", "/verify-email", "/email-change"],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
