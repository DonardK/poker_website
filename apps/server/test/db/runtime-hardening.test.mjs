/**
 * Runtime login, append-only hand history, foreign keys, chip caps and indexes
 * (migration 20261010120000_runtime_hardening) on the disposable cluster.
 * Run: npm run test:db -w @poker/server
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { assertRestrictedRuntimeRole, readRuntimeRole, RuntimeRoleError } from "../../src/db/runtime-role.ts";
import { createTable, createUser, requireTestDatabase, tag } from "./support.mjs";

const { adminUrl, runtimeUrl } = requireTestDatabase();
const CAP = 1_000_000_000;

let admin;
let runtime;

before(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  runtime = new pg.Client({ connectionString: runtimeUrl });
  await admin.connect();
  await runtime.connect();
});
after(async () => { await runtime?.end(); await admin?.end(); });

async function expectCode(run, codes, pattern) {
  const allowed = Array.isArray(codes) ? codes : [codes];
  try {
    await run();
    assert.fail(`expected SQLSTATE ${allowed.join(" or ")}`);
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    assert.ok(allowed.includes(error.code), `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
  }
}

/** A failing statement aborts the open transaction; a savepoint lets the test continue. */
async function expectCodeInTx(client, run, codes, pattern) {
  await client.query("SAVEPOINT expect_code");
  await expectCode(run, codes, pattern);
  await client.query("ROLLBACK TO SAVEPOINT expect_code");
}

test("poker_app passes the startup probe and the administrator does not", async () => {
  assertRestrictedRuntimeRole(await readRuntimeRole(async (sql) => (await runtime.query(sql)).rows));
  const adminRow = await readRuntimeRole(async (sql) => (await admin.query(sql)).rows);
  await assert.rejects(() => Promise.resolve().then(() => assertRestrictedRuntimeRole(adminRow)), RuntimeRoleError);
  const { rows: [direct] } = await admin.query(`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE grantee = 'poker_app' AND table_schema = 'public'`);
  assert.equal(direct.n, 0, "poker_app has no direct table grants; it inherits poker_server");
  await admin.query("SELECT public.poker_assert_rls()");
});

test("hand history is append-only unless poker.break_glass is on, and parents cannot cascade-delete it", async () => {
  const userId = await createUser(admin, `hist_${tag()}`, 1_000);
  const tableId = await createTable(admin, `hist_${tag()}`);
  const handId = `h_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."Hand" (id, "tableId", "handNumber", "dealerSeat", board) VALUES ($1, $2, 1, 0, '{}')`, [handId, tableId]);
  await admin.query(`INSERT INTO public."HandPlayer" (id, "handId", "userId", "seatIndex", "playerKind", "startingStack", "endingStack", net)
    VALUES ($1, $2, $3, 0, 'HUMAN', 100, 150, 50)`, [`hp_${tag()}${tag()}`, handId, userId]);

  await expectCode(() => admin.query(`UPDATE public."Hand" SET "potTotal" = 1 WHERE id = $1`, [handId]), "AP001", /APPEND_ONLY/);
  await expectCode(() => admin.query(`DELETE FROM public."Hand" WHERE id = $1`, [handId]), "AP001", /APPEND_ONLY/);
  // RESTRICT is 23001 on current PostgreSQL and 23503 on older servers.
  await expectCode(() => admin.query(`DELETE FROM public."Table" WHERE id = $1`, [tableId]), ["23001", "23503"]);
  await expectCode(() => admin.query(`DELETE FROM public."User" WHERE id = $1`, [userId]), ["23001", "23503"]);

  await runtime.query("BEGIN");
  try {
    await runtime.query("SELECT set_config('poker.break_glass', 'on', true)");
    await expectCode(() => runtime.query(`UPDATE public."Hand" SET "potTotal" = 1 WHERE id = $1`, [handId]), "42501");
  } finally { await runtime.query("ROLLBACK"); }

  await admin.query("BEGIN");
  try {
    await admin.query("SELECT set_config('poker.break_glass', 'on', true)");
    const updated = await admin.query(`UPDATE public."Hand" SET "potTotal" = 1 WHERE id = $1`, [handId]);
    assert.equal(updated.rowCount, 1);
    await expectCodeInTx(admin, () => admin.query(`UPDATE public."Hand" SET "potTotal" = $2 WHERE id = $1`, [handId, CAP + 1]), "23514");
    const removed = await admin.query(`DELETE FROM public."Hand" WHERE id = $1`, [handId]);
    assert.equal(removed.rowCount, 1);
    const { rows: [left] } = await admin.query(`SELECT count(*)::int AS n FROM public."HandPlayer" WHERE "handId" = $1`, [handId]);
    assert.equal(left.n, 0, "break_glass delete of a hand removes its players too");
  } finally { await admin.query("ROLLBACK"); }

  const { rows: [still] } = await admin.query(`SELECT "potTotal" FROM public."Hand" WHERE id = $1`, [handId]);
  assert.equal(still.potTotal, 0, "the break_glass transaction rolled back");
});

test("chip caps stay inside int4 and the lobby and session indexes exist", async () => {
  const userId = await createUser(admin, `cap_${tag()}`, 1_000);
  const tableId = await createTable(admin, `cap_${tag()}`);
  await admin.query("BEGIN");
  try {
    const ok = await admin.query(`UPDATE public."User" SET bankroll = $2 WHERE id = $1`, [userId, CAP]);
    assert.equal(ok.rowCount, 1);
    await expectCodeInTx(admin, () => admin.query(`UPDATE public."User" SET bankroll = $2 WHERE id = $1`, [userId, CAP + 1]), "23514");
    await expectCodeInTx(admin, () => admin.query(`UPDATE public."TableSeat" SET stack = $2 WHERE "tableId" = $1 AND "seatIndex" = 0`, [tableId, CAP + 1]), "23514");
  } finally { await admin.query("ROLLBACK"); }

  const { rows: indexes } = await admin.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [["Session_expiresAt_idx", "Table_isPrivate_status_createdAt_idx"]]);
  const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
  assert.match(byName.get("Session_expiresAt_idx") ?? "", /"expiresAt"/);
  const lobby = byName.get("Table_isPrivate_status_createdAt_idx") ?? "";
  assert.match(lobby, /"isPrivate"/);
  assert.match(lobby, /\bstatus\b/);
  assert.match(lobby, /"createdAt" DESC/);
});
