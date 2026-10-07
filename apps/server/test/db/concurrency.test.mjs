/**
 * Real concurrency with the BUILT game server (dist/game/manager.js) on a real
 * PostgreSQL (the disposable embedded cluster of test/support/pg.mjs).
 *
 * The TableManager here is the production code path: its Prisma client
 * connects as the least-privileged runtime role (poker_server; run-tests.mjs
 * makes POKER_TEST_DATABASE_URL the DATABASE_URL), and every command runs in
 * its own `mutate` transaction behind the Table row lock (SELECT ... FOR
 * UPDATE), paying bankrolls with conditional UPDATEs, exactly as in
 * production. Fixtures are inserted by the superuser (they are not under test).
 *
 * Racers are forced to overlap for real (support.mjs raceBehindRowLock): a
 * superuser transaction holds the row the racers contend for, all racers are
 * started and seen blocked on it in pg_stat_activity, then it is released.
 *
 * Proves, with the total of chips (Σ bankrolls + Σ seat stacks) conserved in
 * every test:
 * - one user claiming seats at two different tables at once: exactly one seat
 *   and exactly one bankroll debit (also when the bankroll covers both, and
 *   when it covers only one);
 * - two users racing for one seat: one wins, the loser's bankroll is unchanged;
 * - one user double-submitting two seats at one table: one seat, one debit;
 * - standUp racing the Hand Clean-up of a settled hand (both orders), and a
 *   repeated standUp racing the Clean-up that pays a pending leaver: the
 *   cash-out is credited exactly once.
 *
 * Timers are off (tableManager.stop()); time is driven explicitly by calling
 * what the timers would call (tryStart, the SHOWDOWN Clean-up mutation).
 * Run: npm run test:db -w @poker/server
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { bankroll, codeOf, createTable, createUser, raceBehindRowLock, requireTestDatabase, seatsOf, tag, totalChips } from "./support.mjs";

const { adminUrl } = requireTestDatabase();
const BUY_IN = 1_000;

let admin;
let manager;
let prisma;
let engine;
let decryptState;

before(async () => {
  // Imported only after requireTestDatabase(): the built config reads DATABASE_URL at import time.
  engine = await import("@poker/engine");
  ({ prisma } = await import("../../dist/db/prisma.js"));
  ({ decryptState } = await import("../../dist/game/encryption.js"));
  const { TableManager } = await import("../../dist/game/manager.js");
  manager = new TableManager();
  manager.stop(); // no game or idle timers: the test drives time
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // The Prisma client really connects as the runtime role.
  const [{ current_user: role }] = await prisma.$queryRaw`SELECT current_user`;
  assert.equal(role, "poker_server");
});

after(async () => {
  manager?.stop();
  await prisma?.$disconnect();
  await admin?.end();
});

/** The stored (encrypted) engine state of a table, as the manager will load it. */
async function stored(tableId) {
  const { rows: [row] } = await admin.query(`SELECT "stateCiphertext", status FROM public."Table" WHERE id = $1`, [tableId]);
  return row.stateCiphertext ? decryptState(row.stateCiphertext, `table:${tableId}`) : null;
}

/** Plays the running hand to SHOWDOWN with check/call, one mutate per action (as players' intents do). */
async function playToShowdown(tableId) {
  for (let n = 0; ; n++) {
    assert.ok(n < 100, "the hand ends");
    const state = await stored(tableId);
    if (state.phase === "SHOWDOWN") return state;
    await manager.mutate(tableId, (table) => {
      const legal = engine.legalActions(table, table.toActSeat);
      return engine.applyAction(table, table.players[table.toActSeat].userId, { action: legal.actions.includes("CHECK") ? "CHECK" : "CALL" });
    });
  }
}

/** What the SHOWDOWN timer runs: Hand Clean-up, then the next deal when two players can play. */
function cleanUp(tableId) {
  return manager.mutate(tableId, (table) => {
    if (table.phase !== "SHOWDOWN") return table;
    let next = engine.completeHand(table);
    const live = next.players.filter((p) => p && !p.sittingOut && p.stack > 0);
    if (live.length >= 2 && next.closingAt == null && next.closeReason == null) next = engine.startHand(next);
    return next;
  });
}

