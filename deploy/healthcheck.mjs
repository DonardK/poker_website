#!/usr/bin/env node
/**
 * Container probe used by the Dockerfiles' HEALTHCHECK (and usable by any
 * orchestrator that runs a command inside the container).
 *
 *   node deploy/healthcheck.mjs [path] [port]
 *
 * Exits 0 when GET http(s)://127.0.0.1:<port><path> answers 2xx within 3s,
 * 1 otherwise. Defaults: path /api/health, port $PORT or 4000.
 *
 * Why a script and not curl/wget: the runtime images are slim and ship no
 * HTTP client, and adding one only for probing enlarges the attack surface.
 * Node is already there.
 *
 * Protocol: the API serves HTTPS itself when TLS_CERT_FILE and TLS_KEY_FILE
 * are both set (direct TLS) and plain HTTP otherwise (behind a TLS proxy). The
 * probe follows the same rule so it hits the listener that actually exists.
 * In the HTTPS case certificate verification is skipped: the probe connects to
 * 127.0.0.1 inside the container, a name the certificate never covers, and it
 * checks liveness of this process, not the identity of a remote peer. It sends
 * nothing secret.
 *
 * GET /api/health is the one route the API serves over plain HTTP in
 * production (app.ts exempts it from the HTTPS requirement), so the probe
 * works in proxy mode without TLS.
 */
import http from "node:http";
import https from "node:https";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 3000;

export function probeTarget(argv = process.argv.slice(2), env = process.env) {
  const path = argv[0] && argv[0].startsWith("/") ? argv[0] : "/api/health";
  const portRaw = argv[1] ?? env.PORT ?? "4000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${portRaw}`);
  const secure = Boolean(env.TLS_CERT_FILE && env.TLS_KEY_FILE);
  return { secure, port, path };
}

export function probe({ secure, port, path }) {
  return new Promise((resolve) => {
    const client = secure ? https : http;
    const req = client.request(
      { host: "127.0.0.1", port, path, method: "GET", timeout: TIMEOUT_MS, ...(secure ? { rejectUnauthorized: false } : {}) },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (isMain) {
  let target;
  try {
    target = probeTarget();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
  probe(target).then((ok) => process.exit(ok ? 0 : 1));
}
