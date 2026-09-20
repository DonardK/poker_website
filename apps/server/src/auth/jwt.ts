import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config.js";

export interface AccessClaims {
  sub: string;
  username: string;
  typ: "access";
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  typ: "refresh";
}

export function signAccessToken(userId: string, username: string): string {
  const options: SignOptions = { expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"] };
  return jwt.sign({ sub: userId, username, typ: "access" } satisfies AccessClaims, env.JWT_ACCESS_SECRET, options);
}

export function signRefreshToken(userId: string, sessionId: string): string {
  const options: SignOptions = { expiresIn: env.JWT_REFRESH_TTL as SignOptions["expiresIn"] };
  return jwt.sign({ sub: userId, sid: sessionId, typ: "refresh" } satisfies RefreshClaims, env.JWT_REFRESH_SECRET, options);
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
  if (decoded.typ !== "access" || !decoded.sub) {
    throw new Error("Invalid access token");
  }
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshClaims {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshClaims;
  if (decoded.typ !== "refresh" || !decoded.sub || !decoded.sid) {
    throw new Error("Invalid refresh token");
  }
  return decoded;
}
