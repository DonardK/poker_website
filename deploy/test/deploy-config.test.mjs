/**
 * Static regression tests for the deployment configuration.
 *
 *   node --test deploy/test/          (from the repo root; no network, no DB)
 *
 * Docker, Caddy and nginx are not available where these files were written,
 * so the configs are unexecuted. These tests pin the security properties that
 * matter most and are easiest to lose in a later edit: local services bound to
 * loopback with no default passwords, forwarded headers OVERWRITTEN (never
 * appended) at the edge, non-root runtime images with health checks, and no
 * secrets in the build context. Each assertion fails on the configuration this
 * repo had before (docker-compose.yml published 0.0.0.0:5432 with password
 * "poker" and an unauthenticated Redis; no edge, image or ignore file existed).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { probe, probeTarget } from "../healthcheck.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
/** Drops comment lines/tails so assertions only see live configuration. */
const stripHashComments = (text) => text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

// ---------------------------------------------------------------- compose --
test("docker-compose: every published port is bound to 127.0.0.1", () => {
  const live = stripHashComments(read("docker-compose.yml"));
  const ports = [...live.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p));
  assert.ok(ports.length >= 2, "expected the postgres and redis port mappings");
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:\d+:\d+$/, `port mapping ${p} is not loopback-only`);
});

