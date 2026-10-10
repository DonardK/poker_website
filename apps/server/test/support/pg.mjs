#!/usr/bin/env node
/**
 * Disposable PostgreSQL for real-database tests (never the configured database).
 *
 * startTestDatabase() starts an embedded PostgreSQL cluster (the
 * `embedded-postgres` binaries, no Docker) in a fresh temporary data directory
 * on a free 127.0.0.1 port, creates `poker_test`, applies EVERY migration in
 * prisma/migrations with the project's own Prisma CLI (`prisma migrate deploy`,
 * exactly as production is migrated), then gives the runtime login the
 * migrations create (`poker_app`, member of NOLOGIN `poker_server`) a random
 * password so tests connect as the least-privileged application role.
 * poker_server stays NOLOGIN.
 * It returns { adminUrl, runtimeUrl, stop() }:
 * - adminUrl:   the cluster superuser (fixtures, privilege inspection, migrations);
 * - runtimeUrl: poker_app, the role the game server runs as in production;
 * - stop():     stops the cluster and deletes its data directory (idempotent).
 * The data directory is also removed on SIGINT/SIGTERM, an uncaught error and
 * plain process exit, so an interrupted run leaves no cluster or files behind.
 *
 * LIVE-DATA SAFETY: prisma.config.ts loads the repository `.env` (the LIVE
 * database) with dotenv, which never overrides a variable that is already set.
 * Every Prisma child therefore gets DATABASE_URL and DIRECT_URL explicitly, and
 * before migrating, the harness evaluates prisma.config.ts in a child with that
 * exact environment and aborts unless the URL it resolves is the embedded
 * cluster's on 127.0.0.1 (assertPrismaTargetsTestDatabase). Prisma's own
 * "Datasource ... at <host:port>" line is checked again after the run.
 *
 * CLI: node test/support/pg.mjs --exec "<command>"
 *   runs <command> (through the shell) with POKER_TEST_DATABASE_URL (runtime
 *   role) and POKER_TEST_ADMIN_DATABASE_URL (superuser) set, DATABASE_URL /
 *   DIRECT_URL pointed at the test cluster too (so even a command that loads
 *   `.env` cannot reach the live database), fresh random test-only secrets,
 *   then stops the cluster and exits with the command's exit code.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server: Prisma commands run here so prisma.config.ts is the one in use. */
export const serverDir = resolve(here, "..", "..");
export const migrationsDir = join(serverDir, "prisma", "migrations");
const requireFromServer = createRequire(join(serverDir, "package.json"));
const LOOPBACK = "127.0.0.1";
const DATABASE = "poker_test";
const SUPERUSER = "postgres";
const RUNTIME_ROLE = "poker_app";

/** Migration directory names in the order Prisma applies them (lexicographic). */
export function migrationNames() {
  return readdirSync(migrationsDir).filter((name) => statSync(join(migrationsDir, name)).isDirectory()).sort();
}

/** Refuse anything but a loopback test URL (the only kind this harness creates). */
export function assertLoopbackUrl(url, what = "database URL") {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`${what} is not a valid URL`); }
  if (host !== LOOPBACK) throw new Error(`${what} must point at the disposable test cluster on ${LOOPBACK}, not ${host || "(empty)"}`);
}

