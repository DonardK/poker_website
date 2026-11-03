/**
 * Database privileges after every migration, on a real PostgreSQL (the
 * disposable embedded cluster of test/support/pg.mjs; never `.env`).
 *
 * Proves, from the catalogs AND by attempting the statements as the runtime
 * login (poker_app, exactly as the game server connects in production; it
 * inherits the NOLOGIN role poker_server):
 * - row level security is ENABLED and FORCED on every table in schema public
 *   (except Prisma's own _prisma_migrations), and every such table has a policy;
 * - PUBLIC holds no privilege on any table, sequence or SECURITY DEFINER
 *   function in schema public;
 * - poker_server's table privileges are exactly the expected matrix: hand
 *   history (Hand, HandPlayer, HandAction, HandPot) is append-only, User and
 *   Table rows cannot be deleted, the ledger tables are read-only (balances
 *   change only through public.ledger_post), _prisma_migrations is untouchable,
 *   and nothing grants TRUNCATE, REFERENCES or TRIGGER;
 * - account security (20261019100000_account_security): the runtime role
 *   updates only the columns the auth flows change, so a stored TOTP secret,
 *   passkey public key, token hash or code hash can never be rewritten; the
 *   security history is append-only; a StepUpGrant can be minted but never
 *   consumed, changed or deleted by poker_server (the payments role consumes it);
 * - poker_server cannot CREATE in schema public, is not a superuser, cannot
 *   bypass RLS, create roles or databases, and is a member of no other role;
 * - poker_server may execute only the two ledger entry points among the
 *   SECURITY DEFINER functions;
 * - the payments wallet (20261019120000_payments_wallet): the logins
 *   poker_payments_app and poker_backoffice_app inherit exactly one NOLOGIN
 *   group each (poker_payments, poker_backoffice), no login holds two of the
 *   three application groups, and the payments and back-office privileges
 *   are exactly their matrices (tables, columns, functions); each role may
 *   execute only its own ledger entry point and nobody ledger_post_core.
 *
 * Run: npm run test:db -w @poker/server
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { requireTestDatabase } from "./support.mjs";

const { adminUrl, runtimeUrl, paymentsUrl, backofficeUrl } = requireTestDatabase();
const LOGIN_ROLE = "poker_app";
const GRANTED_ROLE = "poker_server";
const HISTORY = ["Hand", "HandPlayer", "HandAction", "HandPot"];
const LEDGER = ["Asset", "LedgerAccount", "LedgerTransaction", "LedgerEntry"];
const ALL = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** What poker_server is granted, and what poker_app inherits; every public table is listed. */
const EXPECTED = {
  User: ["SELECT", "INSERT", "UPDATE"],
  Session: ALL,
  Table: ["SELECT", "INSERT", "UPDATE"],
  TableSeat: ALL,
  Hand: ["SELECT", "INSERT"],
  // Idempotency rows. Append-only, same posture as hand history.
  GameCommand: ["SELECT", "INSERT"],
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
  // Account security. Secrets and hashes are replaced by delete-then-insert;
  // only the columns in EXPECTED_COLUMNS may be updated.
  KnownDevice: ["SELECT", "INSERT", "DELETE"],
  UserTotp: ["SELECT", "INSERT", "DELETE"],
  UserBackupCode: ["SELECT", "INSERT", "DELETE"],
  WebAuthnCredential: ["SELECT", "INSERT", "DELETE"],
  EmailToken: ["SELECT", "INSERT", "DELETE"],
  AuthNonce: ["SELECT", "INSERT", "DELETE"],
  // Append-only security history (also refused by a trigger for every role).
  AccountSecurityEvent: ["SELECT", "INSERT"],
  // The API mints money step-up grants; only the payments role consumes them.
  StepUpGrant: ["SELECT", "INSERT"],
  StepUpEmailChallenge: ["SELECT", "INSERT", "DELETE"],
  // Payments wallet: the runtime writes deposit limits and self-exclusions
  // (whose timing the database decides) and nothing else; KYC identities
  // (PlayerCompliance), the switches and every other wallet table belong to
  // the payments role.
  PlayerCompliance: [],
  ResponsibleGamingLimit: ["SELECT", "INSERT"],
  SelfExclusion: ["SELECT", "INSERT"],
  PaymentSwitch: [],
  PaymentInstrument: [],
  Deposit: [],
  DepositReversal: [],
  WithdrawalQuote: [],
  Withdrawal: [],
  PayoutDispatch: [],
  PayoutAttempt: [],
  PaymentEvent: [],
  PaymentReviewAction: [],
  ReconciliationRun: [],
  ReconciliationIssue: [],
  EmailOutbox: [],
  _prisma_migrations: [],
};
/** Column-level grants beyond the table matrix, exactly: table -> privilege -> columns. */
const EXPECTED_COLUMNS = {
  TableIncident: { UPDATE: ["resolvedAt", "resolvedBy"] },
  KnownDevice: { UPDATE: ["label", "userAgent", "lastIp", "country", "lastSeenAt"] },
  UserTotp: { UPDATE: ["enabledAt", "disabledAt", "lastUsedStep"] },
  UserBackupCode: { UPDATE: ["usedAt"] },
  WebAuthnCredential: { UPDATE: ["counter", "lastUsedAt", "name", "backedUp", "deviceType", "removedAt"] },
  EmailToken: { UPDATE: ["consumedAt"] },
  StepUpEmailChallenge: { UPDATE: ["attempts", "consumedAt"] },
  ResponsibleGamingLimit: { UPDATE: ["cancelledAt"] },
  SelfExclusion: { UPDATE: ["reactivationRequestedAt"] },
};