/** A heads-up table with `a` and `b` seated through the manager, each paying BUY_IN. */
async function headsUp(label, start = 5_000) {
  const a = await createUser(admin, `${label}A_${tag()}`, start);
  const b = await createUser(admin, `${label}B_${tag()}`, start);
  const tableId = await createTable(admin, `${label} ${tag()}`, 6);
  await manager.seatClaim(tableId, a, 0, BUY_IN);
  await manager.seatClaim(tableId, b, 1, BUY_IN);
  return { a, b, tableId, users: [a, b], tables: [tableId], total: 2 * start };
}

/**
 * Plays every remaining hand to its end and cleans up, so no chips are left in
 * a pot. Returns the last settled (SHOWDOWN) state it cleaned up, or null.
 */
async function finishHands(tableId) {
  let last = null;
  for (let n = 0; n < 10; n++) {
    const state = await stored(tableId);
    if (!state || state.status === "CLOSED" || state.phase === "WAITING" || state.phase === "COMPLETE") return last;
    last = state.phase === "SHOWDOWN" ? state : await playToShowdown(tableId);
    await manager.mutate(tableId, (table) => table.phase === "SHOWDOWN" ? engine.completeHand(table) : table);
  }
  assert.fail("hands never ended");
}

/**
 * Like support.mjs raceBehindRowLock, but in a fixed order: each racer is
 * started only once the previous one is seen blocked on the held row, so
 * PostgreSQL's lock queue grants them the row in the order given.
 */
async function raceInOrder(t, lockSql, lockParams, racers) {
  const holder = new pg.Client({ connectionString: adminUrl });
  await holder.connect();
  t.after(() => holder.end());
  await holder.query("BEGIN");
  assert.equal((await holder.query(lockSql, lockParams)).rowCount, 1);
  const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const pending = [];
  for (const run of racers) {
    pending.push(run().then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })));
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { rows: [row] } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [holderPid]);
      if (row.n >= pending.length) break;
      if (Date.now() > deadline) throw new Error(`raceInOrder: racer ${pending.length} never blocked on the row`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await holder.query("COMMIT");
  return Promise.all(pending);
}

test("one user claims seats at two different tables at once: exactly one seat, exactly one bankroll debit", async (t) => {
  for (const start of [5_000, 1_500]) { // covers both buy-ins / only one buy-in
    const user = await createUser(admin, `twoTables_${tag()}`, start);
    const tables = [await createTable(admin, `race A ${tag()}`), await createTable(admin, `race B ${tag()}`)];
    const before = await totalChips(admin, [user], tables);
    assert.equal(before, start);
    // Both claims lock their own Table row, then block on the user's row (the debit).
    const results = await raceBehindRowLock(t, adminUrl, `SELECT id FROM public."User" WHERE id = $1 FOR UPDATE`, [user], 2,
      tables.map((tableId, seat) => () => manager.seatClaim(tableId, user, seat, BUY_IN)));
    const won = results.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, `exactly one claim succeeds: ${results.map((r) => r.status === "fulfilled" ? "ok" : codeOf(r)).join(", ")}`);
    const loser = results.find((r) => r.status === "rejected");
    assert.ok(["ALREADY_SEATED", "BANKROLL", "P2002"].includes(codeOf(loser)), `loser refused as already seated / unaffordable, got ${codeOf(loser)}`);
    if (start >= 2 * BUY_IN) assert.equal(codeOf(loser), "ALREADY_SEATED", "with money for both, the second seat is refused as a second seat");
    const seats = await seatsOf(admin, user);
    assert.equal(seats.length, 1, "exactly one seat row holds the user");
    assert.equal(seats[0].stack, BUY_IN);
    assert.equal(await bankroll(admin, user), start - BUY_IN, "debited exactly once");
    // The winning table's engine state agrees with its seat rows; the loser's table holds nobody.
    const winner = tables[results.indexOf(won[0])];
    const other = tables.find((id) => id !== winner);
    assert.deepEqual((await stored(winner)).players.filter(Boolean).map((p) => [p.userId, p.stack]), [[user, BUY_IN]]);
    const otherState = await stored(other);
    assert.ok(!otherState || otherState.players.every((p) => !p), "the losing table seated nobody");
    assert.equal(await totalChips(admin, [user], tables), before, "chips conserved");
  }
});

