/**
 * Migrations against a real PostgreSQL (the disposable embedded cluster of
 * test/support/pg.mjs; never the database configured in `.env`).
 *
 * Proves:
 * - every migration in prisma/migrations applies from scratch, in order, with
 *   `prisma migrate deploy` (exactly how production is migrated), into a brand
 *   new database of the test cluster, and each is recorded as finished, never
 *   rolled back, with the checksum of the file in the repository;
 * - `prisma migrate status` then reports the database up to date (nothing
 *   pending, failed or unknown);
 * - schema.prisma matches the migrated database: `prisma migrate diff
 *   --from-url <migrated db> --to-schema-datamodel prisma/schema.prisma
 *   --exit-code` finds no difference (exit 0). On drift the failure prints the
 *   SQL Prisma would run, so the difference is named exactly.
 * - re-running `migrate deploy` on an up-to-date database is a no-op.
 *
 * Run: npm run test:db -w @poker/server  (or, inside pg.mjs --exec,
 *      node test/support/run-tests.mjs --import tsx test/db/migrations.test.mjs)
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrateDeploy, migrationNames, migrationsDir, runPrisma, withDatabase } from "../support/pg.mjs";
import { requireTestDatabase, tag } from "./support.mjs";

const { adminUrl } = requireTestDatabase();
const freshName = `poker_fresh_${tag()}`;
const freshUrl = withDatabase(adminUrl, freshName);
let deployOutput = "";

before(async () => {
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE ${freshName}`); } finally { await maintenance.end(); }
  const result = migrateDeploy(freshUrl);
  deployOutput = result.stdout + result.stderr;
});

after(async () => {
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS ${freshName} WITH (FORCE)`); } finally { await maintenance.end(); }
});

async function query(url, sql, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
}

test("every migration applies from scratch into an empty database, in order, finished, never rolled back, with the repository checksum", async () => {
  const names = migrationNames();
  assert.ok(names.length >= 7, `found ${names.length} migrations`);
  for (const name of names) assert.match(deployOutput, new RegExp(`Applying migration \`${name}\``), `${name} was applied by this deploy`);
  const rows = await query(freshUrl, `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count, started_at FROM public._prisma_migrations ORDER BY started_at, migration_name`);
  assert.deepEqual(rows.map((row) => row.migration_name), names, "exactly the repository's migrations, applied in lexicographic order");
  for (const row of rows) {
    assert.ok(row.finished_at, `${row.migration_name} finished`);
    assert.equal(row.rolled_back_at, null, `${row.migration_name} not rolled back`);
    assert.equal(row.applied_steps_count, 1, `${row.migration_name} applied once`);
    const sha = createHash("sha256").update(readFileSync(join(migrationsDir, row.migration_name, "migration.sql"))).digest("hex");
    assert.equal(row.checksum, sha, `${row.migration_name}: recorded checksum matches migration.sql in the repository`);
  }
});

test("the harness database (the one every other suite uses) has the same migrations applied", async () => {
  const rows = await query(adminUrl, `SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
  assert.deepEqual(rows.map((row) => row.migration_name), migrationNames());
});

test("prisma migrate status: the database schema is up to date", () => {
  for (const url of [freshUrl, adminUrl]) {
    const result = runPrisma(["migrate", "status"], url);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `migrate status exit ${result.status}:\n${output}`);
    assert.match(output, /Database schema is up to date!/, output);
    assert.doesNotMatch(output, /not yet been applied|failed|have not been applied|not found locally/i, output);
  }
});

test("prisma migrate deploy on an up-to-date database applies nothing", () => {
  const result = migrateDeploy(freshUrl);
  const output = result.stdout + result.stderr;
  assert.match(output, /No pending migrations to apply/, output);
});

test("schema.prisma matches the migrated database (prisma migrate diff --exit-code reports no drift)", async () => {
  const result = runPrisma(["migrate", "diff", "--from-url", freshUrl, "--to-schema-datamodel", "prisma/schema.prisma", "--script", "--exit-code"], freshUrl);
  const output = (result.stdout + result.stderr).trim();
  // --exit-code: 0 = no difference, 2 = difference, 1 = error.
  assert.notEqual(result.status, 1, `prisma migrate diff failed:\n${output}`);
  assert.equal(result.status, 0, `schema.prisma differs from the migrated database. SQL that would make the database match schema.prisma:\n${output}`);

  // Positive control: the same command does see a difference when there is one.
  await query(freshUrl, 'ALTER TABLE public."BotStatistic" ADD COLUMN drift_probe integer');
  try {
    const drifted = runPrisma(["migrate", "diff", "--from-url", freshUrl, "--to-schema-datamodel", "prisma/schema.prisma", "--script", "--exit-code"], freshUrl);
    assert.equal(drifted.status, 2, drifted.stdout + drifted.stderr);
    assert.match(drifted.stdout, /drift_probe/);
  } finally { await query(freshUrl, 'ALTER TABLE public."BotStatistic" DROP COLUMN drift_probe'); }
});