test("docker-compose: no default or hard-coded passwords", () => {
  const live = stripHashComments(read("docker-compose.yml"));
  assert.match(live, /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?[^}]+\}/);
  assert.match(live, /REDIS_PASSWORD:\s*\$\{REDIS_PASSWORD:\?[^}]+\}/);
  assert.doesNotMatch(live, /POSTGRES_PASSWORD:\s*["']?poker["']?\s*$/m);
  assert.doesNotMatch(live, /\$\{[A-Z_]*PASSWORD:-/, "a password must never have a :- default");
});

test("docker-compose: redis requires a password, keeps protected mode, and both services keep healthchecks", () => {
  const raw = read("docker-compose.yml");
  const live = stripHashComments(raw);
  assert.match(live, /--requirepass\s+"\$\$REDIS_PASSWORD"/);
  assert.match(live, /--protected-mode yes/);
  assert.equal((live.match(/^\s{4}healthcheck:/gm) ?? []).length, 2);
  assert.match(raw.split("\n")[0], /NOT production/i);
});

// ------------------------------------------------------------------ nginx --
function nginxLocations(conf) {
  const out = [];
  const re = /location\s+[^{]+\{/g;
  let m;
  while ((m = re.exec(conf))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < conf.length && depth > 0; i += 1) {
      if (conf[i] === "{") depth += 1;
      else if (conf[i] === "}") depth -= 1;
    }
    out.push({ head: m[0], body: conf.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

test("nginx: forwarded headers are overwritten with what the edge saw, never appended", () => {
  const conf = stripHashComments(read("deploy/nginx.conf"));
  assert.doesNotMatch(conf, /\$proxy_add_x_forwarded_for/);
  assert.match(conf, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
  assert.match(conf, /proxy_set_header\s+X-Forwarded-Proto\s+https;/);
  assert.match(conf, /proxy_set_header\s+Host\s+\$host;/);
  assert.match(conf, /proxy_set_header\s+Forwarded\s+"";/);
  // nginx drops inherited proxy_set_header/add_header in any block that sets
  // its own, which would silently forward the client's X-Forwarded-For.
  for (const loc of nginxLocations(conf)) {
    assert.doesNotMatch(loc.body, /proxy_set_header|add_header/, `${loc.head.trim()} must not redefine headers`);
  }
});

test("nginx: one origin routes /api and /socket.io (with upgrade and long timeouts) to the private API", () => {
  const conf = stripHashComments(read("deploy/nginx.conf"));
  const locs = nginxLocations(conf);
  const byHead = (re) => locs.find((l) => re.test(l.head));
  for (const re of [/location\s+\/api\/\s*\{/, /location\s+\/socket\.io\/\s*\{/, /location\s+\/api\/auth\/\s*\{/]) {
    assert.match(byHead(re)?.body ?? "", /proxy_pass\s+http:\/\/poker_api;/);
  }
  // The last "location /" is the HTTPS origin's (the first is port 80's redirect).
  const rootLoc = locs.filter((l) => /location\s+\/\s*\{/.test(l.head)).at(-1);
  assert.match(rootLoc?.body ?? "", /proxy_pass\s+http:\/\/poker_web;/);
  assert.match(locs.find((l) => /location\s+\/\s*\{/.test(l.head)).body, /return 301 https:\/\/poker\.example\.com\$request_uri;/);
  const socket = byHead(/location\s+\/socket\.io\//).body;
  assert.match(socket, /proxy_read_timeout\s+1h;/);
  assert.match(socket, /proxy_buffering\s+off;/);
  assert.match(conf, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
  assert.match(conf, /proxy_set_header\s+Connection\s+\$connection_upgrade;/);
  assert.match(byHead(/api\/ready/)?.body ?? "", /return\s+404;/);
});

test("nginx: TLS 1.2+, HSTS, body limits and edge rate limits", () => {
  const conf = stripHashComments(read("deploy/nginx.conf"));
  assert.match(conf, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/);
  assert.match(conf, /add_header\s+Strict-Transport-Security\s+"max-age=31536000; includeSubDomains"\s+always;/);
  assert.match(conf, /client_max_body_size\s+64k;/);
  for (const zone of ["auth", "api", "socket", "web"]) assert.match(conf, new RegExp(`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${zone}:`));
  for (const loc of nginxLocations(conf).filter((l) => /proxy_pass/.test(l.body))) {
    assert.match(loc.body, /limit_req\s+zone=/, `${loc.head.trim()} has no rate limit`);
  }
  assert.match(conf, /ssl_reject_handshake\s+on;/);
});

// ------------------------------------------------------------------ caddy --
test("Caddyfile: forwarded headers overwritten in every reverse_proxy, no trusted upstream proxies", () => {
  const conf = stripHashComments(read("deploy/Caddyfile"));
  const proxies = conf.split(/reverse_proxy\s+\{\$/).slice(1);
  assert.equal(proxies.length, 2, "expected the API and web reverse_proxy blocks");
  for (const p of proxies) {
    assert.match(p, /header_up X-Forwarded-For \{remote_host\}/);
    assert.match(p, /header_up X-Forwarded-Proto https/);
    assert.match(p, /header_up Host \{host\}/);
    assert.match(p, /header_up -Forwarded/);
  }
  assert.doesNotMatch(conf, /trusted_proxies/);
});

test("Caddyfile: TLS 1.2+, HSTS, body limits, rate limits, /socket.io routed to the API", () => {
  const conf = stripHashComments(read("deploy/Caddyfile"));
  assert.match(conf, /protocols tls1\.2 tls1\.3/);
  assert.match(conf, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  assert.match(conf, /max_size 64KB/);
  assert.match(conf, /rate_limit \{/);
  assert.match(conf, /zone auth \{/);
  assert.match(conf, /@api path \/api \/api\/\* \/socket\.io \/socket\.io\/\*/);
  assert.match(conf, /handle @ready \{\s*respond 404/);
});

// ------------------------------------------------------------ Dockerfiles --
function lastStage(dockerfile) {
  const live = stripHashComments(dockerfile);
  const idx = [...live.matchAll(/^FROM\s.+$/gm)].map((m) => m.index).at(-1);
  return { head: live.slice(idx).split("\n")[0], body: live.slice(idx) };
}

for (const [app, health] of [["server", "/api/health"], ["web", "/"]]) {
  test(`${app} Dockerfile: multi-stage, npm ci, prod-only deps, non-root runtime with HEALTHCHECK`, () => {
    const file = read(`apps/${app}/Dockerfile`);
    const live = stripHashComments(file);
    assert.ok((live.match(/^FROM\s/gm) ?? []).length >= 3, "expected a multi-stage build");
    assert.match(live, /npm ci --omit=dev --omit=optional --ignore-scripts --workspace @poker\/(server|web)/);
    const final = lastStage(file);
    assert.match(final.head, /AS runtime$/, "the default (last) stage must be the runtime image");
    assert.match(final.body, /^USER node$/m);
    assert.match(final.body, new RegExp(`HEALTHCHECK[\\s\\S]*healthcheck\\.mjs", "${health.replace(/\//g, "\\/")}"`));
    assert.match(final.body, /ENV NODE_ENV=production/);
    // Nothing secret may be declared in an image.
    assert.doesNotMatch(live, /^(ENV|ARG)\s+[^\n]*(SECRET|PASSWORD|ENCRYPTION_KEY|DIRECT_URL|DATABASE_URL)/m);
    assert.doesNotMatch(live, /COPY[^\n]*\.env/);
  });
}

test("server Dockerfile: Prisma CLI only in the separate migrate target, readiness documented", () => {
  const file = read("apps/server/Dockerfile");
  assert.match(file, /FROM build AS migrate/);
  assert.match(file, /test ! -e node_modules\/prisma/);
  assert.match(file, /\/api\/ready/);
});

test(".dockerignore keeps secrets, dependencies, build output and review material out of the build context", () => {
  const lines = stripHashComments(read(".dockerignore")).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const required of [".env", ".env.*", "**/.env", "**/.env.*", "**/node_modules", "**/dist", "**/.next", "**/.next-*", "review", "logs", "**/*.log", "**/test-results", ".git"]) {
    assert.ok(lines.includes(required), `.dockerignore is missing ${required}`);
  }
  assert.ok(!lines.some((l) => /^!.*\.env$/.test(l)), "no .env file may be re-included");
});

// ------------------------------------------------------- healthcheck.mjs --
test("healthcheck: target follows the API's TLS mode and validates the port", () => {
  assert.deepEqual(probeTarget([], {}), { secure: false, port: 4000, path: "/api/health" });
  assert.deepEqual(probeTarget(["/", "3000"], {}), { secure: false, port: 3000, path: "/" });
  assert.deepEqual(probeTarget([], { PORT: "4100", TLS_CERT_FILE: "/c.pem", TLS_KEY_FILE: "/k.pem" }), { secure: true, port: 4100, path: "/api/health" });
  // One file alone is not direct TLS (config.ts requires both or neither).
  assert.equal(probeTarget([], { TLS_CERT_FILE: "/c.pem" }).secure, false);
  assert.throws(() => probeTarget([], { PORT: "nope" }));
});

test("healthcheck: 2xx is healthy; 5xx and a closed port are not", async () => {
  const server = createServer((req, res) => { res.statusCode = req.url === "/api/health" ? 200 : 503; res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal(await probe({ secure: false, port, path: "/api/health" }), true);
    assert.equal(await probe({ secure: false, port, path: "/api/ready" }), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await probe({ secure: false, port, path: "/api/health" }), false);
});

// ------------------------------------------------------ live-DB guidance --
test(".cursor/rules/supabase.mdc warns that the root .env is the LIVE database and lists forbidden commands", () => {
  const rule = read(".cursor/rules/supabase.mdc");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /LIVE production database/);
  for (const cmd of ["prisma migrate dev", "prisma migrate reset", "prisma db push", "npm run db:reset", "npm run db:seed", "npm run dev"]) {
    assert.ok(rule.includes(cmd), `forbidden command not listed: ${cmd}`);
  }
  assert.doesNotMatch(rule, /currently uses local Docker Postgres/);
});
