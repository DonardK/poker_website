import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";

export interface AccessSettings { aud: string; team: string }

const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function accessRequired(env: Env): boolean {
  const raw = (env.ADMIN_REQUIRE_CF_ACCESS ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error("ADMIN_REQUIRE_CF_ACCESS must be true or false");
}

/**
 * `ADMIN_REQUIRE_CF_ACCESS=false` (the workers.dev demo) skips the Access JWT
 * when both CF_ACCESS vars are unset. An https CLIENT_ORIGIN does not 500.
 * The database role check still runs.
 *
 * `ADMIN_REQUIRE_CF_ACCESS=true` is the strict check: an https origin with
 * neither var set is a misconfiguration. Setting only one var always is.
 */
export function accessSettings(env: Env): AccessSettings | null {
  const aud = env.CF_ACCESS_AUD?.trim() ?? "";
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim().toLowerCase() ?? "";
  const production = env.CLIENT_ORIGIN.trim().startsWith("https://");
  if (!aud && !team) {
    if (accessRequired(env) && production) {
      throw new Error("Cloudflare Access requires both CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN");
    }
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
