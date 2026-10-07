/**
 * Shared helpers for the real-database suites (test/db/*.test.mjs).
 *
 * These suites run ONLY through `npm run test:db`, which starts a disposable
 * embedded PostgreSQL (test/support/pg.mjs) and runs them through
 * test/support/run-tests.mjs with:
 * - POKER_TEST_DATABASE_URL       the least-privileged runtime role (poker_server):
 *                                 run-tests.mjs makes it DATABASE_URL, so the built
 *                                 server modules connect exactly as in production;
 * - POKER_TEST_ADMIN_DATABASE_URL the cluster superuser, for fixtures that the
 *                                 runtime role may not write and for inspecting
 *                                 privileges.
 * requireTestDatabase() refuses to run anywhere else (both URLs must be on
 * 127.0.0.1 and DATABASE_URL must be the runtime URL), so a suite started by
 * hand can never touch the live database configured in `.env`.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { assertLoopbackUrl } from "../support/pg.mjs";

export function requireTestDatabase() {
  const runtimeUrl = process.env.POKER_TEST_DATABASE_URL;
  const adminUrl = process.env.POKER_TEST_ADMIN_DATABASE_URL;
  if (!runtimeUrl || !adminUrl) throw new Error("Real-database suites run only via `npm run test:db -w @poker/server` (embedded PostgreSQL); POKER_TEST_DATABASE_URL / POKER_TEST_ADMIN_DATABASE_URL are not set");
  assertLoopbackUrl(runtimeUrl, "POKER_TEST_DATABASE_URL");
  assertLoopbackUrl(adminUrl, "POKER_TEST_ADMIN_DATABASE_URL");
  if (process.env.DATABASE_URL !== runtimeUrl) throw new Error("DATABASE_URL is not the test runtime URL; run through test/support/run-tests.mjs");
  return { runtimeUrl, adminUrl };
}

/** A connected node-postgres client; closed by the test's `after`. */
export async function connect(t, url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  t.after(() => client.end());
  return client;
}

/** A short unique tag, so every test's fixtures are its own (usernames are unique). */
export function tag() { return randomBytes(5).toString("hex"); }

/** Insert a HUMAN user with a bankroll (as the superuser: fixtures are not what is under test). */
export async function createUser(admin, name, bankroll) {
  const id = `u_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."User" (id, username, bankroll, "updatedAt") VALUES ($1, $2, $3, now())`, [id, name, bankroll]);
  return id;
}

/**
 * Insert an empty WAITING table (no saved state: the first mutation builds it
 * from the seat rows, as for a table created by the lobby route).
 * Blinds 5/10, buy-in 200..2000, the limits the Table_valid_limits check accepts.
 */
export async function createTable(admin, name, maxSeats = 6) {
  const id = `t_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."Table" (id, name, "maxSeats", "smallBlind", "bigBlind", "minBuyIn", "maxBuyIn", "timeBankMs", "updatedAt")
    VALUES ($1, $2, $3, 5, 10, 200, 2000, 15000, now())`, [id, name, maxSeats]);
  for (let seatIndex = 0; seatIndex < maxSeats; seatIndex++) {
    await admin.query(`INSERT INTO public."TableSeat" (id, "tableId", "seatIndex") VALUES ($1, $2, $3)`, [`s_${tag()}${tag()}`, id, seatIndex]);
  }
  return id;
}

/**
 * Insert a live session for `userId` and return its id. Columns are taken from
 * the migrated schema, so required columns added by later migrations (for
 * example Session."absoluteExpiresAt") get a valid future value too.
 */
export async function createSession(admin, userId) {
  const id = `sess_${tag()}${tag()}`;
  const { rows } = await admin.query(`SELECT column_name, is_nullable, column_default, is_generated FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Session'`);
  const values = new Map([["id", id], ["userId", userId], ["refreshToken", randomBytes(32).toString("hex")], ["expiresAt", new Date(Date.now() + 3_600_000)]]);
  for (const column of rows) {
    if (values.has(column.column_name) || column.is_nullable === "YES" || column.column_default != null || column.is_generated === "ALWAYS") continue;
    if (/expires|until/i.test(column.column_name)) values.set(column.column_name, new Date(Date.now() + 3_600_000));
    else throw new Error(`createSession: no fixture value for required Session column ${column.column_name}`);
  }
  const names = [...values.keys()];
  await admin.query(`INSERT INTO public."Session" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, [...values.values()]);
  return id;
}

export async function bankroll(admin, userId) {
  return (await admin.query(`SELECT bankroll FROM public."User" WHERE id = $1`, [userId])).rows[0].bankroll;
}

/** The seat rows that hold `userId` anywhere. */
export async function seatsOf(admin, userId) {
  return (await admin.query(`SELECT "tableId", "seatIndex", stack, status FROM public."TableSeat" WHERE "userId" = $1`, [userId])).rows;
}

/**
 * Every chip these fixtures can hold: the users' bankrolls plus every seat
 * stack at the tables (including seats of tables created during the test).
 * Only meaningful between hands (WAITING/COMPLETE, or SHOWDOWN once settled):
 * chips committed to a running hand are in no seat row.
 */
export async function totalChips(admin, userIds, tableIds) {
  const banked = await admin.query(`SELECT COALESCE(SUM(bankroll), 0)::bigint AS n FROM public."User" WHERE id = ANY($1)`, [userIds]);
  const seated = await admin.query(`SELECT COALESCE(SUM(stack), 0)::bigint AS n FROM public."TableSeat" WHERE "tableId" = ANY($1) OR "userId" = ANY($2)`, [tableIds, userIds]);
  return Number(banked.rows[0].n) + Number(seated.rows[0].n);
}

/**
 * Force real overlap: hold a row lock (SELECT ... FOR UPDATE in an open
 * superuser transaction), start the racing operations, wait until `waiters`
 * backends of this database are blocked on a lock, then release. Every racer is
 * then inside its transaction at the same point, instead of the first one
 * finishing before the second begins.
 * @returns the racers' Promise.allSettled results, in order.
 */
export async function raceBehindRowLock(t, adminUrl, lockSql, lockParams, waiters, racers) {
  const holder = await connect(t, adminUrl);
  const watcher = await connect(t, adminUrl);
  await holder.query("BEGIN");
  const locked = await holder.query(lockSql, lockParams);
  if (locked.rowCount !== 1) throw new Error("raceBehindRowLock: the lock query must lock exactly one row");
  const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const results = Promise.allSettled(racers.map((run) => run()));
  const deadline = Date.now() + 15_000;
  let blocked = 0;
  while (Date.now() < deadline) {
    blocked = Number((await watcher.query(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [holderPid])).rows[0].n);
    if (blocked >= waiters) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await holder.query("COMMIT");
  if (blocked < waiters) throw new Error(`raceBehindRowLock: only ${blocked} of ${waiters} racers reached the lock`);
  return results;
}

/** The error code of a rejected race result (EngineError.code, or a Prisma code such as P2002). */
export function codeOf(result) {
  return result.status === "rejected" ? result.reason?.code ?? result.reason?.message : null;
}
