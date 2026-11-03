/**
 * Test doubles for the provider adapter unit tests: a scripted fetch that
 * records every request, a log sink, a fixed clock, and signature helpers
 * built directly on WebCrypto (independent of the adapters' own wire.ts),
 * so a test checks the adapter against the documented formula, not against
 * itself. No network, no database. Secrets are fresh random values per run.
 */
import type { ProviderDeps } from "../../../src/payments/providers/types";

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  redirect: string;
  timeoutMs: number | undefined;
}

export interface LogLine {
  level: "info" | "warn" | "error";
  fields: Record<string, string | number | boolean | null>;
  message: string;
}

export type Responder = (request: Recorded, index: number) => Response | Error | Promise<Response | Error>;

export const NOW = new Date("2026-10-29T12:34:56.789Z");

/** Deps whose fetch answers from `responder` (an Error is thrown, like a failed fetch). */
export function fakeDeps(responder: Responder, now: Date = NOW) {
  const requests: Recorded[] = [];
  const logs: LogLine[] = [];
  const deps: ProviderDeps = {
    async fetch(request, options) {
      const recorded: Recorded = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: request.method === "GET" ? "" : await request.text(),
        redirect: request.redirect,
        timeoutMs: options?.timeoutMs,
      };
      requests.push(recorded);
      const answer = await responder(recorded, requests.length - 1);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log(level, fields, message) {
      logs.push({ level, fields, message });
    },
    now: () => now,
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  };
  return { deps, requests, logs };
}

/** Answers from a queue, in order; running out fails the test loudly. */
export function queue(...answers: (Response | Error | (() => Response | Error))[]): Responder {
  return (_request, index) => {
    const answer = answers[index];
    if (answer === undefined) return new Error(`unexpected request #${index + 1}`);
    return typeof answer === "function" ? answer() : answer;
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 32 random bytes as hex: a secret nobody could copy into production. */
export function randomSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const encoder = new TextEncoder();

export async function hmacBytes(hash: "SHA-256" | "SHA-512" | "SHA-1", key: string, data: string | Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, typeof data === "string" ? encoder.encode(data) : data));
}

export async function sha256Hex(data: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data))));
}

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Every logged value as one string, to assert that no secret ever reaches a log line. */
export function logText(logs: LogLine[]): string {
  return JSON.stringify(logs);
}
