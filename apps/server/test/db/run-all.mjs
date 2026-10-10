#!/usr/bin/env node
/**
 * Runs every real-PostgreSQL suite in test/db (each *.test.mjs, sorted)
 * through test/support/run-tests.mjs with `--import tsx`. Windows shells do not
 * expand globs, so the list is built here instead of in package.json.
 *
 * Only meaningful inside `node test/support/pg.mjs --exec "node test/db/run-all.mjs"`
 * (that is `npm run test:db -w @poker/server`): pg.mjs starts the disposable
 * cluster and sets POKER_TEST_DATABASE_URL / POKER_TEST_ADMIN_DATABASE_URL.
 * Refuses to start without them, so it can never run against `.env`.
 * Extra arguments are passed to node --test before the file list
 * (for example --test-name-pattern=...); a bare file name narrows the run:
 *   node test/db/run-all.mjs privileges concurrency
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackUrl } from "../support/pg.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..", "..");
for (const name of ["POKER_TEST_DATABASE_URL", "POKER_TEST_ADMIN_DATABASE_URL"]) {
  const url = process.env[name];
  if (!url) { console.error(`${name} is not set: run through \`npm run test:db -w @poker/server\` (test/support/pg.mjs)`); process.exit(2); }
  assertLoopbackUrl(url, name);
}

const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("-"));
const only = args.filter((arg) => !arg.startsWith("-"));
const files = readdirSync(here).filter((name) => name.endsWith(".test.mjs")).sort()
  .filter((name) => only.length === 0 || only.some((part) => name.includes(part)))
  .map((name) => relative(serverDir, join(here, name)).split("\\").join("/"));
if (files.length === 0) { console.error("no test/db suites matched"); process.exit(2); }
console.error(`[test:db] ${files.length} suites: ${files.join(", ")}`);

const child = spawn(process.execPath, [join(serverDir, "test", "support", "run-tests.mjs"), "--import", "tsx", ...options, ...files], { stdio: "inherit", cwd: serverDir });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
