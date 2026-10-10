/**
 * Pure startup checks used by config.ts. No configuration is read here, so
 * each rule can be tested directly; config.ts applies them to process.env and
 * refuses to start (before any database or Redis connection) when one fails.
 */

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Parses a token lifetime: an integer with a unit ("90s", "15m", "12h", "7d")
 * or a bare integer number of SECONDS ("900"). Returns whole seconds.
 *
 * Why normalise: jsonwebtoken reads a digits-only STRING as milliseconds
 * ("900" = 0.9 s) but a number as seconds. config.ts re-exports the TTL as
 * "<seconds>s", which jsonwebtoken and this parser read the same way.
 */
export function parseDurationSeconds(raw: string, name: string): number {
  const match = /^(\d{1,9})([smhd])?$/.exec(raw.trim());
  if (!match) throw new Error(`${name} must be an integer number of seconds or an integer with a unit s, m, h or d (e.g. "15m", "7d")`);
  return Number(match[1]) * UNIT_SECONDS[match[2] ?? "s"]!;
}

/** parseDurationSeconds plus inclusive bounds; the message states the bounds, not the value. */
export function boundedDurationSeconds(raw: string, name: string, minSeconds: number, maxSeconds: number, bounds: string): number {
  const seconds = parseDurationSeconds(raw, name);
  if (seconds < minSeconds || seconds > maxSeconds) throw new Error(`${name} must be between ${bounds}`);
  return seconds;
}

/**
 * Hosting suffixes on the Public Suffix List: every customer subdomain is its
 * own site, so two apps under one of these can never be same-site.
 */
export const SHARED_HOSTING_SUFFIXES = [
  "vercel.app", "netlify.app", "onrender.com", "herokuapp.com", "github.io", "pages.dev", "fly.dev", "railway.app",
  "azurewebsites.net", "cloudfront.net", "appspot.com", "firebaseapp.com", "web.app",
] as const;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

const withinSite = (host: string, site: string): boolean => host === site || host.endsWith(`.${site}`);

/**
 * SameSite=Strict refresh cookie reachability (production only).
 *
 * The refresh cookie is host-only on the API host and SameSite=Strict, so the
 * browser sends it on the web app's refresh request only when the web app
 * (CLIENT_ORIGIN) and the API (PUBLIC_API_ORIGIN) are the SAME SITE, i.e.
 * share a registrable domain. When the two hosts differ they must both sit
 * under COOKIE_SITE, a registrable domain of at least two labels that is not
 * a shared-hosting suffix; otherwise every player would be logged out at the
 * first access-token expiry. Throws with an explanation.
 */
export function assertCookieSite(clientOrigin: string, publicApiOrigin: string | undefined, cookieSite: string | undefined): void {
  if (!publicApiOrigin) return;
  const clientHost = new URL(clientOrigin).hostname.toLowerCase();
  const api = new URL(publicApiOrigin);
  if (api.protocol !== "https:") throw new Error("PUBLIC_API_ORIGIN must use https in production");
  const apiHost = api.hostname.toLowerCase();
  if (apiHost === clientHost) return;
  const explain = `The refresh cookie is SameSite=Strict and host-only on the API host (${apiHost}); browsers send it from the web app (${clientHost}) only when both are the same site.`;
  const site = cookieSite?.trim().toLowerCase().replace(/^\./, "");
  if (!site) throw new Error(`${explain} Set COOKIE_SITE to the registrable domain both hosts share (e.g. example.com for app.example.com and api.example.com), or serve both from one host.`);
  const labels = site.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) throw new Error(`COOKIE_SITE must be a registrable domain with at least two labels (e.g. example.com). ${explain}`);
  if ((SHARED_HOSTING_SUFFIXES as readonly string[]).includes(site)) {
    throw new Error(`COOKIE_SITE "${site}" is a shared-hosting suffix: every subdomain under it is a separate site, so the SameSite=Strict refresh cookie would never be sent. ${explain} Use a custom domain for both hosts.`);
  }
  if (!withinSite(clientHost, site) || !withinSite(apiHost, site)) throw new Error(`CLIENT_ORIGIN and PUBLIC_API_ORIGIN must both be ${site} or a subdomain of it. ${explain}`);
}
