/**
 * Wire helpers shared by the real provider adapters (Nuvei, BVNK, Sumsub):
 * one outbound HTTP call with a timeout and a response size cap, lossless
 * JSON (numbers kept as their source text), exact decimal to minor-unit
 * conversion, constant-time signature comparison and payload redaction.
 *
 * BVNK is why lossless JSON exists (its amounts are JSON numbers,
 * design-payments section 11.9); Nuvei's chargeback events need it too (a
 * 19-digit TransactionId as a JSON number). No module state, no secrets kept.
 */
import { bytesEqual, toHex, utf8 } from "../../auth/bytes";
import type { ProviderFetch } from "./types";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Every provider call times out; the core then queries before any retry. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Larger answers are refused as malformed (no provider answer we read is near this). */
export const MAX_RESPONSE_BYTES = 1_048_576;

export interface WireRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type WireResult =
  /** text is null when the body is too large or not valid UTF-8. */
  | { kind: "response"; status: number; text: string | null }
  | { kind: "failed"; reason: "timeout" | "network" };

/**
 * Sends one request through the registry's egress-aware fetch. Redirects are
 * never followed (a 3xx comes back as a status). Exceptions are classified,
 * never rethrown: an AbortSignal timeout is "timeout", anything else
 * "network". The error text is not logged (it can echo URLs).
 */
export async function send(fetch: ProviderFetch, request: WireRequest): Promise<WireResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }),
      { timeoutMs },
    );
  } catch (error) {
    return { kind: "failed", reason: isTimeout(error) ? "timeout" : "network" };
  }
  try {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return { kind: "response", status: response.status, text: null };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) return { kind: "response", status: response.status, text: null };
    return { kind: "response", status: response.status, text: decodeUtf8(bytes) };
  } catch (error) {
    return { kind: "failed", reason: isTimeout(error) ? "timeout" : "network" };
  }
}

function isTimeout(error: unknown): boolean {
  // DOMException is not an Error subclass on every runtime: read the name.
  const name = error !== null && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/** Strict UTF-8 (a malformed byte sequence is null, never U+FFFD). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lossless JSON
// ---------------------------------------------------------------------------

/** A JSON number exactly as it appeared in the source text ("115.69", "2110000000017245577", "4.5E-5"). */
export class JsonNumber {
  constructor(readonly text: string) {
    if (!JSON_NUMBER.test(text)) throw new SyntaxError("not a JSON number");
  }
}

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const MAX_DEPTH = 64;
const MAX_NUMBER_LENGTH = 64;

/**
 * JSON.parse that keeps every number as a JsonNumber (BVNK amounts, Nuvei
 * transaction ids beyond 2^53). Strict RFC 8259: no comments, no trailing
 * commas, no duplicate keys (an ambiguous signed body is refused), nesting
 * at most 64 deep. "__proto__" is an ordinary own key, never a prototype.
 * Throws SyntaxError on anything else.
 */
export function parseJsonLossless(text: string): unknown {
  let at = 0;
  // Explicitly typed so control-flow analysis treats a call as an exit.
  const fail: (what: string) => never = (what) => {
    throw new SyntaxError(`invalid JSON: ${what} at ${at}`);
  };
  const space = () => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) at++;
      else break;
    }
  };
  const string = (): string => {
    at++; // opening quote
    let out = "";
    let run = at;
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c === 0x22) {
        out += text.slice(run, at);
        at++;
        return out;
      }
      if (c < 0x20) fail("control character in string");
      if (c === 0x5c) {
        out += text.slice(run, at);
        const e = text[at + 1];
        at += 2;
        if (e === "u") {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          at += 4;
        } else {
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          const v = e === undefined ? undefined : map[e];
          if (v === undefined) fail("bad escape");
          out += v;
        }
        run = at;
        continue;
      }
      at++;
    }
    return fail("unterminated string");
  };
  const NUMBER_AT = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const obj: Record<string, unknown> = {};
      space();
      if (text[at] === "}") {
        at++;
        return obj;
      }
      for (;;) {
        space();
        if (text[at] !== '"') fail("expected a key");
        const key = string();
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail("duplicate key");
        space();
        if (text[at] !== ":") fail("expected ':'");
        at++;
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at] === "}") {
          at++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      at++;
      const arr: unknown[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at] === "]") {
          at++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (text.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (text.startsWith("null", at)) {
      at += 4;
      return null;
    }
    NUMBER_AT.lastIndex = at;
    const match = NUMBER_AT.exec(text);
    if (!match) return fail("unexpected token");
    if (match[0].length > MAX_NUMBER_LENGTH) fail("number too long");
    at += match[0].length;
    return new JsonNumber(match[0]);
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("trailing data");
  return result;
}

/**
 * JSON.stringify for request bodies: a JsonNumber is written as a bare
 * number token exactly as given ("120.00"). A JS number is accepted only as
 * a safe integer (counts, minutes), so an amount can never be a float; a
 * bigint throws. undefined properties are left out, as JSON.stringify does.
 */
export function stringifyJsonLossless(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof JsonNumber) return value.text;
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("only safe integers may be JS numbers; amounts are JsonNumber");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : stringifyJsonLossless(item))).join(",")}]`;
      const parts: string[] = [];
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (inner === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${stringifyJsonLossless(inner)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`cannot serialise a ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------