const WALLET_TABLES = ["PlayerCompliance", "ResponsibleGamingLimit", "SelfExclusion", "PaymentInstrument", "Deposit", "DepositReversal",
  "WithdrawalQuote", "Withdrawal", "PayoutDispatch", "PayoutAttempt", "PaymentEvent", "PaymentReviewAction", "PaymentSwitch",
  "ReconciliationRun", "ReconciliationIssue", "EmailOutbox"];
const SIR = ["SELECT", "INSERT", "UPDATE"];
/**
 * poker_payments (inherited by poker_payments_app): table-level privileges on
 * every public table. The trigger guards narrow every UPDATE further; no
 * DELETE anywhere; the ledger is read-only (postings go through
 * ledger_post_payments only).
 */
const EXPECTED_PAYMENTS = {
  ...Object.fromEntries(Object.keys(EXPECTED).map((name) => [name, []])),
  Asset: ["SELECT"], LedgerAccount: ["SELECT"], LedgerTransaction: ["SELECT"], LedgerEntry: ["SELECT"],
  StepUpGrant: ["SELECT"],
  PlayerCompliance: SIR,
  ResponsibleGamingLimit: ["SELECT", "INSERT"],
  SelfExclusion: ["SELECT"],
  PaymentInstrument: ["SELECT", "INSERT"],
  Deposit: SIR,
  DepositReversal: ["SELECT", "INSERT"],
  WithdrawalQuote: ["SELECT", "INSERT"],
  Withdrawal: SIR,
  PayoutDispatch: SIR,
  PayoutAttempt: ["SELECT", "INSERT"],
  PaymentEvent: ["SELECT", "INSERT"],
  PaymentReviewAction: ["SELECT", "INSERT"],
  PaymentSwitch: ["SELECT"],
  ReconciliationRun: SIR,
  ReconciliationIssue: SIR,
  EmailOutbox: ["SELECT", "INSERT"],
};
/** Column-level grants of poker_payments where it has no table-level grant: table -> privilege -> columns. */
const EXPECTED_PAYMENTS_COLUMNS = {
  User: { SELECT: ["id", "username", "email", "emailVerifiedAt", "role", "kind", "isGuest", "securityHoldUntil", "createdAt"] },
  Session: { SELECT: ["id", "userId", "expiresAt", "absoluteExpiresAt", "revokedAt"] },
  AccountSecurityEvent: { SELECT: ["id", "userId", "type", "createdAt", "data"] },
  StepUpGrant: { UPDATE: ["consumedAt"] },
  ResponsibleGamingLimit: { UPDATE: ["cancelledAt"] },
  SelfExclusion: { UPDATE: ["reactivationAcceptedAt", "reactivationAcceptedBy"] },
  PaymentInstrument: {
    UPDATE: ["status", "depositEnabled", "payoutEnabled", "label", "ownershipMethod", "ownershipProof", "ownershipVerifiedAt", "usableAfter",
      "lastUsedAt", "successfulPayouts", "revokedAt", "revokedReason", "revokedBy", "cardExpMonth", "cardExpYear", "updatedAt"],
  },
  WithdrawalQuote: { UPDATE: ["consumedAt"] },
  PaymentEvent: { UPDATE: ["processedAt", "outcome", "attempts", "nextAttemptAt", "lastError"] },
  PaymentSwitch: { UPDATE: ["enabled", "updatedBy", "reason", "updatedAt"] },
  EmailOutbox: { UPDATE: ["status", "attempts", "nextAttemptAt", "leaseUntil", "lastError", "sentAt"] },
};
/** poker_backoffice (inherited by poker_backoffice_app): reads money and review history, accepts a reactivation; writes no review action. */
const EXPECTED_BACKOFFICE = {
  ...Object.fromEntries(Object.keys(EXPECTED).map((name) => [name, []])),
  Asset: ["SELECT"], LedgerAccount: ["SELECT"], LedgerTransaction: ["SELECT"], LedgerEntry: ["SELECT"],
  PlayerCompliance: ["SELECT"],
  Deposit: ["SELECT"],
  DepositReversal: ["SELECT"],
  Withdrawal: ["SELECT"],
  PaymentReviewAction: ["SELECT"],
  SelfExclusion: ["SELECT"],
};
const EXPECTED_BACKOFFICE_COLUMNS = {
  User: { SELECT: ["id", "username", "email", "role", "kind", "isGuest", "createdAt"] },
  SelfExclusion: { UPDATE: ["reactivationAcceptedAt", "reactivationAcceptedBy"] },
};
/** SECURITY DEFINER functions each login may execute (exactly). */
const EXPECTED_DEFINER_EXECUTE = {
  poker_app: ["ledger_ensure_account", "ledger_post"],
  poker_payments_app: ["ledger_ensure_account", "ledger_post_payments"],
  poker_backoffice_app: ["ledger_ensure_account", "ledger_post_backoffice"],
};
/** Columns of each account-security table the runtime role must never UPDATE (the complement of EXPECTED_COLUMNS). */
const FROZEN_COLUMNS = {
  KnownDevice: ["id", "userId", "deviceHash", "firstSeenAt"],
  UserTotp: ["userId", "secretCiphertext", "createdAt"],
  UserBackupCode: ["id", "userId", "codeHash", "createdAt"],
  WebAuthnCredential: ["id", "userId", "credentialId", "publicKey", "transports", "aaguid", "rpId", "createdAt"],
  EmailToken: ["id", "userId", "purpose", "tokenHash", "email", "credentialsVersion", "data", "expiresAt", "createdAt"],
  AuthNonce: ["id", "purpose", "expiresAt", "createdAt"],
  AccountSecurityEvent: ["id", "userId", "type", "sessionId", "ip", "userAgent", "country", "data", "createdAt"],
  StepUpGrant: ["id", "userId", "sessionId", "purpose", "bindHash", "method", "createdAt", "expiresAt", "consumedAt"],
  StepUpEmailChallenge: ["id", "userId", "sessionId", "purpose", "bindHash", "codeHash", "email", "createdAt", "expiresAt"],
};

