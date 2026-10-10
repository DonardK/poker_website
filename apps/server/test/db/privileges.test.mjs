/**
 * Database privileges after every migration, on a real PostgreSQL (the
 * disposable embedded cluster of test/support/pg.mjs; never `.env`).
 *
 * Proves, from the catalogs AND by attempting the statements as the runtime
 * role (poker_server, exactly as the game server connects in production):
 * - row level security is ENABLED and FORCED on every table in schema public
 *   (except Prisma's own _prisma_migrations), and every such table has a policy;
 * - PUBLIC holds no privilege on any table, sequence or SECURITY DEFINER
 *   function in schema public;
 * - poker_server's table privileges are exactly the expected matrix: hand
 *   history (Hand, HandPlayer, HandAction, HandPot) is append-only, User and
 *   Table rows cannot be deleted, the ledger tables are read-only (balances
 *   change only through public.ledger_post), _prisma_migrations is untouchable,
 *   and nothing grants TRUNCATE, REFERENCES or TRIGGER;
 * - poker_server cannot CREATE in schema public, is not a superuser, cannot
 *   bypass RLS, create roles or databases, and is a member of no other role;
 * - poker_server may execute only the two ledger entry points among the
 *   SECURITY DEFINER functions.
 *
 * Run: npm run test:db -w @poker/server
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { requireTestDatabase } from "./support.mjs";

const { adminUrl, runtimeUrl } = requireTestDatabase();
const RUNTIME_ROLE = "poker_server";
const HISTORY = ["Hand", "HandPlayer", "HandAction", "HandPot"];
const LEDGER = ["Asset", "LedgerAccount", "LedgerTransaction", "LedgerEntry"];
const ALL = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** What poker_server may do on each table; every table in public must be listed here. */
const EXPECTED = {
  User: ["SELECT", "INSERT", "UPDATE"],
  Session: ALL,
  Table: ["SELECT", "INSERT", "UPDATE"],
  TableSeat: ALL,
  Hand: ["SELECT", "INSERT"],
  HandPlayer: ["SELECT", "INSERT"],
  HandAction: ["SELECT", "INSERT"],
  HandPot: ["SELECT", "INSERT"],
  BotStatistic: ALL,
  Asset: ["SELECT"],
  LedgerAccount: ["SELECT"],
  LedgerTransaction: ["SELECT"],
  LedgerEntry: ["SELECT"],
  // Incidents are recorded, never rewritten or deleted; only their resolution
  // columns may be updated (EXPECTED_COLUMNS).
  TableIncident: ["SELECT", "INSERT"],
  _prisma_migrations: [],
};
/** Column-level grants beyond the table matrix, exactly: table -> privilege -> columns. */
const EXPECTED_COLUMNS = {
  TableIncident: { UPDATE: ["resolvedAt", "resolvedBy"] },
};

let admin;
let runtime;

before(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  runtime = new pg.Client({ connectionString: runtimeUrl });
  await admin.connect();
  await runtime.connect();
});
after(async () => { await runtime?.end(); await admin?.end(); });

