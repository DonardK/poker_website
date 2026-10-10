#!/usr/bin/env node
/**
 * Production and preview deploys read the Wrangler files before any migrate
 * or upload. Placeholders and a shared Hyperdrive id fail closed.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DUMMY_TURNSTILE_PREFIXES = ["1x00000000000000000000", "2x00000000000000000000"];

function parseJsonc(text) {
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/);
  const kept = lines.map((line) => {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === "/" && line[i + 1] === "/") break;
      out += ch;
    }
    return out;
  });
  return JSON.parse(kept.join("\n").replace(/,\s*([}\]])/g, "$1"));
}

function load(path) {
  if (!existsSync(path)) return { error: `${path} is missing` };
  try {
    return { config: parseJsonc(readFileSync(path, "utf8")), raw: readFileSync(path, "utf8") };
  } catch (err) {
    return { error: `${path} is not valid JSONC (${err instanceof Error ? err.message : String(err)})` };
  }
}

function hyperdriveIdError(id, label) {
  if (typeof id !== "string" || id.trim() === "") return `${label} is empty`;
  if (id.includes("<") || id.includes(">") || id.includes("HYPERDRIVE_ID") || id.includes("example")) {
    return `${label} is still a placeholder`;
  }
  if (!/^[0-9a-f]{32}$/i.test(id)) return `${label} must be the 32-character Hyperdrive id from \`wrangler hyperdrive create\``;
  return null;
}

function httpsHost(value, label, { allowWorkersDev, allowEmpty }) {
  if (typeof value !== "string" || value.trim() === "") {
    if (allowEmpty) return { host: "" };
    return { error: `${label} is empty` };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `${label} is not a URL` };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return { error: `${label} must use https` };
  if (!host || host.includes("<") || host === "example.com" || host.endsWith(".example.com") || host.endsWith(".invalid")) {
    return { error: `${label} still uses a placeholder host` };
  }
  if (!allowWorkersDev && (host === "workers.dev" || host.endsWith(".workers.dev"))) {
    return { error: `${label} must be the site domain` };
  }
  return { host };
}

function emptyRoutesError(routes, label) {
  if (!Array.isArray(routes) || routes.length !== 0) {
    return `${label} routes must be an explicit empty array so this environment does not inherit production routes.`;
  }
  return null;
}

function routeErrors(routes, label, { allowEmpty, allowWorkersDev }) {
  const errors = [];
  if (!Array.isArray(routes)) return [`${label} routes are missing`];
  if (routes.length === 0) {
    if (!allowEmpty) errors.push(`${label} routes are empty`);
    return errors;
  }
  if (allowEmpty) errors.push(`${label} routes must stay empty so this environment does not attach to the production domain`);
  for (const route of routes) {
    const pattern = String(route?.pattern ?? "");
    const zone = String(route?.zone_name ?? route?.zone_id ?? "");
    const blob = `${pattern} ${zone}`.toLowerCase();
    if (blob.includes("example.com") || blob.includes("<") || blob.includes("example.invalid")) {
      errors.push(`${label} still points at example.com`);
    }
    if (!allowWorkersDev && blob.includes("workers.dev")) {
      errors.push(`${label} must use the site domain, with workers_dev false`);
    }
  }
  return errors;
}

function turnstileError(value, label) {
  if (typeof value !== "string" || value.trim() === "") return `${label} is empty`;
  if (DUMMY_TURNSTILE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return `${label} is a Turnstile test key`;
  }
  return null;
}

function leakedDatabaseUrl(raw, path) {
  if (typeof raw === "string" && (raw.includes("supabase.co") || raw.includes("pooler.supabase.com") || raw.includes("neon.tech"))) {
    return `${path} contains a database host. Keep the database password in Hyperdrive only.`;
  }
  return null;
}

function serviceError(services, binding, service, label) {
  const list = Array.isArray(services) ? services : [];
  const found = list.find((entry) => entry?.binding === binding);
  if (!found) return `${label} is missing a services binding named ${binding}.`;
  if (found.service !== service) return `${label} binding ${binding} must target ${service}.`;
  return null;
}

/** The workers.dev demo has no zone routes. Preview must set [] so it cannot inherit a domain. */
function noCustomDomain(routes, label, { requireExplicitEmpty }) {
  if (routes == null) {
    if (requireExplicitEmpty) return `${label} routes must be an explicit empty array.`;
    return null;
  }
  if (!Array.isArray(routes) || routes.length !== 0) {
    return `${label} must not attach a custom domain. Omit routes or set [].`;
  }
  return null;
}

function bindingId(config) {
  const list = Array.isArray(config?.hyperdrive) ? config.hyperdrive : [];
  return list.find((entry) => entry?.binding === "HYPERDRIVE")?.id;
}

