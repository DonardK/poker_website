import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { authConfig, env } from "../config.js";
import { AuthError } from "./errors.js";

export interface AccessClaims { sub: string; sid: string; username: string; typ: "access"; exp: number }
export interface RefreshClaims { sub: string; sid: string; typ: "refresh"; exp: number }
const issuer = "poker-server";
const audience = "poker-client";

export function signAccessToken(userId: string, username: string, sessionId: string): string {
  const options: SignOptions = { algorithm: "HS256", issuer, audience, expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"], jwtid: randomUUID() };
  return jwt.sign({ sub: userId, sid: sessionId, username, typ: "access" }, env.JWT_ACCESS_SECRET, options);
}
/**
 * `expiresAt` is the session's expiry (Session.expiresAt), so the token, the
 * cookie and the row lapse together; the exp claim is set from it directly
 * (whole seconds, rounded down: the token never outlives the row).
 */
export function signRefreshToken(userId: string, sessionId: string, expiresAt = new Date(Date.now() + authConfig.sessionIdleTtlMs)): string {
  const options: SignOptions = { algorithm: "HS256", issuer, audience, jwtid: randomUUID() };
  return jwt.sign({ sub: userId, sid: sessionId, typ: "refresh", exp: Math.floor(expiresAt.getTime() / 1000) }, env.JWT_REFRESH_SECRET, options);
}
/** Signature, issuer/audience and expiry checks are pure cryptography: every failure is a credential problem (AuthError). */
function verify<T>(token: string, secret: string, typ: "access" | "refresh"): T & { sub: string; sid: string; typ: string; exp: number } {
  let decoded: { sub?: unknown; sid?: unknown; typ?: unknown; exp?: unknown };
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"], issuer, audience }) as typeof decoded;
  } catch (err) {
    throw new AuthError((err as Error | undefined)?.name === "TokenExpiredError" ? "EXPIRED" : "INVALID_TOKEN", `Invalid ${typ} token`);
  }
  if (typeof decoded !== "object" || decoded === null || decoded.typ !== typ || typeof decoded.sub !== "string" || !decoded.sub
    || typeof decoded.sid !== "string" || !decoded.sid || typeof decoded.exp !== "number") throw new AuthError("INVALID_TOKEN", `Invalid ${typ} token`);
  return decoded as T & { sub: string; sid: string; typ: string; exp: number };
}
export function verifyAccessToken(token: string): AccessClaims {
  return verify<AccessClaims>(token, env.JWT_ACCESS_SECRET, "access");
}
export function verifyRefreshToken(token: string): RefreshClaims {
  return verify<RefreshClaims>(token, env.JWT_REFRESH_SECRET, "refresh");
}