async function publicTables() {
  const { rows } = await admin.query(`SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  return rows;
}

/** Runs `sql` as poker_server inside a transaction that is always rolled back; resolves to the error (or null). */
async function asRuntime(sql, params = []) {
  await runtime.query("BEGIN");
  try { await runtime.query(sql, params); return null; } catch (error) { return error; } finally { await runtime.query("ROLLBACK"); }
}

async function refusedAsRuntime(sql, params = []) {
  const error = await asRuntime(sql, params);
  assert.ok(error, `poker_server was allowed: ${sql}`);
  assert.equal(error.code, "42501", `expected permission denied (42501) for ${sql}, got ${error.code}: ${error.message}`);
}

test("the runtime connection really is poker_server, a plain role", async () => {
  const { rows: [who] } = await runtime.query("SELECT current_user AS name, session_user AS session");
  assert.equal(who.name, RUNTIME_ROLE);
  assert.equal(who.session, RUNTIME_ROLE);
  const { rows: [role] } = await admin.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname = $1`, [RUNTIME_ROLE]);
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false, rolreplication: false });
  const { rows: memberships } = await admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1`, [RUNTIME_ROLE]);
  assert.deepEqual(memberships, [], "poker_server is a member of no other role");
});

test("RLS is enabled AND forced on every table in schema public except _prisma_migrations, and each has a policy", async () => {
  const tables = await publicTables();
  const app = tables.filter((t) => t.name !== "_prisma_migrations");
  assert.ok(app.length >= 13, `found ${app.length} application tables`);
  const missing = app.filter((t) => !t.enabled || !t.forced).map((t) => `${t.name} (enabled=${t.enabled}, forced=${t.forced})`);
  assert.deepEqual(missing, [], "tables without enabled+forced RLS");
  const { rows } = await admin.query(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename`);
  const policies = new Map(rows.map((row) => [row.tablename, row.n]));
  assert.deepEqual(app.filter((t) => !policies.get(t.name)).map((t) => t.name), [], "every RLS table has a policy for poker_server");
});

test("every table in schema public is in the expected privilege matrix (a new table must be added here deliberately)", async () => {
  const names = (await publicTables()).map((t) => t.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED).sort());
});

test("PUBLIC has no privilege on any table, sequence or SECURITY DEFINER function in schema public", async () => {
  const { rows: tables } = await admin.query(`SELECT c.relname, a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 0`);
  assert.deepEqual(tables, [], "PUBLIC grants on relations");
  const { rows: functions } = await admin.query(`SELECT p.proname, a.privilege_type FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a
    WHERE n.nspname = 'public' AND p.prosecdef AND a.grantee = 0`);
  assert.deepEqual(functions, [], "PUBLIC may execute no SECURITY DEFINER function");
  const { rows: [schema] } = await admin.query(`SELECT has_schema_privilege('public', 'public', 'CREATE') AS create`);
  assert.equal(schema.create, false, "PUBLIC has no CREATE on schema public");
});

test("poker_server's table privileges are exactly the expected matrix (catalog check)", async () => {
  const actual = {};
  for (const name of Object.keys(EXPECTED)) {
    actual[name] = [];
    for (const privilege of PRIVILEGES) {
      const { rows: [row] } = await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [RUNTIME_ROLE, name, privilege]);
      if (row.ok) actual[name].push(privilege);
    }
  }
  assert.deepEqual(actual, EXPECTED);
  const { rows: columns } = await admin.query(`SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
    WHERE grantee = $1 AND table_schema = 'public' AND privilege_type <> 'SELECT'`, [RUNTIME_ROLE]);
  const columnGrant = (c) => (EXPECTED_COLUMNS[c.table_name]?.[c.privilege_type] ?? []).includes(c.column_name);
  const extra = columns.filter((c) => !(EXPECTED[c.table_name] ?? []).includes(c.privilege_type) && !columnGrant(c));
  assert.deepEqual(extra, [], "no column-level grant goes beyond the table matrix and EXPECTED_COLUMNS");
  for (const [table, byPrivilege] of Object.entries(EXPECTED_COLUMNS)) {
    for (const [privilege, expected] of Object.entries(byPrivilege)) {
      const granted = columns.filter((c) => c.table_name === table && c.privilege_type === privilege).map((c) => c.column_name).sort();
      assert.deepEqual(granted, [...expected].sort(), `${privilege} columns of ${table}`);
    }
  }
});