test("two users race for the same seat: one wins, the loser's bankroll is unchanged", async (t) => {
  const start = 5_000;
  const users = [await createUser(admin, `seatRace1_${tag()}`, start), await createUser(admin, `seatRace2_${tag()}`, start)];
  const tableId = await createTable(admin, `seat race ${tag()}`);
  const before = await totalChips(admin, users, [tableId]);
  const results = await raceBehindRowLock(t, adminUrl, `SELECT id FROM public."Table" WHERE id = $1 FOR UPDATE`, [tableId], 2,
    users.map((user) => () => manager.seatClaim(tableId, user, 3, BUY_IN)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "one claim wins");
  const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
  const loserIndex = 1 - winnerIndex;
  assert.equal(codeOf(results[loserIndex]), "SEAT_TAKEN");
  assert.equal(await bankroll(admin, users[winnerIndex]), start - BUY_IN, "winner debited once");
  assert.equal(await bankroll(admin, users[loserIndex]), start, "loser's bankroll unchanged");
  assert.deepEqual(await seatsOf(admin, users[loserIndex]), [], "loser holds no seat");
  const { rows } = await admin.query(`SELECT "userId", stack, status FROM public."TableSeat" WHERE "tableId" = $1 AND "seatIndex" = 3`, [tableId]);
  assert.deepEqual(rows, [{ userId: users[winnerIndex], stack: BUY_IN, status: "OCCUPIED" }]);
  assert.equal(await totalChips(admin, users, [tableId]), before, "chips conserved");
});

test("one user double-submits two seats at the same table: one seat, one debit", async (t) => {
  const start = 5_000;
  const user = await createUser(admin, `double_${tag()}`, start);
  const tableId = await createTable(admin, `double ${tag()}`);
  const results = await raceBehindRowLock(t, adminUrl, `SELECT id FROM public."Table" WHERE id = $1 FOR UPDATE`, [tableId], 2,
    [1, 2].map((seat) => () => manager.seatClaim(tableId, user, seat, BUY_IN)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(codeOf(results.find((r) => r.status === "rejected")), "ALREADY_SEATED");
  assert.equal((await seatsOf(admin, user)).length, 1);
  assert.equal(await bankroll(admin, user), start - BUY_IN);
  assert.equal(await totalChips(admin, [user], [tableId]), start, "chips conserved");
});

for (const order of ["standUp first", "Clean-up first"]) {
  test(`standUp racing the Hand Clean-up of a settled hand (${order}): the leaver is paid exactly once`, async (t) => {
    const game = await headsUp(order === "standUp first" ? "suFirst" : "cuFirst");
    assert.equal(await totalChips(admin, game.users, game.tables), game.total);
    await manager.tryStart(game.tableId);
    const settled = await playToShowdown(game.tableId);
    // The settled hand was recorded once, in the same commit.
    const { rows: hands } = await admin.query(`SELECT count(*)::int AS n FROM public."Hand" WHERE "tableId" = $1`, [game.tableId]);
    assert.equal(hands[0].n, 1);
    assert.equal(await totalChips(admin, game.users, game.tables), game.total, "a settled hand holds no chips");
    const aStack = settled.players.find((p) => p?.userId === game.a).stack;
    const aBankroll = await bankroll(admin, game.a);
    const racers = [() => manager.standUp(game.tableId, game.a), () => cleanUp(game.tableId)];
    if (order !== "standUp first") racers.reverse();
    const results = await raceInOrder(t, `SELECT id FROM public."Table" WHERE id = $1 FOR UPDATE`, [game.tableId], racers);
    for (const r of results) assert.equal(r.status, "fulfilled", r.reason?.stack);
    const standUpResult = results[order === "standUp first" ? 0 : 1].value;
    // Finish any hand the Clean-up dealt: a player dealt in leaves (and is paid) at that hand's Clean-up.
    const nextHand = await finishHands(game.tableId);
    assert.deepEqual(await seatsOf(admin, game.a), [], "the leaver holds no seat");
    const credited = (await bankroll(admin, game.a)) - aBankroll;
    const { rows: [{ n: handCount }] } = await admin.query(`SELECT count(*)::int AS n FROM public."Hand" WHERE "tableId" = $1`, [game.tableId]);
    if (order === "standUp first") {
      // Left between hands: paid the settled stack at once; the Clean-up then had nobody to deal with.
      assert.equal(standUpResult, false, "left at once, nothing pending");
      assert.equal(credited, aStack, "credited the settled stack exactly once");
      assert.equal(nextHand, null, "no further hand was dealt");
      assert.equal(handCount, 1);
    } else {
      // The Clean-up dealt the next hand first: the leave waited for its end, then paid its final stack once.
      assert.equal(standUpResult, true, "dealt in: leaves at the end of the hand");
      assert.equal(handCount, 2);
      assert.equal(credited, nextHand.players.find((p) => p?.userId === game.a).stack, "credited the next hand's final stack exactly once");
    }
    assert.equal(await totalChips(admin, game.users, game.tables), game.total, "chips conserved: the cash-out was credited exactly once");
    // The leaver's money left the table exactly once: the remaining seat holds the rest.
    const remaining = await admin.query(`SELECT COALESCE(SUM(stack), 0)::int AS n FROM public."TableSeat" WHERE "tableId" = $1`, [game.tableId]);
    assert.equal(remaining.rows[0].n + (await bankroll(admin, game.a)) + (await bankroll(admin, game.b)), game.total);
  });
}

test("a pending leaver's repeated standUp racing the Clean-up that pays them: credited exactly once", async (t) => {
  const game = await headsUp("pending");
  await manager.tryStart(game.tableId);
  // Mid-hand leave: marked pendingLeave, paid only at Hand Clean-up.
  const pending = await manager.standUp(game.tableId, game.a);
  if (pending) {
    // The leaver is folded on their turn (autoAct), so the hand settles without them acting.
    const settled = await playToShowdown(game.tableId);
    const leaver = settled.players.find((p) => p?.userId === game.a);
    assert.ok(leaver?.pendingLeave, "still seated, leaving at Clean-up");
    const aBankroll = await bankroll(admin, game.a);
    const results = await raceBehindRowLock(t, adminUrl, `SELECT id FROM public."Table" WHERE id = $1 FOR UPDATE`, [game.tableId], 3, [
      () => manager.standUp(game.tableId, game.a),
      () => cleanUp(game.tableId),
      () => manager.standUp(game.tableId, game.a),
    ]);
    for (const r of results) assert.ok(r.status === "fulfilled" || codeOf(r) === "NOT_SEATED", `unexpected ${codeOf(r)}`);
    assert.equal((await bankroll(admin, game.a)) - aBankroll, leaver.stack, "credited the final stack exactly once");
  } else {
    assert.fail("a player dealt into a running hand leaves at its end (pendingLeave)");
  }
  assert.deepEqual(await seatsOf(admin, game.a), []);
  await finishHands(game.tableId);
  assert.equal(await totalChips(admin, game.users, game.tables), game.total, "chips conserved");
});

for (const leaveFirst of [true, false]) {
  test(`the last player leaving closes the table in the same commit as their cash-out; a racing claim (${leaveFirst ? "after" : "before"} the leave) is refused and charged nothing, or keeps the table open`, async (t) => {
    const start = 5_000;
    const host = await createUser(admin, `host_${tag()}`, start);
    const newcomer = await createUser(admin, `late_${tag()}`, start);
    const tableId = await createTable(admin, `closing ${tag()}`);
    await manager.seatClaim(tableId, host, 0, BUY_IN);
    const racers = [() => manager.standUp(tableId, host), () => manager.seatClaim(tableId, newcomer, 1, BUY_IN)];
    if (!leaveFirst) racers.reverse();
    const results = await raceInOrder(t, `SELECT id FROM public."Table" WHERE id = $1 FOR UPDATE`, [tableId], racers);
    const [leave, claim] = leaveFirst ? results : [results[1], results[0]];
    assert.equal(leave.status, "fulfilled");
    const { rows: [row] } = await admin.query(`SELECT status, "closedAt" FROM public."Table" WHERE id = $1`, [tableId]);
    if (leaveFirst) {
      assert.equal(codeOf(claim), "TABLE_CLOSED");
      assert.equal(row.status, "CLOSED");
      assert.ok(row.closedAt);
      assert.equal(await bankroll(admin, newcomer), start, "the refused newcomer paid nothing");
      assert.deepEqual(await seatsOf(admin, newcomer), []);
    } else {
      assert.equal(claim.status, "fulfilled");
      assert.equal(row.status, "WAITING", "the newcomer keeps the table open");
      assert.equal(await bankroll(admin, newcomer), start - BUY_IN);
    }
    assert.equal(await bankroll(admin, host), start, "host refunded exactly once");
    assert.deepEqual(await seatsOf(admin, host), []);
    assert.equal(await totalChips(admin, [host, newcomer], [tableId]), 2 * start, "chips conserved");
  });
}
