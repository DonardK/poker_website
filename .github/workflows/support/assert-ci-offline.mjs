#!/usr/bin/env node
/**
 * Check jobs and the start of deploy must not be able to reach Supabase.
 * DATABASE_URL and DIRECT_URL stay on a loopback port with nothing
 * listening. SUPABASE_DIRECT_URL and the Cloudflare deploy token are unset
 * here; the production job passes the database URL only to the migrate step.
 */
const STUB_HOSTS = new Set(["127.0.0.1", "localhost"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const allowCloudflare = process.argv.includes("--allow-cloudflare");

if (process.env.SUPABASE_DIRECT_URL?.trim() || process.env.NEON_DIRECT_URL?.trim()) {
  fail("SUPABASE_DIRECT_URL is set. This step must not receive the production database URL.");
}
if (!allowCloudflare && (process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim())) {
  fail("Cloudflare deploy credentials are set. This step must not receive them.");
}

for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  const raw = process.env[name];
  if (!raw?.trim()) fail(`${name} is unset. Expected the loopback stub.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} is not a URL.`);
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("supabase") || host.includes("neon.tech") || host.includes("pooler")) {
    fail(`${name} host "${host}" is not the CI loopback stub.`);
  }
  if (!STUB_HOSTS.has(host) || url.port !== "1") {
    fail(`${name} must be the loopback port 1 stub (host ${host || "(empty)"}, port ${url.port || "(none)"}).`);
  }
}

console.log(allowCloudflare
  ? "Database env is the loopback stub. SUPABASE_DIRECT_URL is unset."
  : "Database env is the loopback stub. SUPABASE_DIRECT_URL and Cloudflare deploy credentials are unset.");
