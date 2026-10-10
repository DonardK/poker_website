import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";

export interface AccessSettings { aud: string; team: string }

const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Production sets both Worker vars. When neither is set (tests, local),
 * Access is not enforced; the database role check still is.
 * Setting only one is a misconfiguration.
 */
export function accessSettings(env: Env): AccessSettings | null {
  const aud = env.CF_ACCESS_AUD?.trim() ?? "";
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim().toLowerCase() ?? "";
  const production = env.CLIENT_ORIGIN.trim().startsWith("https://");
  if (!aud && !team) {
    if (production) throw new Error("Cloudflare Access requires both CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN");
    return null;
  }
  if (!aud || !team || !TEAM_NAME.test(team) || aud.length > 256) {
    throw new Error("Cloudflare Access requires both CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN");
  }
  return { aud, team };
}

function jwks(team: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByTeam.get(team);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`));
    jwksByTeam.set(team, set);
  }
  return set;
}

/** True when the Access JWT's signature, issuer, audience, and expiry check out. */
export async function accessJwtValid(token: string, settings: AccessSettings): Promise<boolean> {
  if (token.length === 0 || token.length > 8192) return false;
  try {
    await jwtVerify(token, jwks(settings.team), {
      algorithms: ["RS256"],
      issuer: `https://${settings.team}.cloudflareaccess.com`,
      audience: settings.aud,
    });
    return true;
  } catch {
    return false;
  }
}