/** Environment for a Prisma CLI child aimed at `url`: both URL variables set, so dotenv cannot fill either from `.env`. */
function prismaEnv(url) {
  assertLoopbackUrl(url, "Prisma target");
  return { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1", CHECKPOINT_DISABLE: "1" };
}

/**
 * Evaluate apps/server/prisma.config.ts in a child process with exactly the
 * environment a Prisma command would get, and require that every database URL
 * Prisma can use afterwards is `url` itself (and so on 127.0.0.1): the
 * DATABASE_URL that schema.prisma reads (env("DATABASE_URL")), DIRECT_URL, and
 * the config's datasource.url when the installed Prisma keeps it (6.x drops it
 * from the loaded config; 7.x uses it). This proves the `.env` loading in
 * prisma.config.ts did not replace the override, instead of assuming dotenv's
 * no-override behaviour.
 */
export function assertPrismaTargetsTestDatabase(url) {
  const env = prismaEnv(url);
  const code = [
    'import { tsImport } from "tsx/esm/api";',
    `const mod = await tsImport(${JSON.stringify(pathToFileURL(join(serverDir, "prisma.config.ts")).href)}, import.meta.url);`,
    "const config = mod.default?.default ?? mod.default ?? mod;",
    "const urls = [process.env.DATABASE_URL ?? null, process.env.DIRECT_URL ?? null];",
    "if (config.datasource && 'url' in config.datasource) urls.push(config.datasource.url ?? null);",
    "process.stdout.write(JSON.stringify({ urls }));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: serverDir, env, encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) throw new Error(`could not evaluate prisma.config.ts: ${(run.stderr || run.error?.message || "").slice(0, 2000)}`);
  let urls;
  try { urls = JSON.parse(run.stdout.trim().split("\n").pop()).urls; } catch { throw new Error("prisma.config.ts check printed no URLs"); }
  if (!Array.isArray(urls) || urls.length < 2) throw new Error("prisma.config.ts check printed no URLs");
  for (const resolved of urls) {
    assertLoopbackUrl(resolved, "a database URL Prisma would use after loading prisma.config.ts");
    // Not printed: it carries the cluster password.
    if (resolved !== url) throw new Error("after loading prisma.config.ts Prisma would use a different database URL than the test cluster; refusing to run Prisma");
  }
}

/**
 * Run the project's Prisma CLI (the local `prisma` package, via node: no shell,
 * no npx download fallback) against a loopback test database.
 * Returns { status, stdout, stderr }; never throws on a non-zero exit.
 */
export function runPrisma(args, url, { timeout = 180_000 } = {}) {
  assertPrismaTargetsTestDatabase(url);
  const cli = requireFromServer.resolve("prisma/build/index.js");
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: serverDir, env: prismaEnv(url), encoding: "utf8", timeout });
  const result = { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: (run.stderr ?? "") + (run.error ? String(run.error) : "") };
  // Prisma names the datasource it used ("... at \"127.0.0.1:PORT\""): check it as well.
  const at = /Datasource "[^"]+":[^\n]*? at "([^"]+)"/.exec(result.stdout + result.stderr)?.[1];
  const port = new URL(url).port;
  if (at && at !== `${LOOPBACK}:${port}`) throw new Error(`Prisma reported datasource ${at}, expected ${LOOPBACK}:${port}`);
  return result;
}

/** `prisma migrate deploy` that throws (with Prisma's output) unless it succeeds. */
export function migrateDeploy(url) {
  const result = runPrisma(["migrate", "deploy"], url);
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Replace the database name in a postgres URL (same server, credentials and options). */
export function withDatabase(url, database) {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/** A port that was free on 127.0.0.1 a moment ago (the start is retried if it is taken meanwhile). */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, LOOPBACK, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

/** Every cluster this process started and has not stopped yet (for the exit/signal cleanup). */
const live = new Set();

/** pg_ctl next to the postgres binary the cluster runs (the platform package ships both). */
function pgCtlFor(proc) {
  return join(dirname(proc.spawnfile), process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
}

/**
 * Stop through pg_ctl, so the postmaster shuts its own children down. The
 * library's stop() force-kills the process tree (taskkill /f /t on Windows),
 * which was seen to leave a PostgreSQL 18 io_worker orphaned; it remains only
 * the fallback.
 */
async function stopCluster(instance, mode = "fast") {
  const proc = instance.cluster.process;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) { instance.cluster.process = undefined; return; }
  const exited = new Promise((resolveExit) => proc.once("exit", resolveExit));
  spawnSync(pgCtlFor(proc), ["stop", "-D", instance.dir, "-m", mode, "-w", "-t", "30"], { stdio: "ignore", timeout: 40_000 });
  try { await withTimeout(exited, 10_000, "PostgreSQL shutdown"); instance.cluster.process = undefined; }
  catch { await withTimeout(instance.cluster.stop(), 30_000, "killing PostgreSQL"); }
}

function killNow(instance) {
  // Synchronous: also usable from an 'exit' handler, where nothing async runs.
  const proc = instance.cluster.process;
  const pid = proc?.pid;
  if (proc && pid && proc.exitCode === null) spawnSync(pgCtlFor(proc), ["stop", "-D", instance.dir, "-m", "immediate", "-w", "-t", "15"], { stdio: "ignore", timeout: 20_000 });
  if (pid && proc.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" });
    else { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  try { rmSync(instance.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort at exit */ }
}

let hooksInstalled = false;
function installCleanupHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", () => { for (const instance of live) killNow(instance); });
  const fail = (err) => {
    console.error("[pg] fatal:", err);
    Promise.allSettled([...live].map((instance) => instance.stop())).finally(() => process.exit(1));
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      Promise.allSettled([...live].map((instance) => instance.stop())).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

/**
 * Start a disposable cluster with every migration applied.
 * @param {{ log?: (line: string) => void }} [options] log: progress lines (never secrets).
 */
export async function startTestDatabase({ log = () => {} } = {}) {
  installCleanupHooks();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const { default: pg } = await import("pg");
  const started = Date.now();
  const superPassword = randomBytes(24).toString("hex");
  const runtimePassword = randomBytes(24).toString("hex");
  const serverLog = [];
  let instance;
  for (let attempt = 1; ; attempt++) {
    // initdb accepts the (empty) directory mkdtemp creates; stop() deletes it.
    const dir = mkdtempSync(join(tmpdir(), "poker-pg-"));
    const port = await freePort();
    const cluster = new EmbeddedPostgres({
      databaseDir: dir, port, user: SUPERUSER, password: superPassword, authMethod: "scram-sha-256", persistent: false,
      initdbFlags: ["--encoding=UTF8"],
      // Loopback only. Durability settings are off: the cluster is thrown away
      // after the run, and this keeps migrations and tests fast.
      // io_method=sync: no PostgreSQL 18 I/O worker processes to outlive a killed postmaster.
      postgresFlags: ["-c", `listen_addresses=${LOOPBACK}`, "-c", "max_connections=200", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "io_method=sync"],
      onLog: (message) => { serverLog.push(String(message)); if (serverLog.length > 200) serverLog.shift(); },
      onError: (message) => { serverLog.push(`[error] ${message instanceof Error ? message.message : String(message)}`); },
    });
    let stopping = null;
    instance = {
      cluster, dir, port,
      stop: () => stopping ??= (async () => {
        try { await stopCluster(instance); } catch { killNow(instance); }
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        live.delete(instance);
      })(),
    };
    live.add(instance);
    try {
      await withTimeout(cluster.initialise(), 120_000, "initdb");
      // start() rejects with no reason when postgres exits early (e.g. port taken).
      await withTimeout(cluster.start().catch((err) => { throw err ?? new Error("postgres exited during start-up"); }), 60_000, "PostgreSQL start-up");
      break;
    } catch (err) {
      await instance.stop();
      if (attempt >= 3) throw new Error(`embedded PostgreSQL did not start: ${err?.message ?? err}\n${serverLog.slice(-20).join("")}`);
      log(`[pg] start attempt ${attempt} failed (${err?.message ?? err}); retrying on another port`);
    }
  }
  try {
    const base = `postgresql://${SUPERUSER}:${superPassword}@${LOOPBACK}:${instance.port}`;
    const maintenance = new pg.Client({ connectionString: `${base}/postgres?sslmode=disable` });
    await maintenance.connect();
    try { await maintenance.query(`CREATE DATABASE ${DATABASE}`); } finally { await maintenance.end(); }
    const adminUrl = `${base}/${DATABASE}?sslmode=disable`;
    migrateDeploy(adminUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    let version;
    try {
      // Migrations create poker_app LOGIN with no password, and leave
      // poker_server NOLOGIN. A random password lets tests connect as poker_app.
      await admin.query(`ALTER ROLE ${RUNTIME_ROLE} WITH PASSWORD ${admin.escapeLiteral(runtimePassword)}`);
      version = (await admin.query("SHOW server_version")).rows[0].server_version;
    } finally { await admin.end(); }
    const runtimeUrl = `postgresql://${RUNTIME_ROLE}:${runtimePassword}@${LOOPBACK}:${instance.port}/${DATABASE}?sslmode=disable`;
    log(`[pg] PostgreSQL ${version} on ${LOOPBACK}:${instance.port}, ${migrationNames().length} migrations applied, ready in ${Date.now() - started} ms`);
    return { adminUrl, runtimeUrl, port: instance.port, stop: instance.stop };
  } catch (err) {
    await instance.stop();
    throw err;
  }
}

/** Fresh random secrets for the test run, so tests never use (or need) the real ones from `.env`. */
function testSecrets() {
  return {
    NODE_ENV: "test",
    GAME_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    JWT_ACCESS_SECRET: randomBytes(48).toString("hex"),
    JWT_REFRESH_SECRET: randomBytes(48).toString("hex"),
    REDIS_URL: "",
  };
}

async function main(argv) {
  const index = argv.indexOf("--exec");
  const command = index >= 0 ? argv[index + 1] : undefined;
  if (!command) {
    console.error('usage: node test/support/pg.mjs --exec "<command>"');
    process.exit(2);
  }
  const db = await startTestDatabase({ log: (line) => console.error(line) });
  const started = Date.now();
  const env = {
    ...process.env, ...testSecrets(),
    POKER_TEST_DATABASE_URL: db.runtimeUrl, POKER_TEST_ADMIN_DATABASE_URL: db.adminUrl,
    DATABASE_URL: db.runtimeUrl, DIRECT_URL: db.adminUrl,
  };
  const code = await new Promise((resolveCode) => {
    const child = spawn(command, { stdio: "inherit", env, shell: true, cwd: process.cwd() });
    child.on("error", (err) => { console.error("[pg] could not run command:", err.message); resolveCode(1); });
    child.on("exit", (exitCode, signal) => resolveCode(signal ? 1 : exitCode ?? 1));
  });
  console.error(`[pg] command finished with exit code ${code} after ${Date.now() - started} ms; stopping PostgreSQL`);
  await db.stop();
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
