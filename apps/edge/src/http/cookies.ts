import { REFRESH_COOKIE_NAME, SESSION_HINT_COOKIE_NAME } from "@poker/shared";

export const WS_COOKIE_NAME = "poker_ws";
export const DEVICE_COOKIE_NAME = "poker_device";
/** 400 days, the longest lifetime Chrome keeps. */
export const DEVICE_COOKIE_MAX_AGE_S = 34_560_000;
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

export function requestIsSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function lifetime(expiresAt: Date, persistent: boolean): string {
  if (!persistent) return "";
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}`;
}

const sameSite = (secure: boolean) => `SameSite=${secure ? "Strict" : "Lax"}${secure ? "; Secure" : ""}`;

/**
 * Host-only: no Domain attribute. On the workers.dev demo the browser talks
 * only to the web Worker, so the cookie stays on that host. Not persistent
 * ("keep me signed in" unticked): no Max-Age or Expires, a browser-session cookie.
 */
export function refreshCookie(token: string, expiresAt: Date, secure: boolean, persistent = true): string {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}${lifetime(expiresAt, persistent)}; Path=/api/auth; HttpOnly; ${sameSite(secure)}`;
}

export function clearRefreshCookie(secure: boolean): string {
  return `${REFRESH_COOKIE_NAME}=; Max-Age=0; Path=/api/auth; Expires=${EPOCH}; HttpOnly; ${sameSite(secure)}`;
}

/**
 * poker_session_hint=1: set and cleared with the refresh cookie, same
 * lifetime, Path=/ so the web middleware can see it. Lax so a top-level
 * navigation from an email link still carries it. Only a redirect hint,
 * never an authenticator: the value is a constant.
 */
export function hintCookie(expiresAt: Date, secure: boolean, persistent = true): string {
  return `${SESSION_HINT_COOKIE_NAME}=1${lifetime(expiresAt, persistent)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearHintCookie(secure: boolean): string {
  return `${SESSION_HINT_COOKIE_NAME}=; Max-Age=0; Path=/; Expires=${EPOCH}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** poker_device: names this browser for new-sign-in alerts (only its hash is stored). */
export function deviceCookie(value: string, secure: boolean): string {
  return `${DEVICE_COOKIE_NAME}=${value}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; Path=/api/auth; HttpOnly; ${sameSite(secure)}`;
}

export function wsCookie(token: string, secure: boolean): string {
  return `${WS_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=60; Path=/ws; HttpOnly; ${sameSite(secure)}`;
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
