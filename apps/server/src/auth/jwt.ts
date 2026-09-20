import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config.js";

export interface AccessClaims { sub: string; sid: string; username: string; typ: "access"; exp: number }
export interface RefreshClaims { sub: string; sid: string; typ: "refresh" }
const issuer = "poker-server";
const audience = "poker-client";

export function signAccessToken(userId: string, username: string, sessionId: string): string {
  const options: SignOptions = { algorithm: "HS256", issuer, audience, expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"], jwtid: randomUUID() };
  return jwt.sign({ sub: userId, sid: sessionId, username, typ: "access" }, env.JWT_ACCESS_SECRET, options);
}
export function signRefreshToken(userId: string, sessionId: string): string {
  const options: SignOptions = { algorithm: "HS256", issuer, audience, expiresIn: env.JWT_REFRESH_TTL as SignOptions["expiresIn"], jwtid: randomUUID() };
  return jwt.sign({ sub: userId, sid: sessionId, typ: "refresh" }, env.JWT_REFRESH_SECRET, options);
}
export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"], issuer, audience }) as AccessClaims;
  if (decoded.typ !== "access" || !decoded.sub || !decoded.sid || !decoded.exp) throw new Error("Invalid access token");
  return decoded;
}
export function verifyRefreshToken(token: string): RefreshClaims {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"], issuer, audience }) as RefreshClaims;
  if (decoded.typ !== "refresh" || !decoded.sub || !decoded.sid) throw new Error("Invalid refresh token");
  return decoded;
}