let admin;
let runtime;
let payments;
let backoffice;

before(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  runtime = new pg.Client({ connectionString: runtimeUrl });
  payments = new pg.Client({ connectionString: paymentsUrl });
  backoffice = new pg.Client({ connectionString: backofficeUrl });
  await admin.connect();
  await runtime.connect();
  await payments.connect();
  await backoffice.connect();
});
after(async () => { await backoffice?.end(); await payments?.end(); await runtime?.end(); await admin?.end(); });

async function publicTables() {
  const { rows } = await admin.query(`SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  return rows;
}

/** Runs `sql` as poker_app inside a transaction that is always rolled back; resolves to the error (or null). */
async function asRuntime(sql, params = []) {
  await runtime.query("BEGIN");
  try { await runtime.query(sql, params); return null; } catch (error) { return error; } finally { await runtime.query("ROLLBACK"); }
}

async function refusedAsRuntime(sql, params = []) {
  const error = await asRuntime(sql, params);
  assert.ok(error, `runtime login was allowed: ${sql}`);
  assert.equal(error.code, "42501", `expected permission denied (42501) for ${sql}, got ${error.code}: ${error.message}`);
}

/** Runs `sql` on `client` inside a transaction that is always rolled back; resolves to the error (or null). */
async function attempt(client, sql, params = []) {
  await client.query("BEGIN");
  try { await client.query(sql, params); return null; } catch (error) { return error; } finally { await client.query("ROLLBACK"); }
}

async function refusedAs(client, sql, params = []) {
  const error = await attempt(client, sql, params);
  assert.ok(error, `allowed: ${sql}`);
  assert.equal(error.code, "42501", `expected permission denied (42501) for ${sql}, got ${error.code}: ${error.message}`);
}

/** Table-level privileges of `role` on every table in EXPECTED. */
async function tableMatrix(role) {
  const matrix = {};
  for (const name of Object.keys(EXPECTED)) {
    matrix[name] = [];
    for (const privilege of PRIVILEGES) {
      const { rows: [row] } = await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [role, name, privilege]);
      if (row.ok) matrix[name].push(privilege);
    }
  }
  return matrix;
}

/** Column privileges `role` holds without the table-level privilege: table -> privilege -> sorted columns. */
async function columnGrants(role) {
  const { rows } = await admin.query(`
    SELECT c.relname AS "table", a.attname AS "column", p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND has_column_privilege($1, c.oid, a.attnum, p.privilege)
       AND NOT has_table_privilege($1, c.oid, p.privilege)
     ORDER BY 1, 3, 2`, [role]);
  const out = {};
  for (const row of rows) ((out[row.table] ??= {})[row.privilege] ??= []).push(row.column);
  for (const byPrivilege of Object.values(out)) for (const list of Object.values(byPrivilege)) list.sort();
  return out;
}

const sortedColumns = (expected) => Object.fromEntries(Object.entries(expected).map(([table, byPrivilege]) =>
  [table, Object.fromEntries(Object.entries(byPrivilege).map(([privilege, columns]) => [privilege, [...columns].sort()]))]));

test("the runtime connection is poker_app, inheriting NOLOGIN poker_server", async () => {
  const { rows: [who] } = await runtime.query("SELECT current_user AS name, session_user AS session");
  assert.equal(who.name, LOGIN_ROLE);
  assert.equal(who.session, LOGIN_ROLE);
  const { rows: [app] } = await admin.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolreplication FROM pg_roles WHERE rolname = $1`, [LOGIN_ROLE]);
  assert.deepEqual(app, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: true, rolcanlogin: true, rolreplication: false });
  const { rows: [server] } = await admin.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolreplication FROM pg_roles WHERE rolname = $1`, [GRANTED_ROLE]);
  assert.deepEqual(server, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false, rolcanlogin: false, rolreplication: false });
  const { rows: memberships } = await admin.query(`SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1 ORDER BY r.rolname`, [LOGIN_ROLE]);
  assert.deepEqual(memberships, [{ rolname: "poker_server", inherit_option: true, set_option: true }]);
  const { rows: serverMemberships } = await admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1`, [GRANTED_ROLE]);
  assert.deepEqual(serverMemberships, [], "poker_server is a member of no other role");
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

