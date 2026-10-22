import type { AppDb } from "../http/db";
import { DEVICE_COOKIE_NAME, readCookie } from "../http/cookies";
import { randomToken, sha256Hex } from "./bytes";
import { coarseIp } from "./ip";

/**
 * Known devices for new-sign-in alerts. A random, long-lived, HttpOnly
 * poker_device cookie names the browser; the database keeps only its SHA-256
 * (KnownDevice.deviceHash) with a coarse network, the user agent, a readable
 * label and the Cloudflare country. A known device also counts as familiar
 * for the lockout rules (lockout.ts).
 */

export { DEVICE_COOKIE_MAX_AGE_S, DEVICE_COOKIE_NAME } from "../http/cookies";
const DEVICE_VALUE = /^d1\.[A-Za-z0-9_-]{43}$/;
const NO_USER = "no-such-user";

export interface DeviceCookie {
  value: string;
  hash: string;
  /** Minted by this request: the response must set the cookie. */
  minted: boolean;
}

export async function readDevice(cookieHeader: string | undefined): Promise<DeviceCookie | null> {
  const value = readCookie(cookieHeader, DEVICE_COOKIE_NAME);
  if (!value || !DEVICE_VALUE.test(value)) return null;
  return { value, hash: await sha256Hex(value), minted: false };
}

export async function mintDevice(): Promise<DeviceCookie> {
  const value = `d1.${randomToken(32)}`;
  return { value, hash: await sha256Hex(value), minted: true };
}

export async function readOrMintDevice(cookieHeader: string | undefined): Promise<DeviceCookie> {
  return (await readDevice(cookieHeader)) ?? mintDevice();
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, "Windows"],
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b|\biPod\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/** "<Browser> on <OS>" (at most 64 characters), or null when the user agent says neither. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 512);
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  const label = browser && system ? `${browser} on ${system}` : browser ?? system ?? null;
  return label ? label.slice(0, 64) : null;
}

/** Cloudflare's two-letter country (T1 = Tor), or null. */
export function normalizeCountry(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9]{2}$/.test(value) ? value : null;
}

/** The user's row for this device hash. userId null still runs the same query (no timing difference for unknown users). */
export async function findKnownDevice(db: AppDb, userId: string | null, hash: string | null): Promise<{ id: string } | null> {
  if (!hash) return null;
  return db.knownDevice.findFirst({ where: { userId: userId ?? NO_USER, deviceHash: hash }, select: { id: true } });
}

export interface TouchedDevice {
  id: string;
  created: boolean;
  /** Other devices the user already had (counted only when this one is new). */
  otherDevices: number;
}

/** Create or refresh the KnownDevice row. Pass a transaction client. */
export async function touchDevice(db: AppDb, input: {
  userId: string;
  hash: string;
  userAgent?: string | null;
  ip: string | null;
  country: string | null;
  now: Date;
}): Promise<TouchedDevice> {
  const details = {
    label: deviceLabel(input.userAgent),
    userAgent: input.userAgent ? input.userAgent.slice(0, 256) : null,
    lastIp: coarseIp(input.ip),
    country: input.country,
    lastSeenAt: input.now,
  };
  const existing = await db.knownDevice.findFirst({ where: { userId: input.userId, deviceHash: input.hash }, select: { id: true } }) as { id: string } | null;
  if (existing) {
    await db.knownDevice.update({ where: { id: existing.id }, data: details });
    return { id: existing.id, created: false, otherDevices: 0 };
  }
  const created = await db.knownDevice.create({
    data: { userId: input.userId, deviceHash: input.hash, firstSeenAt: input.now, ...details },
    select: { id: true },
  }) as { id: string };
  const otherDevices = await db.knownDevice.count({ where: { userId: input.userId, id: { not: created.id } } });
  return { id: created.id, created: true, otherDevices };
}
