import { REFRESH_COOKIE_NAME } from "@poker/shared";

export const WS_COOKIE_NAME = "poker_ws";

export function requestIsSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

export function refreshCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/api/auth; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=${secure ? "Strict" : "Lax"}${secure ? "; Secure" : ""}`;
}

export function clearRefreshCookie(secure: boolean): string {
  return `${REFRESH_COOKIE_NAME}=; Max-Age=0; Path=/api/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=${secure ? "Strict" : "Lax"}${secure ? "; Secure" : ""}`;
}

export function wsCookie(token: string, secure: boolean): string {
  return `${WS_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=60; Path=/ws; HttpOnly; SameSite=${secure ? "Strict" : "Lax"}${secure ? "; Secure" : ""}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}
