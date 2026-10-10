import { errors, jwtVerify, SignJWT } from "jose";
import { AuthError } from "./errors";

const ISSUER = "poker-server";
const CLIENT_AUDIENCE = "poker-client";
const WS_AUDIENCE = "poker-ws";

export interface AccessClaims { sub: string; sid: string; username: string; typ: "access"; exp: number }
export interface RefreshClaims { sub: string; sid: string; typ: "refresh"; exp: number }

function hmacKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(secret: string, userId: string, username: string, sessionId: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ sid: sessionId, username, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(hmacKey(secret));
}

/** exp is the session row's expiry, floored to whole seconds, so the token never outlives the row. */
export async function signRefreshToken(secret: string, userId: string, sessionId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ sid: sessionId, typ: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(hmacKey(secret));
}

export async function signWsTicket(secret: string, userId: string, sessionId: string, username: string): Promise<string> {
  return new SignJWT({ sid: sessionId, username, typ: "ws" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(WS_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setExpirationTime("60s")
    .sign(hmacKey(secret));
}

async function verify(token: string, secret: string, typ: "access" | "refresh", audience: string): Promise<AccessClaims | RefreshClaims> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, hmacKey(secret), { algorithms: ["HS256"], issuer: ISSUER, audience });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    throw new AuthError(err instanceof errors.JWTExpired ? "EXPIRED" : "INVALID_TOKEN", `Invalid ${typ} token`);
  }
  if (payload.typ !== typ || typeof payload.sub !== "string" || !payload.sub
    || typeof payload.sid !== "string" || !payload.sid || typeof payload.exp !== "number") {
    throw new AuthError("INVALID_TOKEN", `Invalid ${typ} token`);
  }
  if (typ === "access" && (typeof payload.username !== "string" || !payload.username)) {
    throw new AuthError("INVALID_TOKEN", "Invalid access token");
  }
  return payload as unknown as AccessClaims | RefreshClaims;
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  return verify(token, secret, "access", CLIENT_AUDIENCE) as Promise<AccessClaims>;
}

export async function verifyRefreshToken(secret: string, token: string): Promise<RefreshClaims> {
  return verify(token, secret, "refresh", CLIENT_AUDIENCE) as Promise<RefreshClaims>;
}
