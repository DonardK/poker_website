#!/usr/bin/env node
/**
 * `npm test -w @poker/edge`: both Vitest projects, the poker-api Worker
 * (vitest.config.ts) and the poker-payments Worker (vitest.payments.config.ts).
 * The second runs even when the first fails, so one report covers both; the
 * exit code is non-zero if either failed. Arguments go to both runs (a test
 * path that matches no file in a project is not an error there).
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const run = (extra) => spawnSync("npx", ["--no-install", "vitest", "run", "--passWithNoTests", ...extra, ...args], { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
const api = run([]);
const payments = run(["-c", "vitest.payments.config.ts"]);
process.exit(api !== 0 || payments !== 0 ? 1 : 0);