/**
 * A JSON number (or a decimal string) as a plain, exact decimal string with
 * no exponent, no leading zeros and no trailing fractional zeros:
 * "4.5023994813E-5" -> "0.000045023994813", "1E+3" -> "1000",
 * "115.690" -> "115.69", "-0.0" -> "0". Null for anything else or an
 * exponent beyond +-64. Never goes through a JS number.
 */
export function plainDecimal(value: JsonNumber | string): string | null {
  const text = value instanceof JsonNumber ? value.text : value;
  if (typeof text !== "string" || text.length > MAX_NUMBER_LENGTH) return null;
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!match) return null;
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 64) return null;
  let digits = match[2]! + (match[3] ?? "");
  let point = match[2]!.length + exponent;
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  } else if (point > digits.length) {
    digits = digits + "0".repeat(point - digits.length);
  }
  const whole = digits.slice(0, point).replace(/^0+(?=[0-9])/, "") || "0";
  const fraction = digits.slice(point).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  const negative = match[1] === "-" && /[1-9]/.test(body);
  return negative ? `-${body}` : body;
}

/**
 * A non-negative decimal in minor units of an asset with `decimals` places.
 * "exact": digits beyond `decimals` must be zero ("100.0000" -> 10000n for
 * 2 places) or the result is null. "floor": they are dropped and returned
 * as `remainder` ("115.694" -> 11569n, remainder "0.004"), the LEDGER.md
 * rule for credits with sub-cent digits. Null for negative or malformed
 * input.
 */
export function decimalToMinor(
  value: JsonNumber | string,
  decimals: number,
  rounding: "exact" | "floor" = "exact",
): { minor: bigint; remainder: string | null } | null {
  const plain = plainDecimal(value);
  if (plain === null || plain.startsWith("-")) return null;
  const [whole, fraction = ""] = plain.split(".") as [string, string?];
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const dropped = fraction.slice(decimals);
  if (dropped.length > 0 && rounding === "exact") return null;
  const minor = BigInt(whole + kept);
  if (minor > 9_223_372_036_854_775_807n) return null;
  return { minor, remainder: dropped.length > 0 ? `0.${"0".repeat(decimals)}${dropped}` : null };
}

// ---------------------------------------------------------------------------
// Bytes, signatures
// ---------------------------------------------------------------------------

/** Constant-time comparison of two byte strings (the length is not secret). */
export const equalBytes = bytesEqual;

/** Strict hex (either case) to bytes; null otherwise. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Strict padded base64 to bytes; null otherwise. */
export function base64ToBytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export async function hmac(algorithm: "SHA-256" | "SHA-512", key: string, message: string | Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", utf8(key), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, typeof message === "string" ? utf8(message) : message));
}

export async function sha256Bytes(message: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof message === "string" ? utf8(message) : message));
}

export async function sha256HexOf(message: string | Uint8Array): Promise<string> {
  return toHex(await sha256Bytes(message));
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `length` uniformly random alphanumerics (rejection sampling, no modulo bias). */
export function randomAlphanumeric(randomBytes: (length: number) => Uint8Array, length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue; // 248 = 4 * 62
      out += ALNUM[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * A deterministic RFC 9562 version-8 UUID from an idempotency key, for
 * providers that require a UUID-shaped key: the same key always gives the
 * same UUID, different keys (or namespaces) practically never collide.
 */
export async function uuidFromKey(namespace: string, key: string): Promise<string> {
  const bytes = (await sha256Bytes(`${namespace}\u0000${key}`)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Text, dates, redaction
// ---------------------------------------------------------------------------

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** A Date from epoch milliseconds (number, numeric string or JsonNumber), or null. */
export function dateFromEpochMs(value: unknown): Date | null {
  const text = value instanceof JsonNumber ? value.text : typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (text === null || !/^[0-9]{10,16}$/.test(text)) return null;
  const date = new Date(Number(text));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Last four digits of a masked card number ("4****1390", "************1390"), or null. */
export function last4Of(masked: unknown): string | null {
  if (typeof masked !== "string") return null;
  const match = /([0-9]{4})$/.exec(masked.trim());
  return match ? match[1]! : null;
}

const MAX_REDACTED_STRING = 200;

/**
 * Keeps only allow-listed keys (any depth, at most 5 levels), with strings
 * clipped to 200 characters and JsonNumbers as their decimal text. Arrays
 * are kept only under an allow-listed key and only for their scalar items.
 * Everything else (names, emails, addresses, IPs, card numbers, tokens the
 * adapter did not list) is dropped.
 */
export function redactWith(allowed: ReadonlySet<string>, payload: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) || depth > 4) return out;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const kept = redactValue(allowed, value, depth);
    if (kept !== undefined) Object.defineProperty(out, key, { value: kept, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function redactValue(allowed: ReadonlySet<string>, value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return clip(value, MAX_REDACTED_STRING);
  if (value instanceof JsonNumber) return plainDecimal(value) ?? undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => (item === null || typeof item !== "object" || item instanceof JsonNumber ? redactValue(allowed, item, depth) : redactWith(allowed, item, depth + 1)))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") return redactWith(allowed, value, depth + 1);
  return undefined;
}

/** A provider-supplied id that may go into a URL path segment or an event key. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
