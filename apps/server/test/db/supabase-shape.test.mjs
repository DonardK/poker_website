/**
 * Every migration on a cluster shaped like the production Supabase project
 * (apps/server/prisma/RUNTIME_ROLE.md), applied with `prisma migrate deploy`
 * exactly as the CI "Production deploy" step runs it. A cluster of its own
 * (roles are cluster-wide, and the harness cluster has poker_server NOLOGIN):
 * - the migration role is NOT a superuser: like Supabase's `postgres` it has
 *   CREATEROLE, CREATEDB, REPLICATION and BYPASSRLS, and owns the database;
 * - anon, authenticated and service_role exist, and default privileges grant
 *   them everything the migration role creates in public (Supabase's default);
 * - poker_server already exists as a LOGIN role (the demo's Hyperdrive user),
 *   created by the migration role.
 * Proves the wallet migrations (20261019110000_ledger_payment_types,
 * 20261019120000_payments_wallet) apply there with the rest: the payments
 * roles are created without a password and with time zone UTC, poker_server
 * stays the LOGIN runtime (no poker_app), no Supabase role keeps any
 * privilege on an application table or ledger function, real money stays off
 * (EUR disabled, every PaymentSwitch off), each login passes the role
 * isolation check of docs/money/WALLET.md section 9.1, and a second deploy
 * applies nothing. Embedded PostgreSQL is version 18; Supabase runs 15 or 17,
 * whose CREATEROLE rules (16+) this shape follows.
 *
 * Run: npm run test:db -w @poker/server  (or node test/db/run-all.mjs supabase-shape)
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrateDeploy, migrationNames, runPrisma, startEmptyCluster } from "../support/pg.mjs";
import { requireTestDatabase } from "./support.mjs";

requireTestDatabase();
const DATABASE = "supabase_shape";
const MIGRATOR = "supabase_admin_like";
const SUPABASE_ROLES = ["anon", "authenticated", "service_role"];
const APP_GROUPS = ["poker_payments", "poker_backoffice"];
const APP_LOGINS = ["poker_payments_app", "poker_backoffice_app"];
const ENTRY_POINTS = {
  runtime: "public.ledger_post(text, text, jsonb, jsonb, text)",
  payments: "public.ledger_post_payments(text, text, jsonb, jsonb, text)",
  backoffice: "public.ledger_post_backoffice(text, text, jsonb, jsonb, text)",
  core: "public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)",
};

let cluster;
let superuser;
let migratorUrl;
let deployOutput = "";

const urlFor = (role, password) => {
  const url = new URL(`${cluster.baseUrl}/${DATABASE}?sslmode=disable`);
  url.username = role;
  url.password = password;
  return url.toString();
};

before(async () => {
  cluster = await startEmptyCluster({ log: (line) => console.error(line) });
  const maintenance = new pg.Client({ connectionString: `${cluster.baseUrl}/postgres?sslmode=disable` });
  await maintenance.connect();
  const migratorPassword = randomBytes(24).toString("hex");
  try {
    await maintenance.query(`CREATE ROLE ${MIGRATOR} LOGIN NOSUPERUSER CREATEROLE CREATEDB REPLICATION BYPASSRLS PASSWORD ${maintenance.escapeLiteral(migratorPassword)}`);
    await maintenance.query("CREATE ROLE anon NOLOGIN NOINHERIT");
    await maintenance.query("CREATE ROLE authenticated NOLOGIN NOINHERIT");
    await maintenance.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    await maintenance.query(`CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR}`);
  } finally { await maintenance.end(); }

  superuser = new pg.Client({ connectionString: `${cluster.baseUrl}/${DATABASE}?sslmode=disable` });
  await superuser.connect();
  await superuser.query(`ALTER SCHEMA public OWNER TO ${MIGRATOR}`);
  await superuser.query(`GRANT USAGE ON SCHEMA public TO ${SUPABASE_ROLES.join(", ")}`);
  for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await superuser.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public GRANT ALL ON ${kind} TO ${SUPABASE_ROLES.join(", ")}`);
  }
  // The demo's runtime login, provisioned by the project owner before any migration.
  await superuser.query(`SET ROLE ${MIGRATOR}`);
  await superuser.query("CREATE ROLE poker_server LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");
  await superuser.query("RESET ROLE");

  migratorUrl = urlFor(MIGRATOR, migratorPassword);
  const result = migrateDeploy(migratorUrl);
  deployOutput = result.stdout + result.stderr;
});

after(async () => {
  await superuser?.end();
  await cluster?.stop();
});

test("every migration applies as a non-superuser migration role with the Supabase roles and default privileges in place", async () => {
  const names = migrationNames();
  for (const name of ["20261019110000_ledger_payment_types", "20261019120000_payments_wallet"]) {
    assert.match(deployOutput, new RegExp(`Applying migration \`${name}\``));
  }
  const { rows } = await superuser.query(`SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name`);
  assert.deepEqual(rows.map((row) => row.migration_name), names);
  assert.ok(rows.every((row) => row.finished_at && !row.rolled_back_at));
  const { rows: [migrator] } = await superuser.query(`SELECT rolsuper FROM pg_roles WHERE rolname = $1`, [MIGRATOR]);
  assert.equal(migrator.rolsuper, false, "the migrations never needed a superuser");
  await superuser.query("SELECT public.poker_assert_rls()");
});

test("poker_server stays the LOGIN runtime; the payments roles exist without a password, in UTC, one group per login", async () => {
  const { rows } = await superuser.query(`SELECT r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
      a.rolpassword IS NULL AS "noPassword", COALESCE(array_to_string(r.rolconfig, ','), '') AS config
    FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname = ANY ($1) ORDER BY r.rolname`, [["poker_server", "poker_app", ...APP_GROUPS, ...APP_LOGINS]]);
  const byName = Object.fromEntries(rows.map((row) => [row.rolname, row]));
  assert.equal(byName.poker_app, undefined, "no poker_app on the Supabase shape");
  assert.equal(byName.poker_server.rolcanlogin, true);
  for (const name of ["poker_server", ...APP_GROUPS, ...APP_LOGINS]) {
    const role = byName[name];
    assert.ok(role, `${name} exists`);
    assert.ok(!role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb, `${name} has no special attribute`);
  }
  for (const name of APP_GROUPS) assert.equal(byName[name].rolcanlogin, false, `${name} is NOLOGIN`);
  for (const name of APP_LOGINS) {
    assert.ok(byName[name].rolcanlogin && byName[name].rolinherit, `${name} is LOGIN INHERIT`);
    assert.equal(byName[name].noPassword, true, `${name} has no password until the operator sets one`);
    assert.match(byName[name].config, /timezone=utc/i, `${name} defaults to time zone UTC`);
  }
  const { rows: [membership] } = await superuser.query(`SELECT
      pg_has_role('poker_payments_app', 'poker_payments', 'USAGE') AS payments,
      pg_has_role('poker_backoffice_app', 'poker_backoffice', 'USAGE') AS backoffice,
      pg_has_role('poker_payments_app', 'poker_server', 'MEMBER') OR pg_has_role('poker_payments_app', 'poker_backoffice', 'MEMBER')
        OR pg_has_role('poker_backoffice_app', 'poker_server', 'MEMBER') OR pg_has_role('poker_backoffice_app', 'poker_payments', 'MEMBER')
        OR pg_has_role('poker_server', 'poker_payments', 'MEMBER') OR pg_has_role('poker_server', 'poker_backoffice', 'MEMBER') AS crossed`);
  assert.deepEqual(membership, { payments: true, backoffice: true, crossed: false });
});

test("no Supabase role keeps a privilege on any application table, sequence or SECURITY DEFINER function", async () => {
  for (const role of SUPABASE_ROLES) {
    const { rows: tables } = await superuser.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') AND c.relname <> '_prisma_migrations'
        AND (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
          OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE')
          OR has_table_privilege($1, c.oid, 'TRUNCATE') OR has_table_privilege($1, c.oid, 'REFERENCES')
          OR has_table_privilege($1, c.oid, 'TRIGGER') OR has_any_column_privilege($1, c.oid, 'SELECT'))
      ORDER BY 1`, [role]);
    assert.deepEqual(tables.map((row) => row.relname), [], `${role} has no table privilege`);
    const { rows: functions } = await superuser.query(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`, [role]);
    assert.deepEqual(functions.map((row) => row.fn), [], `${role} may execute no SECURITY DEFINER function`);
  }
});

test("real money stays off: EUR disabled, TEST_EUR the only enabled non-PLAY asset, every PaymentSwitch off", async () => {
  const { rows } = await superuser.query(`SELECT "code" FROM public."Asset" WHERE "enabled" ORDER BY "code"`);
  assert.deepEqual(rows.map((row) => row.code), ["PLAY", "TEST_EUR"]);
  const { rows: [switches] } = await superuser.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE "enabled")::int AS on FROM public."PaymentSwitch"`);
  assert.deepEqual(switches, { total: 7, on: 0 });
});

test("each login passes the role isolation check: payments may post only payment types, the runtime never", async () => {
  const passwords = {};
  for (const role of ["poker_server", "poker_payments_app"]) {
    passwords[role] = randomBytes(24).toString("hex");
    await superuser.query(`ALTER ROLE ${role} PASSWORD ${superuser.escapeLiteral(passwords[role])}`);
  }
  const isolation = async (role) => {
    const client = new pg.Client({ connectionString: urlFor(role, passwords[role]) });
    await client.connect();
    try {
      const { rows: [row] } = await client.query(`SELECT current_user::text AS "user", r.rolsuper, r.rolbypassrls,
          pg_has_role(current_user, 'poker_payments', 'MEMBER') AS payments,
          pg_has_role(current_user, 'poker_server', 'MEMBER') AS runtime,
          has_function_privilege(current_user, '${ENTRY_POINTS.runtime}', 'EXECUTE') AS "canRuntimePost",
          has_function_privilege(current_user, '${ENTRY_POINTS.payments}', 'EXECUTE') AS "canPaymentsPost",
          has_function_privilege(current_user, '${ENTRY_POINTS.backoffice}', 'EXECUTE') AS "canBackofficePost",
          has_function_privilege(current_user, '${ENTRY_POINTS.core}', 'EXECUTE') AS "canCorePost",
          current_setting('TimeZone') AS "timeZone"
        FROM pg_roles r WHERE r.rolname = current_user`);
      return row;
    } finally { await client.end(); }
  };
  const payments = await isolation("poker_payments_app");
  assert.equal(payments.payments && !payments.runtime && !payments.canRuntimePost && !payments.rolsuper && !payments.rolbypassrls, true, JSON.stringify(payments));
  assert.deepEqual([payments.canPaymentsPost, payments.canBackofficePost, payments.canCorePost, payments.timeZone], [true, false, false, "UTC"]);
  const runtime = await isolation("poker_server");
  assert.equal(runtime.runtime && !runtime.payments && runtime.canRuntimePost && !runtime.rolsuper && !runtime.rolbypassrls, true, JSON.stringify(runtime));
  assert.deepEqual([runtime.canPaymentsPost, runtime.canBackofficePost, runtime.canCorePost], [false, false, false]);
});

test("a second prisma migrate deploy applies nothing", () => {
  const result = runPrisma(["migrate", "deploy"], migratorUrl);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /No pending migrations to apply/);
});
