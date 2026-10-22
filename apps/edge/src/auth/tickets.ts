import type { AuthMethod } from "@poker/shared";
import { jwtVerify, SignJWT } from "jose";
import type { AppDb } from "../http/db";
import { hmacSha256, utf8 } from "./bytes";
import { uniqueViolation } from "./errors";

/**
 * Short-lived signed tickets for the account-security flows, and their
 * single-use marks.
 *
 * - MFA ticket: issued after a correct password when the account has TOTP;
 *   it carries the sign-in (or step-up) to the second-factor request.
 * - WebAuthn challenge token: the challenge travels in the JSON body, signed,
 *   so an options request writes nothing to the database.
 *
 * Both are HS256 (jose) under a subkey of AUTH_HMAC_SECRET, issuer
 * poker-server, audience poker-auth, 5 minutes. Single use is enforced by
 * inserting the jti into AuthNonce only after the rest of the check passed.
 * Verification returns null for any problem; callers answer with their own code.
 */

const ISSUER = "poker-server";
const AUDIENCE = "poker-auth";
export const TICKET_TTL_MS = 5 * 60_000;
const MAX_TOKEN_LENGTH = 2048;

type Label = "mfa-ticket" | "webauthn-challenge" | "backup-code" | "step-up-email-code";
const subkeys = new Map<string, Promise<Uint8Array>>();

/** HMAC-SHA256(utf8(secret), "poker-auth:v1:<label>"), cached per isolate. One key per purpose. */
export function subkey(secret: string, label: Label): Promise<Uint8Array> {
  const cacheKey = `${label}\u0000${secret}`;
  let key = subkeys.get(cacheKey);
  if (!key) {
    key = hmacSha256(utf8(secret), `poker-auth:v1:${label}`);
    subkeys.set(cacheKey, key);
    if (subkeys.size > 16) subkeys.delete(subkeys.keys().next().value!);
  }
  return key;
}

export type TicketPurpose = "login" | "reauth";

export interface MfaTicketClaims {
  typ: "mfa";
  pur: TicketPurpose;
  sub: string;
  /** reauth: the session that is stepping up. */
  sid?: string;
  /** login: SHA-256 of the poker_device cookie the password was sent with. */
  dev?: string;
  /** User.credentialsVersion when the password was checked. */
  cv: number;
  /** "Keep me signed in". */
  rem: boolean;
  amr: AuthMethod[];
  jti: string;
  exp: number;
}

export type ChallengePurpose = "login" | "reauth" | "register";

export interface ChallengeClaims {
  typ: "webauthn";
  pur: ChallengePurpose;
  /** base64url challenge given to the browser. */
  chal: string;
  sub?: string;
  sid?: string;
  /** Optional money binding (reauth only): the grant purpose and bind hash this assertion is for. */
  gp?: string;
  gb?: string;
  jti: string;
  exp: number;
}

async function sign(secret: string, label: Label, claims: Record<string, unknown>, now: number): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(now + TICKET_TTL_MS);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(await subkey(secret, label));
  return { token, jti, expiresAt };
}

async function verify(secret: string, label: Label, token: unknown): Promise<Record<string, unknown> | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, await subkey(secret, label), { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.jti !== "string" || payload.jti.length < 8 || payload.jti.length > 128 || typeof payload.exp !== "number") return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

const AMR = new Set<AuthMethod>(["pwd", "otp", "backup", "passkey"]);
const optionalString = (value: unknown) => value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128);

export async function signMfaTicket(secret: string, claims: Omit<MfaTicketClaims, "typ" | "jti" | "exp">, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
  const { token, expiresAt } = await sign(secret, "mfa-ticket", { ...claims, typ: "mfa" }, now);
  return { token, expiresAt };
}

export async function verifyMfaTicket(secret: string, token: unknown, pur: TicketPurpose): Promise<MfaTicketClaims | null> {
  const claims = await verify(secret, "mfa-ticket", token);
  if (!claims || claims.typ !== "mfa" || claims.pur !== pur) return null;
  if (typeof claims.sub !== "string" || !claims.sub || !optionalString(claims.sid) || !optionalString(claims.dev)) return null;
  if (!Number.isSafeInteger(claims.cv) || typeof claims.rem !== "boolean") return null;
  if (!Array.isArray(claims.amr) || !claims.amr.every((method) => AMR.has(method as AuthMethod))) return null;
  return claims as unknown as MfaTicketClaims;
}

export async function signChallenge(secret: string, claims: Omit<ChallengeClaims, "typ" | "jti" | "exp">, now = Date.now()): Promise<string> {
  return (await sign(secret, "webauthn-challenge", { ...claims, typ: "webauthn" }, now)).token;
}

export async function verifyChallenge(secret: string, token: unknown, pur: ChallengePurpose): Promise<ChallengeClaims | null> {
  const claims = await verify(secret, "webauthn-challenge", token);
  if (!claims || claims.typ !== "webauthn" || claims.pur !== pur) return null;
  if (typeof claims.chal !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claims.chal)) return null;
  if (!optionalString(claims.sub) || !optionalString(claims.sid) || !optionalString(claims.gp) || !optionalString(claims.gb)) return null;
  return claims as unknown as ChallengeClaims;
}

/**
 * Mark a ticket or challenge as used (AuthNonce primary key = jti). False when
 * it was already used. Never call inside a transaction that must survive the
 * duplicate: on Postgres the unique violation aborts that transaction.
 */
export async function consumeNonce(db: AppDb, jti: string, purpose: string, expiresAt: Date): Promise<boolean> {
  try {
    await db.authNonce.create({ data: { id: jti, purpose, expiresAt } });
    return true;
  } catch (err) {
    if (uniqueViolation(err)) return false;
    throw err;
  }
}

/** True when the ticket or challenge was already used, or burned after a run of wrong codes. */
export async function nonceUsed(db: AppDb, jti: string): Promise<boolean> {
  return await db.authNonce.findUnique({ where: { id: jti }, select: { id: true } }) !== null;
}

/** The expiry a nonce row needs: the ticket's own, so the sweep can drop it afterwards. */
export function nonceExpiry(claims: { exp: number }): Date {
  return new Date(claims.exp * 1000);
}
