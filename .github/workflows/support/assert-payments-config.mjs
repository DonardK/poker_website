#!/usr/bin/env node
/**
 * apps/edge/wrangler.payments.jsonc (poker-payments) must stay safe to
 * deploy by hand at any time (docs/money/PAYMENTS_RUNBOOK.md). CI only
 * dry-runs it; nothing in this workflow deploys it. Checked here:
 * - the top level is production with PAYMENTS_MODE=off and Cloudflare Access
 *   required for admin calls; the sandbox can never be its mode;
 * - preview is ENVIRONMENT=preview, never live;
 * - no secret, password or database URL sits in a var (secrets go through
 *   `wrangler secret put`); the local connection string is loopback only;
 * - one cron per Worker (Free plan: five per account, poker-api uses one);
 * - poker-api (wrangler.jsonc) never holds the payments Hyperdrive binding.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function stripJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
}

const SECRET_NAMES = /(SECRET|PASSWORD|API_KEY|AUTH_KEY|AUTH_ID|APP_TOKEN|PRIVATE)/;

function varErrors(vars, label) {
  const errors = [];
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (SECRET_NAMES.test(name) && String(value).length > 0) errors.push(`${label}: ${name} looks like a secret; use wrangler secret put`);
    if (/postgres(ql)?:\/\//i.test(String(value))) errors.push(`${label}: ${name} holds a database URL`);
  }
  return errors;
}

function hyperdriveErrors(list, label) {
  const errors = [];
  for (const entry of list ?? []) {
    if (entry.binding !== "HYPERDRIVE_PAYMENTS") errors.push(`${label}: unexpected Hyperdrive binding ${entry.binding}`);
    if (entry.localConnectionString) {
      try {
        const url = new URL(entry.localConnectionString);
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") errors.push(`${label}: localConnectionString must be loopback`);
      } catch {
        errors.push(`${label}: localConnectionString is not a URL`);
      }
    }
  }
  return errors;
}

export function paymentsConfigErrors(payments, api) {
  const errors = [];
  if (payments.name !== "poker-payments") errors.push("name must be poker-payments");
  if (payments.main !== "src/payments/worker.ts") errors.push("main must be src/payments/worker.ts");
  const vars = payments.vars ?? {};
  if (vars.ENVIRONMENT !== "production") errors.push("top-level ENVIRONMENT must be production");
  if (vars.PAYMENTS_MODE !== "off" && vars.PAYMENTS_MODE !== "live") errors.push("top-level PAYMENTS_MODE must be off (or live, after the runbook)");
  if (vars.ADMIN_REQUIRE_CF_ACCESS !== "true") errors.push("top-level ADMIN_REQUIRE_CF_ACCESS must be true");
  for (const key of ["CARD_PROVIDER_KEY", "CRYPTO_PROVIDER_KEY", "KYC_PROVIDER_KEY"]) {
    if (String(vars[key] ?? "").startsWith("sandbox")) errors.push(`top-level ${key} must not be the sandbox`);
  }
  errors.push(...varErrors(vars, "top-level"), ...hyperdriveErrors(payments.hyperdrive, "top-level"));
  if ((payments.triggers?.crons ?? []).length > 1) errors.push("top-level: at most one cron (Free plan)");
  const preview = payments.env?.preview;
  if (preview) {
    const pv = preview.vars ?? {};
    if (pv.ENVIRONMENT !== "preview") errors.push("env.preview ENVIRONMENT must be preview");
    if (pv.PAYMENTS_MODE === "live") errors.push("env.preview PAYMENTS_MODE must not be live");
    errors.push(...varErrors(pv, "env.preview"), ...hyperdriveErrors(preview.hyperdrive, "env.preview"));
    if ((preview.triggers?.crons ?? []).length > 1) errors.push("env.preview: at most one cron (Free plan)");
  }
  const apiHyperdrives = [...(api.hyperdrive ?? []), ...Object.values(api.env ?? {}).flatMap((e) => e.hyperdrive ?? [])];
  if (apiHyperdrives.some((h) => h.binding === "HYPERDRIVE_PAYMENTS")) errors.push("poker-api must never hold HYPERDRIVE_PAYMENTS (docs/money/WALLET.md section 3.2)");
  for (const service of [...(api.services ?? []), ...Object.values(api.env ?? {}).flatMap((e) => e.services ?? [])]) {
    if (service.binding === "PAYMENTS" && service.entrypoint !== "PaymentsRpc") errors.push("poker-api PAYMENTS must bind entrypoint PaymentsRpc");
  }
  return errors;
}

function main() {
  const paymentsPath = process.argv[2] ?? "apps/edge/wrangler.payments.jsonc";
  const apiPath = process.argv[3] ?? "apps/edge/wrangler.jsonc";
  for (const path of [paymentsPath, apiPath]) {
    if (!existsSync(path)) {
      console.error(`${path} is missing`);
      process.exit(1);
    }
  }
  const errors = paymentsConfigErrors(stripJsonc(readFileSync(paymentsPath, "utf8")), stripJsonc(readFileSync(apiPath, "utf8")));
  if (errors.length > 0) {
    for (const error of errors) console.error(`poker-payments config: ${error}`);
    process.exit(1);
  }
  console.log("poker-payments Wrangler config ok.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
