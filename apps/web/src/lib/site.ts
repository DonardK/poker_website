/**
 * Public site origin for metadata, robots.txt and the sitemap.
 * NEXT_PUBLIC_SITE_URL is the production origin (no trailing path). When it
 * is missing or not an http(s) URL, local development is the fallback so
 * builds still emit absolute links.
 */
export function siteOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // A malformed value must not break the build; the fallback below is used.
    }
  }
  return "http://localhost:3000";
}

export const SITE_NAME = "Hold'em Live";

/** Kept in the default <meta name="description">: human multiplayer, play chips, no cash value. */
export const SITE_DESCRIPTION =
  "Real-time multiplayer Texas Hold'em between human players. Play chips only: no cash value, not redeemable. 18+.";
