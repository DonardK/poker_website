import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

/** Table URLs are per-session and not useful to index. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/table/"],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