export function configErrors(edge, web, mode) {
  const errors = [];
  if (edge.name !== "poker-api") errors.push(`apps/edge/wrangler.jsonc name must be poker-api (found ${edge.name ?? "(missing)"}).`);
  if (web.name !== "poker-web") errors.push(`apps/web/wrangler.jsonc name must be poker-web (found ${web.name ?? "(missing)"}).`);

  const productionIdError = hyperdriveIdError(bindingId(edge), "Production Hyperdrive id");
  if (productionIdError) errors.push(productionIdError);

  const previewId = bindingId(edge.env?.preview);
  const previewIdError = hyperdriveIdError(previewId, "Preview Hyperdrive id");
  if (!previewIdError && !productionIdError && previewId === bindingId(edge)) {
    errors.push("Preview Hyperdrive id matches the production id. Preview needs its own Hyperdrive config.");
  }
  const apiBinding = serviceError(web.services, "API", "poker-api", "Web production");
  if (apiBinding) errors.push(apiBinding);
  const previewApiBinding = serviceError(web.env?.preview?.services, "API", "poker-api-preview", "Web preview");
  if (web.env?.preview && previewApiBinding) errors.push(previewApiBinding);

  if (mode === "preview") {
    if (!edge.env?.preview) errors.push("apps/edge/wrangler.jsonc is missing env.preview.");
    if (previewIdError) errors.push(previewIdError);
    if (edge.env?.preview?.name !== "poker-api-preview") errors.push("Edge preview worker name must be poker-api-preview.");
    if (edge.env?.preview?.workers_dev !== false) errors.push("Edge preview workers_dev must be false. The API is reached only through the service binding.");
    const edgePreviewRoutes = emptyRoutesError(edge.env?.preview?.routes, "Edge preview");
    if (edgePreviewRoutes) errors.push(edgePreviewRoutes);
    const origin = httpsHost(edge.env?.preview?.vars?.CLIENT_ORIGIN, "Edge preview CLIENT_ORIGIN", { allowWorkersDev: true });
    if (origin.error) errors.push(origin.error);
    if (!web.env?.preview) errors.push("apps/web/wrangler.jsonc is missing env.preview (name poker-web-preview, workers_dev true, routes []).");
    if (web.env?.preview?.name !== "poker-web-preview") errors.push("Web preview worker name must be poker-web-preview.");
    if (web.env?.preview?.workers_dev !== true) errors.push("Web preview workers_dev must be true.");
    const webPreviewRoutes = emptyRoutesError(web.env?.preview?.routes, "Web preview");
    if (webPreviewRoutes) errors.push(webPreviewRoutes);
    const edgeRoutes = noCustomDomain(edge.routes, "Edge production", { requireExplicitEmpty: false });
    if (edgeRoutes) errors.push(edgeRoutes);
    const webRoutes = noCustomDomain(web.routes, "Web production", { requireExplicitEmpty: false });
    if (webRoutes) errors.push(webRoutes);
    if (process.env.CHECK_GITHUB_PUBLIC_VARS === "1") {
      const envApi = httpsHost(process.env.NEXT_PUBLIC_API_URL, "Preview GitHub variable NEXT_PUBLIC_API_URL", { allowWorkersDev: true, allowEmpty: true });
      const envSocket = httpsHost(process.env.NEXT_PUBLIC_SOCKET_URL, "Preview GitHub variable NEXT_PUBLIC_SOCKET_URL", { allowWorkersDev: true, allowEmpty: true });
      if (envApi.error) errors.push(envApi.error);
      if (envSocket.error) errors.push(envSocket.error);
      if (!envApi.error && !envSocket.error && envApi.host !== envSocket.host) {
        errors.push("Preview NEXT_PUBLIC_API_URL and NEXT_PUBLIC_SOCKET_URL must both be empty or share one https host.");
      }
      const productionHost = httpsHost(edge.vars?.CLIENT_ORIGIN, "CLIENT_ORIGIN", { allowWorkersDev: true });
      if (!envApi.error && envApi.host && !productionHost.error && envApi.host === productionHost.host) {
        errors.push("Preview NEXT_PUBLIC_API_URL uses the production host.");
      }
      const previewKeyError = turnstileError(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, "Preview GitHub variable NEXT_PUBLIC_TURNSTILE_SITE_KEY");
      if (previewKeyError) errors.push(previewKeyError);
    }
  }

  if (mode === "production") {
    const webMain = String(web.main ?? "");
    if (webMain !== "./worker.ts" && webMain !== "worker.ts") {
      errors.push(`Web production main must be worker.ts so /api and /ws reach the API binding (found ${webMain || "(missing)"}).`);
    }
    if (edge.workers_dev !== false) errors.push("Edge production workers_dev must be false.");
    if (web.workers_dev !== true) errors.push("Web production workers_dev must be true for the workers.dev demo.");
    const edgeRoutes = noCustomDomain(edge.routes, "Edge production", { requireExplicitEmpty: false });
    if (edgeRoutes) errors.push(edgeRoutes);
    const webRoutes = noCustomDomain(web.routes, "Web production", { requireExplicitEmpty: false });
    if (webRoutes) errors.push(webRoutes);
    const client = httpsHost(edge.vars?.CLIENT_ORIGIN, "CLIENT_ORIGIN", { allowWorkersDev: true });
    const api = httpsHost(web.vars?.NEXT_PUBLIC_API_URL, "NEXT_PUBLIC_API_URL", { allowWorkersDev: true, allowEmpty: true });
    const socket = httpsHost(web.vars?.NEXT_PUBLIC_SOCKET_URL, "NEXT_PUBLIC_SOCKET_URL", { allowWorkersDev: true, allowEmpty: true });
    for (const result of [client, api, socket]) if (result.error) errors.push(result.error);
    if (!client.error && !api.error && !socket.error && (api.host || socket.host)) {
      if (!api.host || !socket.host || api.host !== client.host || socket.host !== client.host) {
        errors.push("When NEXT_PUBLIC_API_URL or NEXT_PUBLIC_SOCKET_URL is set, both must be the CLIENT_ORIGIN host. Leave them empty for same-origin workers.dev.");
      }
    }
    const siteKeyError = turnstileError(edge.vars?.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY");
    if (siteKeyError) errors.push(siteKeyError);
    const publicSiteKeyError = turnstileError(web.vars?.NEXT_PUBLIC_TURNSTILE_SITE_KEY, "NEXT_PUBLIC_TURNSTILE_SITE_KEY");
    if (publicSiteKeyError) errors.push(publicSiteKeyError);
    if (typeof edge.placement?.region !== "string" || !/^aws:[a-z0-9-]+$/.test(edge.placement.region)) {
      errors.push("placement.region must be an aws: region. The Supabase demo uses aws:eu-west-1.");
    }
    if (process.env.CHECK_GITHUB_PUBLIC_VARS === "1") {
      const envApi = httpsHost(process.env.NEXT_PUBLIC_API_URL, "GitHub variable NEXT_PUBLIC_API_URL", { allowWorkersDev: true, allowEmpty: true });
      const envSocket = httpsHost(process.env.NEXT_PUBLIC_SOCKET_URL, "GitHub variable NEXT_PUBLIC_SOCKET_URL", { allowWorkersDev: true, allowEmpty: true });
      if (envApi.error) errors.push(envApi.error);
      if (envSocket.error) errors.push(envSocket.error);
      if (!envApi.error && !api.error && envApi.host !== api.host) {
        errors.push("GitHub variable NEXT_PUBLIC_API_URL does not match apps/web/wrangler.jsonc.");
      }
      if (!envSocket.error && !socket.error && envSocket.host !== socket.host) {
        errors.push("GitHub variable NEXT_PUBLIC_SOCKET_URL does not match apps/web/wrangler.jsonc.");
      }
      if ((process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "") !== (web.vars?.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "")) {
        errors.push("GitHub variable NEXT_PUBLIC_TURNSTILE_SITE_KEY does not match apps/web/wrangler.jsonc.");
      }
    }
  }

  return errors;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function main() {
  const mode = process.argv[2] ?? "production";
  if (mode !== "production" && mode !== "preview") {
    console.error("usage: node assert-wrangler-config.mjs <production|preview>");
    process.exit(2);
  }
  const edgePath = "apps/edge/wrangler.jsonc";
  const webPath = "apps/web/wrangler.jsonc";
  const edge = load(edgePath);
  const web = load(webPath);
  const errors = [];
  if (edge.error) errors.push(edge.error);
  if (web.error) errors.push(web.error);
  if (edge.raw) {
    const leaked = leakedDatabaseUrl(edge.raw, edgePath);
    if (leaked) errors.push(leaked);
  }
  if (web.raw) {
    const leaked = leakedDatabaseUrl(web.raw, webPath);
    if (leaked) errors.push(leaked);
  }
  if (edge.config && web.config) errors.push(...configErrors(edge.config, web.config, mode));
  const unique = [...new Set(errors)];
  if (unique.length > 0) {
    console.error(`Wrangler ${mode} config is not ready to deploy:`);
    for (const error of unique) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Wrangler ${mode} config ok.`);
}

if (isDirectRun()) main();