test("poker_server can resolve a TableIncident but never rewrite or delete one", async () => {
  // Privileges are checked when the statement is planned, so WHERE false needs no fixture rows.
  assert.equal(await asRuntime(`UPDATE public."TableIncident" SET "resolvedAt" = now(), "resolvedBy" = 'operator' WHERE false`), null);
  for (const column of ["kind", "reason", "createdAt", "tableId", "id"]) {
    await refusedAsRuntime(`UPDATE public."TableIncident" SET "${column}" = "${column}" WHERE false`);
  }
  await refusedAsRuntime(`DELETE FROM public."TableIncident" WHERE false`);
  await refusedAsRuntime(`TRUNCATE public."TableIncident"`);
});

test("poker_server cannot UPDATE or DELETE hand history (Hand, HandPlayer, HandAction, HandPot)", async () => {
  for (const table of HISTORY) {
    await refusedAsRuntime(`UPDATE public."${table}" SET id = id`);
    await refusedAsRuntime(`DELETE FROM public."${table}"`);
    await refusedAsRuntime(`TRUNCATE public."${table}"`);
  }
});

test("poker_server cannot DELETE (or TRUNCATE) User or Table rows", async () => {
  for (const table of ["User", "Table"]) {
    await refusedAsRuntime(`DELETE FROM public."${table}"`);
    await refusedAsRuntime(`TRUNCATE public."${table}" CASCADE`);
  }
});

test("poker_server cannot write the ledger tables directly (only through ledger_post / ledger_ensure_account)", async () => {
  for (const table of LEDGER) {
    await refusedAsRuntime(`INSERT INTO public."${table}" DEFAULT VALUES`);
    await refusedAsRuntime(`UPDATE public."${table}" SET "createdAt" = "createdAt"`);
    await refusedAsRuntime(`DELETE FROM public."${table}"`);
    await refusedAsRuntime(`TRUNCATE public."${table}"`);
  }
  for (const sequence of ["LedgerAccount_id_seq", "LedgerTransaction_seq_seq", "LedgerEntry_id_seq"]) {
    await refusedAsRuntime(`SELECT nextval('public."${sequence}"')`);
  }
  // And the read access it is meant to have works.
  for (const table of LEDGER) assert.equal(await asRuntime(`SELECT 1 FROM public."${table}" LIMIT 1`), null, `SELECT on ${table}`);
});

test("poker_server cannot touch Prisma's migration history", async () => {
  await refusedAsRuntime(`SELECT 1 FROM public._prisma_migrations`);
  await refusedAsRuntime(`DELETE FROM public._prisma_migrations`);
});

test("poker_server has no CREATE on schema public (no tables, views, functions or types of its own)", async () => {
  const { rows: [row] } = await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS create, has_schema_privilege($1, 'public', 'USAGE') AS usage`, [RUNTIME_ROLE]);
  assert.deepEqual(row, { create: false, usage: true });
  await refusedAsRuntime(`CREATE TABLE public.poker_server_probe (id int)`);
  await refusedAsRuntime(`CREATE VIEW public.poker_server_probe AS SELECT 1`);
  await refusedAsRuntime(`CREATE FUNCTION public.poker_server_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  const { rows: [db] } = await admin.query(`SELECT has_database_privilege($1, current_database(), 'CREATE') AS create`, [RUNTIME_ROLE]);
  assert.equal(db.create, false, "no CREATE SCHEMA in the database either");
});

test("poker_server cannot change table structure, policies or RLS settings", async () => {
  await refusedAsRuntime(`ALTER TABLE public."User" DISABLE ROW LEVEL SECURITY`);
  await refusedAsRuntime(`ALTER TABLE public."Hand" ADD COLUMN probe int`);
  await refusedAsRuntime(`DROP POLICY server_only ON public."User"`);
  await refusedAsRuntime(`ALTER TABLE public."LedgerEntry" DISABLE TRIGGER USER`);
});

test("among SECURITY DEFINER functions poker_server may execute only ledger_post and ledger_ensure_account", async () => {
  const { rows } = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY p.proname`, [RUNTIME_ROLE]);
  assert.deepEqual(rows.map((row) => row.proname), ["ledger_ensure_account", "ledger_post"]);
});
