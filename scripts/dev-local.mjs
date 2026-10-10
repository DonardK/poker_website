#!/usr/bin/env node
/**
 * Local development database.
 *
 * `npm run dev` uses the database configured in `.env` (the shared Supabase
 * database): every start of the game server runs table recovery on its live
 * tables, and the code under development must already match its schema.
 * `npm run dev:local` instead keeps a PostgreSQL cluster of its own in
 * `.local-db/` (git-ignored; the same embedded PostgreSQL binaries as
 * `npm run test:db`), applies every migration to it, and runs `npm run dev`
 * against it. `.env` is not changed and the configured database is never
 * contacted: DATABASE_URL and DIRECT_URL are set for the child process, and
 * dotenv never overrides a variable that is already set.
 *
 *   npm run dev:local              local database, then the web app and game server
 *   npm run dev:local -- --db      local database only; prints the URLs to use
 *   npm run dev:local -- --check   start, migrate, check the runtime login, stop
 *   npm run dev:local -- --reset   delete .local-db first (all local data), then start
 *
 * Local passwords are random and kept in .local-db/settings.json.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, ".local-db");
const clusterDir = join(dataDir, "cluster");
const settingsFile = join(dataDir, "settings.json");
const harness = await import(pathToFileURL(join(root, "apps", "server", "test", "support", "pg.mjs")).href);
const LOOPBACK = "127.0.0.1";
const DATABASE = "poker_dev";
const PREFERRED_PORT = 54329;
const args = new Set(process.argv.slice(2));
const log = (line) => console.log(`[local-db] ${line}`);

const portIsFree = (port) => new Promise((resolvePort) => {
  const probe = createServer();
  probe.once("error", () => resolvePort(false));
  probe.listen(port, LOOPBACK, () => probe.close(() => resolvePort(true)));
});
const anyFreePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, LOOPBACK, () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});

if (args.has("--reset") && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
  log("deleted .local-db (all local data)");
}
mkdirSync(dataDir, { recursive: true });
let settings;
if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8"));
else {
  const port = (await portIsFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyFreePort();
  settings = { port, superPassword: randomBytes(24).toString("hex"), runtimePassword: randomBytes(24).toString("hex") };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
if (!(await portIsFree(settings.port))) {
  console.error(`[local-db] port ${settings.port} on ${LOOPBACK} is in use (is another dev:local running?). Stop it, or delete .local-db/settings.json to pick a new port.`);
  process.exit(1);
}

const cluster = new EmbeddedPostgres({
  databaseDir: clusterDir, port: settings.port, user: "postgres", password: settings.superPassword,
  authMethod: "scram-sha-256", persistent: true, initdbFlags: ["--encoding=UTF8"],
  // Loopback only; io_method=sync leaves no PostgreSQL 18 I/O worker behind on a hard stop.
  postgresFlags: ["-c", `listen_addresses=${LOOPBACK}`, "-c", "io_method=sync"],
  onLog: () => {}, onError: (message) => console.error("[local-db]", message instanceof Error ? message.message : String(message)),
});
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  try { await cluster.stop(); log("stopped"); } catch (err) { console.error("[local-db] could not stop cleanly:", err?.message ?? err); }
};

try {
  if (!existsSync(join(clusterDir, "PG_VERSION"))) {
    log("first run: creating a local PostgreSQL cluster in .local-db/");
    await cluster.initialise();
  }
  await cluster.start();
  const base = `postgresql://postgres:${settings.superPassword}@${LOOPBACK}:${settings.port}`;
  const maintenance = new pg.Client({ connectionString: `${base}/postgres?sslmode=disable` });
  await maintenance.connect();
  try {
    const { rowCount } = await maintenance.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (!rowCount) await maintenance.query(`CREATE DATABASE ${DATABASE}`);
  } finally { await maintenance.end(); }
  const adminUrl = `${base}/${DATABASE}?sslmode=disable`;
  harness.migrateDeploy(adminUrl); // refuses anything but this loopback database
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // The migrations create poker_server without LOGIN (production provisions it); locally it gets a password.
    await admin.query(`ALTER ROLE poker_server WITH LOGIN PASSWORD ${admin.escapeLiteral(settings.runtimePassword)}`);
  } finally { await admin.end(); }
  const runtimeUrl = `postgresql://poker_server:${settings.runtimePassword}@${LOOPBACK}:${settings.port}/${DATABASE}?sslmode=disable`;
  harness.assertLoopbackUrl(runtimeUrl, "local runtime URL");
  log(`ready on ${LOOPBACK}:${settings.port}, database ${DATABASE}, ${harness.migrationNames().length} migrations applied`);

  if (args.has("--check")) {
    const runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
    const { rows: [who] } = await runtime.query("SELECT current_user AS role");
    await runtime.end();
    log(`runtime login works as ${who.role}`);
    await stop();
    process.exit(who.role === "poker_server" ? 0 : 1);
  }
  if (args.has("--db")) {
    log("database only. Use these (local, throwaway) URLs to run the servers yourself:");
    console.log(`  DATABASE_URL=${runtimeUrl}`);
    console.log(`  DIRECT_URL=${adminUrl}`);
    log("press Ctrl+C to stop");
    await new Promise((resolveStop) => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
    await stop();
    process.exit(0);
  }
  log("starting the web app and game server against the local database (npm run dev)");
  const child = spawn("npm run dev", { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: runtimeUrl, DIRECT_URL: adminUrl } });
  // Ctrl+C reaches the child directly (same console); keep running until it exits, then stop the database.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const code = await new Promise((resolveExit) => child.on("exit", (exitCode) => resolveExit(exitCode ?? 0)));
  await stop();
  process.exit(code);
} catch (err) {
  console.error("[local-db] failed:", err?.message ?? err);
  await stop();
  process.exit(1);
}
