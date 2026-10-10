#!/usr/bin/env node
/**
 * Server test runner that can never reach a configured (live) database.
 *
 * config.ts loads the repository `.env` with dotenv, which does NOT override
 * variables that are already set. This wrapper sets every connection variable
 * before any test module (and so before config.ts) is loaded:
 * - DATABASE_URL / DIRECT_URL point at loopback port 1 (nothing listens there),
 *   unless POKER_TEST_DATABASE_URL names a disposable test database (for
 *   example the embedded Postgres started by test/support/pg.mjs).
 * - REDIS_URL is empty unless POKER_TEST_REDIS_URL is set.
 * Usage: node test/support/run-tests.mjs [node --test options] <test files...>
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const DEAD_DATABASE = "postgresql://nobody:nothing@127.0.0.1:1/none?sslmode=disable";
const testDatabase = process.env.POKER_TEST_DATABASE_URL?.trim();
if (testDatabase) {
  const host = new URL(testDatabase).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`POKER_TEST_DATABASE_URL must point at a local disposable database, not ${host}`);
    process.exit(2);
  }
}

const env = {
  ...process.env,
  DATABASE_URL: testDatabase || DEAD_DATABASE,
  DIRECT_URL: testDatabase || DEAD_DATABASE,
  REDIS_URL: process.env.POKER_TEST_REDIS_URL?.trim() || "",
  POKER_TEST_ISOLATED: "1",
};
// config.ts refuses to load with no game-state key. CI exports one. When this
// process has neither variable, use a throwaway key so the suite can boot.
// A value already in the environment is left alone (dotenv will not replace it).
if (!env.GAME_ENCRYPTION_KEY?.trim() && !env.GAME_ENCRYPTION_KEYS?.trim()) {
  env.GAME_ENCRYPTION_KEY = randomBytes(32).toString("hex");
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