test("poker_app's effective table privileges match poker_server's grants (catalog check)", async () => {
  const actual = {};
  const direct = {};
  for (const name of Object.keys(EXPECTED)) {
    actual[name] = [];
    direct[name] = [];
    for (const privilege of PRIVILEGES) {
      const { rows: [inherited] } = await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [LOGIN_ROLE, name, privilege]);
      const { rows: [granted] } = await admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [GRANTED_ROLE, name, privilege]);
      if (inherited.ok) actual[name].push(privilege);
      if (granted.ok) direct[name].push(privilege);
    }
  }
  assert.deepEqual(actual, EXPECTED, "poker_app inherits the matrix");
  assert.deepEqual(direct, EXPECTED, "poker_server still holds the matrix");
  const { rows: columns } = await admin.query(`SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
    WHERE grantee = $1 AND table_schema = 'public' AND privilege_type <> 'SELECT'`, [GRANTED_ROLE]);
  const columnGrant = (c) => (EXPECTED_COLUMNS[c.table_name]?.[c.privilege_type] ?? []).includes(c.column_name);
  const extra = columns.filter((c) => !(EXPECTED[c.table_name] ?? []).includes(c.privilege_type) && !columnGrant(c));
  assert.deepEqual(extra, [], "no column-level grant goes beyond the table matrix and EXPECTED_COLUMNS");
  for (const [table, byPrivilege] of Object.entries(EXPECTED_COLUMNS)) {
    for (const [privilege, expected] of Object.entries(byPrivilege)) {
      const granted = columns.filter((c) => c.table_name === table && c.privilege_type === privilege).map((c) => c.column_name).sort();
      assert.deepEqual(granted, [...expected].sort(), `${privilege} columns of ${table}`);
      for (const column of expected) {
        const { rows: [row] } = await admin.query(`SELECT has_column_privilege($1, format('public.%I', $2::text), $3, $4) AS ok`, [LOGIN_ROLE, table, column, privilege]);
        assert.equal(row.ok, true, `poker_app inherits ${privilege} on ${table}.${column}`);
      }
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

test("account security: poker_server updates only the columns the auth flows change, never a secret, hash or binding", async () => {
  const { rows } = await admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(FROZEN_COLUMNS)]);
  for (const [table, frozen] of Object.entries(FROZEN_COLUMNS)) {
    const columns = rows.filter((row) => row.table_name === table).map((row) => row.column_name).sort();
    const updatable = EXPECTED_COLUMNS[table]?.UPDATE ?? [];
    assert.deepEqual(columns, [...frozen, ...updatable].sort(), `${table}: every column is either frozen or in EXPECTED_COLUMNS`);
    for (const column of frozen) await refusedAsRuntime(`UPDATE public."${table}" SET "${column}" = "${column}" WHERE false`);
    for (const column of updatable) assert.equal(await asRuntime(`UPDATE public."${table}" SET "${column}" = "${column}" WHERE false`), null, `UPDATE ${table}.${column}`);
    await refusedAsRuntime(`TRUNCATE public."${table}"`);
  }
});

