/**
 * Hawk request authentication as BVNK uses it
 * (https://docs.bvnk.com/bvnk/api-explorer/api-overview/authentication/,
 * verified 2026-10-29): `Authorization: Hawk id, ts, nonce, mac`, where mac
 * is base64(HMAC-SHA256(Hawk Auth Key, normalized)) and normalized is
 *
 *   hawk.1.header \n ts \n nonce \n METHOD \n path?query \n host \n port \n hash \n ext \n
 *
 * BVNK does not use payload validation ("not activated for the BVNK API"),
 * so hash and ext are empty lines. The MAC binds the method, the exact path
 * and query, the host and the port: a relay (PAYMENTS_EGRESS_MODE=relay)
 * forwards the request unchanged, so the MAC is computed for BVNK's host,
 * never the relay's. The accepted clock skew is not documented (UNVERIFIED);
 * a burst of 401s means the clock or the allow-list is wrong.
 */
import { bytesToBase64, hmac } from "../wire";

export interface HawkCredentials {
  id: string;
  key: string;
}

/** Hawk ids, nonces and ext values are quoted header parameters: no quote or backslash. */
const HEADER_SAFE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export function hawkNormalized(input: {
  ts: string;
  nonce: string;
  method: string;
  resource: string;
  host: string;
  port: number;
  hash?: string;
  ext?: string;
}): string {
  return [
    "hawk.1.header",
    input.ts,
    input.nonce,
    input.method.toUpperCase(),
    input.resource,
    input.host.toLowerCase(),
    String(input.port),
    input.hash ?? "",
    input.ext ?? "",
    "",
  ].join("\n");
}

/**
 * The Authorization header for one request to `target` (BVNK's own URL,
 * whatever the egress). `ext` exists only to check the published Hawk test
 * vector; BVNK requests never set it.
 */
export async function hawkAuthorization(
  credentials: HawkCredentials,
  request: { method: string; target: URL },
  ts: number,
  nonce: string,
  ext?: string,
): Promise<string> {
  if (!HEADER_SAFE.test(credentials.id) || !HEADER_SAFE.test(nonce) || (ext !== undefined && !HEADER_SAFE.test(ext.replace(/ /g, "-")))) {
    throw new TypeError("hawk: id, nonce and ext must be header-safe");
  }
  const port = request.target.port ? Number(request.target.port) : request.target.protocol === "https:" ? 443 : 80;
  const normalized = hawkNormalized({
    ts: String(ts),
    nonce,
    method: request.method,
    resource: request.target.pathname + request.target.search,
    host: request.target.hostname,
    port,
    ext,
  });
  const mac = bytesToBase64(await hmac("SHA-256", credentials.key, normalized));
  const extPart = ext === undefined ? "" : `, ext="${ext}"`;
  return `Hawk id="${credentials.id}", ts="${ts}", nonce="${nonce}"${extPart}, mac="${mac}"`;
}
