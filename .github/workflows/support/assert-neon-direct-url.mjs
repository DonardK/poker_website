#!/usr/bin/env node
/**
 * Fail closed before `prisma migrate deploy`. Prints the host only.
 * Prisma loads a checkout .env without overriding variables that are already
 * set; this still refuses to run when that file is present.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHECKOUT_ENV_FILES = [".env", "apps/server/.env", "apps/edge/.dev.vars"];

export function neonDirectUrlError(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "NEON_DIRECT_URL is empty. Refusing to migrate.";
  }
  if (/[\r\n]/.test(raw)) {
    return "NEON_DIRECT_URL contains a line break. Refusing to migrate.";
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return "NEON_DIRECT_URL is not a valid URL. Refusing to migrate.";
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return "NEON_DIRECT_URL must use the postgresql:// scheme. Refusing to migrate.";
  }
  if (!url.username || !url.password) {
    return "NEON_DIRECT_URL is missing a user or password. Refusing to migrate.";
  }
  if (!url.pathname || url.pathname === "/") {
    return "NEON_DIRECT_URL is missing a database name. Refusing to migrate.";
  }
  const host = url.hostname.toLowerCase();
  if (!host) return "NEON_DIRECT_URL host is empty. Refusing to migrate.";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return `NEON_DIRECT_URL host "${host}" is loopback. Refusing to migrate.`;
  }
  if (host === "supabase.co" || host.endsWith(".supabase.co") || host.includes("supabase")) {
    return `NEON_DIRECT_URL host "${host}" looks like Supabase (*.supabase.co or pooler.supabase.com). Refusing to migrate.`;
  }
  if (host === "pooler.supabase.com" || host.endsWith(".pooler.supabase.com") || host.includes("pooler")) {
    return `NEON_DIRECT_URL host "${host}" looks like a pooler. Migrations need the Neon direct host. Refusing to migrate.`;
  }
  return null;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function main() {
  for (const path of CHECKOUT_ENV_FILES) {
    if (existsSync(path)) {
      console.error(`${path} is in the checkout. Refusing to migrate, because Prisma loads that file.`);
      process.exit(1);
    }
  }
  const raw = process.env.NEON_DIRECT_URL;
  const urlError = neonDirectUrlError(raw);
  if (urlError) {
    console.error(urlError);
    process.exit(1);
  }
  if (process.env.DATABASE_URL !== raw || process.env.DIRECT_URL !== raw) {
    console.error("DATABASE_URL and DIRECT_URL must both be NEON_DIRECT_URL for this step. Refusing to migrate.");
    process.exit(1);
  }
  console.log(`NEON_DIRECT_URL host accepted: ${new URL(raw.trim()).hostname}`);
}

if (isDirectRun()) main();