test("poker_server can mint a StepUpGrant but never consume, change or delete one, and cannot rewrite security history", async () => {
  // INSERT ... SELECT ... WHERE false checks the privilege without a fixture row.
  assert.equal(await asRuntime(`INSERT INTO public."StepUpGrant" (id, "userId", "sessionId", purpose, "bindHash", method, "createdAt", "expiresAt")
    SELECT 'g', 'u', 's', 'withdrawal', repeat('a', 64), 'TOTP', now(), now() + interval '1 minute' WHERE false`), null);
  await refusedAsRuntime(`UPDATE public."StepUpGrant" SET "consumedAt" = now() WHERE false`);
  await refusedAsRuntime(`DELETE FROM public."StepUpGrant" WHERE false`);
  await refusedAsRuntime(`UPDATE public."AccountSecurityEvent" SET type = type WHERE false`);
  await refusedAsRuntime(`DELETE FROM public."AccountSecurityEvent" WHERE false`);
  // Beyond poker_server, only the payments role holds anything on these
  // tables (the wallet migration): SELECT on StepUpGrant here, plus the
  // column grants checked in the payments matrix test (consumedAt, and the
  // security events' id, userId, type and createdAt).
  const { rows } = await admin.query(`SELECT grantee, table_name, privilege_type FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND table_name = ANY($1) AND grantee NOT IN ('poker_server', current_user)`,
    [Object.keys(FROZEN_COLUMNS)]);
  assert.deepEqual(rows, [{ grantee: "poker_payments", table_name: "StepUpGrant", privilege_type: "SELECT" }]);
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
  const { rows: [row] } = await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS create, has_schema_privilege($1, 'public', 'USAGE') AS usage`, [LOGIN_ROLE]);
  assert.deepEqual(row, { create: false, usage: true });
  await refusedAsRuntime(`CREATE TABLE public.poker_server_probe (id int)`);
  await refusedAsRuntime(`CREATE VIEW public.poker_server_probe AS SELECT 1`);
  await refusedAsRuntime(`CREATE FUNCTION public.poker_server_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  const { rows: [db] } = await admin.query(`SELECT has_database_privilege($1, current_database(), 'CREATE') AS create`, [LOGIN_ROLE]);
  assert.equal(db.create, false, "no CREATE SCHEMA in the database either");
});

