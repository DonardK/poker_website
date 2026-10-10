#!/usr/bin/env node
/**
 * Fail closed before `prisma migrate deploy`. Prints the host and port only.
 * Prisma loads a checkout .env without overriding variables that are already
 * set; this still refuses to run when that file is present.
 *
 * Accepted admin URLs (port 5432, session mode or direct):
 * - postgresql://postgres.<ref>@<aws-region>.pooler.supabase.com:5432/<db>
 * - postgresql://postgres@db.<ref>.supabase.co:5432/<db>
 *
 * Rejected: port 6543 (transaction pooler), loopback, any other host, and
 * the runtime login (poker_server). Migrations need the admin role.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHECKOUT_ENV_FILES = [".env", "apps/server/.env", "apps/edge/.dev.vars"];
const REF = "[a-z0-9]{20}";

export function supabaseDirectUrlError(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "SUPABASE_DIRECT_URL is empty. Refusing to migrate.";
  }
  if (/[\r\n]/.test(raw)) {
    return "SUPABASE_DIRECT_URL contains a line break. Refusing to migrate.";
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return "SUPABASE_DIRECT_URL is not a valid URL. Refusing to migrate.";
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return "SUPABASE_DIRECT_URL must use the postgresql:// scheme. Refusing to migrate.";
  }
  if (!url.username || !url.password) {
    return "SUPABASE_DIRECT_URL is missing a user or password. Refusing to migrate.";
  }
  if (!url.pathname || url.pathname === "/") {
    return "SUPABASE_DIRECT_URL is missing a database name. Refusing to migrate.";
  }
  const host = url.hostname.toLowerCase();
  if (!host) return "SUPABASE_DIRECT_URL host is empty. Refusing to migrate.";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return `SUPABASE_DIRECT_URL host "${host}" is loopback. Refusing to migrate.`;
  }
  const port = url.port === "" ? "5432" : url.port;
  if (port === "6543") {
    return "SUPABASE_DIRECT_URL uses port 6543 (transaction mode). Migrations need session mode or the direct host on port 5432. Refusing to migrate.";
  }
  if (port !== "5432") {
    return `SUPABASE_DIRECT_URL port "${port}" is not 5432. Refusing to migrate.`;
  }
  const user = decodeURIComponent(url.username);
  const sessionPooler = new RegExp(`^postgres\\.${REF}$`);
  const directHost = new RegExp(`^db\\.${REF}\\.supabase\\.co$`);
  const poolerHost = host.endsWith(".pooler.supabase.com");
  if (poolerHost) {
    if (!sessionPooler.test(user)) {
      return "SUPABASE_DIRECT_URL session-pooler user must be postgres.<project-ref>, not the runtime login. Refusing to migrate.";
    }
    return null;
  }
  if (directHost.test(host)) {
    if (user !== "postgres") {
      return "SUPABASE_DIRECT_URL on db.<ref>.supabase.co must use the postgres user. Refusing to migrate.";
    }
    return null;
  }
  return `SUPABASE_DIRECT_URL host "${host}" is not a Supabase session pooler (*.pooler.supabase.com) or direct host (db.<ref>.supabase.co). Refusing to migrate.`;
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
  const raw = process.env.SUPABASE_DIRECT_URL;
  const urlError = supabaseDirectUrlError(raw);
  if (urlError) {
    console.error(urlError);
    process.exit(1);
  }
  if (process.env.DATABASE_URL !== raw || process.env.DIRECT_URL !== raw) {
    console.error("DATABASE_URL and DIRECT_URL must both be SUPABASE_DIRECT_URL for this step. Refusing to migrate.");
    process.exit(1);
  }
  const url = new URL(raw.trim());
  console.log(`SUPABASE_DIRECT_URL host accepted: ${url.hostname} port ${url.port || "5432"}`);
}

if (isDirectRun()) main();