test("poker_server cannot change table structure, policies or RLS settings", async () => {
  await refusedAsRuntime(`ALTER TABLE public."User" DISABLE ROW LEVEL SECURITY`);
  await refusedAsRuntime(`ALTER TABLE public."Hand" ADD COLUMN probe int`);
  await refusedAsRuntime(`DROP POLICY server_only ON public."User"`);
  await refusedAsRuntime(`ALTER TABLE public."LedgerEntry" DISABLE TRIGGER USER`);
});

test("among SECURITY DEFINER functions the runtime login may execute only ledger_post and ledger_ensure_account", async () => {
  const { rows } = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY p.proname`, [LOGIN_ROLE]);
  assert.deepEqual(rows.map((row) => row.proname), ["ledger_ensure_account", "ledger_post"]);
});

test("payments roles: two NOLOGIN groups, one LOGIN per group, and no login holds two application groups", async () => {
  const attributes = `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolreplication FROM pg_roles WHERE rolname = $1`;
  const login = { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: true, rolcanlogin: true, rolreplication: false };
  const group = { ...login, rolinherit: false, rolcanlogin: false };
  for (const [role, expected] of [["poker_payments", group], ["poker_backoffice", group], ["poker_payments_app", login], ["poker_backoffice_app", login]]) {
    const { rows } = await admin.query(attributes, [role]);
    assert.deepEqual(rows, [expected], role);
  }
  const memberships = async (role) => (await admin.query(`SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1 ORDER BY r.rolname`, [role])).rows;
  assert.deepEqual(await memberships("poker_payments_app"), [{ rolname: "poker_payments", inherit_option: true, set_option: true }]);
  assert.deepEqual(await memberships("poker_backoffice_app"), [{ rolname: "poker_backoffice", inherit_option: true, set_option: true }]);
  assert.deepEqual(await memberships("poker_payments"), [], "the payments group is a member of no other role");
  assert.deepEqual(await memberships("poker_backoffice"), [], "the back-office group is a member of no other role");
  // Exactly one of the three groups for every application login (and group).
  const { rows: holders } = await admin.query(`SELECT r.rolname,
      pg_has_role(r.oid, 'poker_server', 'MEMBER')::int + pg_has_role(r.oid, 'poker_payments', 'MEMBER')::int
        + pg_has_role(r.oid, 'poker_backoffice', 'MEMBER')::int AS groups
      FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname LIKE 'poker\\_%' ORDER BY r.rolname`);
  assert.deepEqual(holders.filter((row) => row.groups !== 1), [], "every poker_* role holds exactly one application group");
  for (const role of ["poker_app", "poker_payments_app", "poker_backoffice_app"]) {
    assert.ok(holders.some((row) => row.rolname === role), `${role} exists`);
  }
  // The connections really are those logins.
  for (const [client, role] of [[payments, "poker_payments_app"], [backoffice, "poker_backoffice_app"]]) {
    const { rows: [who] } = await client.query("SELECT current_user AS name, session_user AS session");
    assert.deepEqual(who, { name: role, session: role });
  }
  // The logins read and write timestamps in UTC whatever the server default is (the triggers use the database clock).
  for (const client of [payments, backoffice]) {
    assert.equal((await client.query("SHOW timezone")).rows[0].TimeZone, "UTC");
  }
});

test("payments and back-office table privileges are exactly their matrices (and the logins inherit them)", async () => {
  for (const [group, loginRole, expected] of [
    ["poker_payments", "poker_payments_app", EXPECTED_PAYMENTS], ["poker_backoffice", "poker_backoffice_app", EXPECTED_BACKOFFICE]]) {
    assert.deepEqual(await tableMatrix(group), expected, `${group} holds its matrix`);
    assert.deepEqual(await tableMatrix(loginRole), expected, `${loginRole} inherits it`);
  }
  // The runtime's table matrix covers the wallet tables too (EXPECTED, checked above); here it holds no wallet column grant beyond EXPECTED_COLUMNS.
  const runtimeColumns = await columnGrants("poker_server");
  for (const table of WALLET_TABLES) {
    assert.deepEqual(runtimeColumns[table] ?? {}, sortedColumns(EXPECTED_COLUMNS)[table] ?? {}, `poker_server columns of ${table}`);
  }
});

test("payments and back-office column grants are exactly the listed columns (never a password hash or a full session)", async () => {
  assert.deepEqual(await columnGrants("poker_payments"), sortedColumns(EXPECTED_PAYMENTS_COLUMNS));
  assert.deepEqual(await columnGrants("poker_payments_app"), sortedColumns(EXPECTED_PAYMENTS_COLUMNS));
  assert.deepEqual(await columnGrants("poker_backoffice"), sortedColumns(EXPECTED_BACKOFFICE_COLUMNS));
  assert.deepEqual(await columnGrants("poker_backoffice_app"), sortedColumns(EXPECTED_BACKOFFICE_COLUMNS));
  // And by attempting the statements as the logins (privileges are checked when a statement is planned, so WHERE false needs no rows).
  await refusedAs(payments, `SELECT "passwordHash" FROM public."User" WHERE false`);
  await refusedAs(payments, `SELECT * FROM public."User" WHERE false`);
  await refusedAs(payments, `SELECT "refreshToken" FROM public."Session" WHERE false`);
  await refusedAs(payments, `SELECT ip FROM public."AccountSecurityEvent" WHERE false`);
  await refusedAs(payments, `SELECT "userAgent" FROM public."AccountSecurityEvent" WHERE false`);
  await refusedAs(payments, `UPDATE public."SelfExclusion" SET "endsAt" = now() WHERE false`);
  await refusedAs(payments, `SELECT "secretCiphertext" FROM public."UserTotp" WHERE false`);
  assert.equal(await attempt(payments, `SELECT id, email, "securityHoldUntil", role FROM public."User" WHERE false`), null);
  // data: what a "This wasn't me" report named, for the sweep that applies a report payments never heard about.
  assert.equal(await attempt(payments, `SELECT id, type, "createdAt", data FROM public."AccountSecurityEvent" WHERE false`), null);
  assert.equal(await attempt(payments, `UPDATE public."StepUpGrant" SET "consumedAt" = now() WHERE false`), null);
  await refusedAs(payments, `UPDATE public."StepUpGrant" SET "bindHash" = "bindHash" WHERE false`);
  await refusedAs(payments, `INSERT INTO public."StepUpGrant" (id, "userId", "sessionId", purpose, "bindHash", method, "createdAt", "expiresAt")
    SELECT 'g', 'u', 's', 'withdrawal', repeat('a', 64), 'TOTP', now(), now() WHERE false`);
  for (const table of WALLET_TABLES) {
    await refusedAs(payments, `DELETE FROM public."${table}" WHERE false`);
    await refusedAs(payments, `TRUNCATE public."${table}"`);
    await refusedAs(backoffice, `DELETE FROM public."${table}" WHERE false`);
    await refusedAs(runtime, `DELETE FROM public."${table}" WHERE false`);
  }
  // The game API's login never sees KYC identities, the switches or any payment row.
  for (const table of ["PlayerCompliance", "PaymentSwitch", "PaymentInstrument", "Deposit", "Withdrawal", "PaymentEvent", "PaymentReviewAction", "EmailOutbox"]) {
    await refusedAs(runtime, `SELECT 1 FROM public."${table}" WHERE false`);
  }
  // Approvals count towards four-eyes rules: the back-office login cannot write one (only poker_payments can).
  await refusedAs(backoffice, `INSERT INTO public."PaymentReviewAction" ("subjectType", "subjectId", "subjectUserId", "actorKind", "actorUserId", "verb")
    SELECT 'USER', 'u', 'u', 'ADMIN', 'u', 'APPROVE' WHERE false`);
  assert.equal(await attempt(backoffice, `SELECT 1 FROM public."PaymentReviewAction" WHERE false`), null, "the back office reads review history");
  for (const table of ["Asset", "LedgerAccount", "LedgerTransaction", "LedgerEntry"]) {
    await refusedAs(payments, `UPDATE public."${table}" SET "createdAt" = "createdAt" WHERE false`);
    await refusedAs(payments, `DELETE FROM public."${table}" WHERE false`);
    await refusedAs(backoffice, `UPDATE public."${table}" SET "createdAt" = "createdAt" WHERE false`);
    assert.equal(await attempt(payments, `SELECT 1 FROM public."${table}" LIMIT 1`), null, `payments reads ${table}`);
  }
  await refusedAs(payments, `INSERT INTO public."LedgerTransaction" ("idempotencyKey", "type", "payloadHash") SELECT 'forged', 'DEPOSIT_CREDIT', repeat('a', 64) WHERE false`);
  await refusedAs(payments, `SELECT nextval('public."LedgerTransaction_seq_seq"')`);
  await refusedAs(backoffice, `SELECT 1 FROM public."PaymentInstrument" WHERE false`);
  await refusedAs(backoffice, `UPDATE public."Withdrawal" SET status = status WHERE false`);
});

test("each login may execute only its own ledger entry point (and ledger_ensure_account); nobody may execute ledger_post_core", async () => {
  for (const [role, expected] of Object.entries(EXPECTED_DEFINER_EXECUTE)) {
    const { rows } = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY p.proname`, [role]);
    assert.deepEqual(rows.map((row) => row.proname), expected, role);
  }
  const { rows: core } = await admin.query(`SELECT r.rolname FROM pg_roles r
    WHERE NOT r.rolsuper AND has_function_privilege(r.oid, 'public.ledger_post_core(text[], text[], text, text, jsonb, jsonb, text)', 'EXECUTE')`);
  const owner = (await admin.query(`SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'ledger_post_core'`)).rows[0].rolname;
  assert.deepEqual(core.map((row) => row.rolname).filter((name) => name !== owner), [], "only the owner can run ledger_post_core");
  // By attempting the calls: a foreign entry point is refused before any argument is looked at.
  const call = (fn) => `SELECT public.${fn}('k', 'PLAY_GRANT', '{}'::jsonb, '[]'::jsonb, NULL)`;
  const coreCall = `SELECT public.ledger_post_core(ARRAY['PLAY_GRANT'], ARRAY['PLAY'], 'k', 'PLAY_GRANT', '{}'::jsonb, '[]'::jsonb, NULL)`;
  for (const [client, own] of [[runtime, "ledger_post"], [payments, "ledger_post_payments"], [backoffice, "ledger_post_backoffice"]]) {
    for (const fn of ["ledger_post", "ledger_post_payments", "ledger_post_backoffice"]) {
      if (fn !== own) await refusedAs(client, call(fn));
    }
    await refusedAs(client, coreCall);
  }
});
