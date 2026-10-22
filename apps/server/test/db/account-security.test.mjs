/**
 * Account security schema (migration 20261019100000_account_security) on the
 * disposable cluster (test/support/pg.mjs; never `.env`).
 *
 * A private database gets every earlier migration, then users and sessions
 * (live and revoked, human and guest), then this migration, exactly as a live
 * database would. Proves:
 * - the migration applies to existing data: only guest sessions that were
 *   not already ended are revoked (GUEST_RETIRED), and the new columns take
 *   their defaults;
 * - StepUpGrant: a money grant needs a second factor or the email code (never
 *   PASSWORD alone), admin payments need a passkey, the lifetime is at most 5
 *   minutes, and a consumer holding only SELECT + UPDATE ("consumedAt") (what
 *   the wallet migration grants poker_payments) consumes a grant exactly once,
 *   never after expiry, and can change nothing else;
 * - StepUpEmailChallenge: 5 attempts, 10 minutes, money purposes only;
 * - AccountSecurityEvent is append-only for every role and keeps its user;
 * - the CHECKs on secrets, hashes and auth methods, and the foreign-key
 *   cascades (forgetting a device keeps its sessions; ending a session's row
 *   removes its grants and challenges).
 *
 * Run: npm run test:db -w @poker/server
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationNames, migrationsDir, withDatabase } from "../support/pg.mjs";
import { requireTestDatabase, tag } from "./support.mjs";

const { adminUrl, runtimeUrl } = requireTestDatabase();
const MIGRATION = "20261019100000_account_security";
const database = `poker_acctsec_${tag()}`;
const probeRole = `stepup_consumer_${tag()}`;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const MINUTE = 60_000;

let admin;
let runtime;
const fixture = {};

const sql = (name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");

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

/** Runs `fn` in a transaction that is always rolled back. */
async function rolledBack(client, fn) {
  await client.query("BEGIN");
  try { return await fn(); } finally { await client.query("ROLLBACK"); }
}

async function insertUser(name, { isGuest = false } = {}) {
  const id = `u_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."User" (id, username, "isGuest", "updatedAt") VALUES ($1, $2, $3, now())`, [id, name, isGuest]);
  return id;
}

async function insertSession(userId, { expiresInMs = 3_600_000, revokeReason = null } = {}) {
  const id = `sess_${tag()}${tag()}`;
  await admin.query(`INSERT INTO public."Session" (id, "userId", "refreshToken", "expiresAt", "revokedAt", "revokeReason")
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [id, userId, `rt_${tag()}${tag()}`, new Date(Date.now() + expiresInMs), revokeReason ? new Date(Date.now() - MINUTE) : null, revokeReason]);
  return id;
}

/** A grant row; createdAt and expiresAt come from one clock reading, as the API writes them. */
function grant(overrides = {}) {
  const createdAt = overrides.createdAt ?? new Date();
  return {
    id: `g_${tag()}${tag()}`,
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    purpose: "withdrawal",
    bindHash: HASH,
    method: "TOTP",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 5 * MINUTE),
    ...overrides,
  };
}

async function insertGrant(client, row) {
  await client.query(`INSERT INTO public."StepUpGrant" (id, "userId", "sessionId", purpose, "bindHash", method, "createdAt", "expiresAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [row.id, row.userId, row.sessionId, row.purpose, row.bindHash, row.method, row.createdAt, row.expiresAt]);
  return row.id;
}

/** The consume statement of design-wallet §10.5, run as the probe role that holds exactly the wallet's planned grants. */
async function consume(row) {
  await admin.query("BEGIN");
  try {
    await admin.query(`SET LOCAL ROLE ${probeRole}`);
    const result = await admin.query(`UPDATE public."StepUpGrant" SET "consumedAt" = CURRENT_TIMESTAMP
      WHERE id = $1 AND "userId" = $2 AND "sessionId" = $3 AND purpose = $4 AND "bindHash" = $5
        AND "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
        AND method = ANY ('{PASSKEY,TOTP,PASSWORD_EMAIL}')
      RETURNING method`, [row.id, row.userId, row.sessionId, row.purpose, row.bindHash]);
    await admin.query("COMMIT");
    return result.rows;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function asProbe(statement, params = []) {
  await admin.query("BEGIN");
  try {
    await admin.query(`SET LOCAL ROLE ${probeRole}`);
    return await admin.query(statement, params);
  } finally { await admin.query("ROLLBACK"); }
}

before(async () => {
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE ${database}`); } finally { await maintenance.end(); }
  admin = new pg.Client({ connectionString: withDatabase(adminUrl, database) });
  await admin.connect();

  const names = migrationNames();
  const index = names.indexOf(MIGRATION);
  assert.ok(index > 0, `${MIGRATION} is in prisma/migrations`);
  for (const name of names.slice(0, index)) await admin.query(sql(name));

  // Existing data, as on the live database before this migration.
  fixture.humanId = await insertUser(`human_${tag()}`);
  fixture.humanLive = await insertSession(fixture.humanId);
  fixture.humanLoggedOut = await insertSession(fixture.humanId, { revokeReason: "LOGOUT" });
  fixture.guestId = await insertUser(`guest_${tag()}`, { isGuest: true });
  fixture.guestLive = await insertSession(fixture.guestId);
  fixture.guestExpired = await insertSession(fixture.guestId, { expiresInMs: -MINUTE });
  fixture.guestLoggedOut = await insertSession(fixture.guestId, { revokeReason: "LOGOUT" });
  const { rows: [before] } = await admin.query(`SELECT "revokedAt" FROM public."Session" WHERE id = $1`, [fixture.guestLoggedOut]);
  fixture.guestLoggedOutAt = before.revokedAt;

  for (const name of names.slice(index)) await admin.query(sql(name));

  fixture.userId = fixture.humanId;
  fixture.sessionId = fixture.humanLive;
  runtime = new pg.Client({ connectionString: withDatabase(runtimeUrl, database) });
  await runtime.connect();

  // Exactly what the wallet migration plans for poker_payments on StepUpGrant.
  await admin.query(`CREATE ROLE ${probeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${probeRole}`);
  await admin.query(`GRANT SELECT ON TABLE public."StepUpGrant" TO ${probeRole}`);
  await admin.query(`GRANT UPDATE ("consumedAt") ON TABLE public."StepUpGrant" TO ${probeRole}`);
  await admin.query(`CREATE POLICY payments_consume ON public."StepUpGrant" TO ${probeRole} USING (true) WITH CHECK (true)`);
});

after(async () => {
  await runtime?.end();
  await admin?.end();
  const maintenance = new pg.Client({ connectionString: withDatabase(adminUrl, "postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${probeRole}`);
  } finally { await maintenance.end(); }
});

test("applies to existing data: only guest sessions that had not ended are revoked, and new columns take their defaults", async () => {
  const { rows } = await admin.query(`SELECT id, "revokedAt", "revokeReason", persistent, "authMethods", "reauthMethods", "reauthAt", "deviceId"
    FROM public."Session" WHERE "userId" = ANY($1)`, [[fixture.humanId, fixture.guestId]]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(fixture.humanLive).revokedAt, null, "a human's live session is untouched");
  assert.equal(byId.get(fixture.humanLoggedOut).revokeReason, "LOGOUT");
  assert.equal(byId.get(fixture.guestLive).revokeReason, "GUEST_RETIRED");
  assert.ok(byId.get(fixture.guestLive).revokedAt instanceof Date);
  assert.equal(byId.get(fixture.guestExpired).revokeReason, "GUEST_RETIRED", "an expired guest session can never be revived either");
  assert.equal(byId.get(fixture.guestLoggedOut).revokeReason, "LOGOUT", "an already ended session keeps its reason");
  assert.deepEqual(byId.get(fixture.guestLoggedOut).revokedAt, fixture.guestLoggedOutAt);
  for (const row of rows) {
    assert.deepEqual([row.persistent, row.authMethods, row.reauthMethods, row.reauthAt, row.deviceId], [true, [], [], null, null], row.id);
  }

  const { rows: users } = await admin.query(`SELECT "emailVerifiedAt", "credentialsVersion", "passwordChangedAt", "passwordResetRequired",
      "mfaFailedCount", "mfaLockedUntil", "securityHoldUntil", "webauthnUserId"
    FROM public."User" WHERE id = ANY($1)`, [[fixture.humanId, fixture.guestId]]);
  for (const user of users) {
    assert.deepEqual(user, {
      emailVerifiedAt: null, credentialsVersion: 0, passwordChangedAt: null, passwordResetRequired: false,
      mfaFailedCount: 0, mfaLockedUntil: null, securityHoldUntil: null, webauthnUserId: null,
    });
  }
  await admin.query("SELECT public.poker_assert_rls()");
});

test("StepUpGrant: money needs a second factor or the email code, admin payments a passkey, for at most 5 minutes", async () => {
  await rolledBack(admin, async () => {
    for (const ok of [
      grant(),
      grant({ purpose: "payout_destination", method: "PASSWORD_EMAIL" }),
      grant({ purpose: "withdrawal", method: "PASSKEY" }),
      grant({ purpose: "admin_payments", method: "PASSKEY" }),
    ]) await insertGrant(admin, ok);
  });
  const refused = [
    grant({ method: "PASSWORD" }),
    grant({ purpose: "payout_destination", method: "PASSWORD" }),
    grant({ purpose: "admin_payments", method: "PASSWORD" }),
    grant({ purpose: "admin_payments", method: "TOTP" }),
    grant({ purpose: "admin_payments", method: "PASSWORD_EMAIL" }),
    grant({ purpose: "deposit" }),
    grant({ method: "SMS" }),
    grant({ bindHash: "A".repeat(64) }),
    grant({ bindHash: "a".repeat(63) }),
    (() => { const createdAt = new Date(); return grant({ createdAt, expiresAt: new Date(createdAt.getTime() + 5 * MINUTE + 1) }); })(),
    (() => { const createdAt = new Date(); return grant({ createdAt, expiresAt: createdAt }); })(),
  ];
  for (const row of refused) {
    await expectCode(() => rolledBack(admin, () => insertGrant(admin, row)), "23514");
  }
});

test("StepUpGrant: the runtime role mints and reads grants under RLS but cannot consume one", async () => {
  const row = grant();
  await rolledBack(runtime, async () => {
    await insertGrant(runtime, row);
    const { rows } = await runtime.query(`SELECT method, "consumedAt" FROM public."StepUpGrant" WHERE id = $1`, [row.id]);
    assert.deepEqual(rows, [{ method: "TOTP", consumedAt: null }]);
    await runtime.query("SAVEPOINT consume");
    await expectCode(() => runtime.query(`UPDATE public."StepUpGrant" SET "consumedAt" = now() WHERE id = $1`, [row.id]), "42501");
    await runtime.query("ROLLBACK TO SAVEPOINT consume");
    await expectCode(() => runtime.query(`DELETE FROM public."StepUpGrant" WHERE id = $1`, [row.id]), "42501");
  });
});

test("StepUpGrant: the consumer uses a grant exactly once, never after expiry, and can change nothing else", async () => {
  const row = grant();
  await insertGrant(admin, row);
  assert.deepEqual(await consume({ ...row, bindHash: OTHER_HASH }), [], "another action's bindHash matches nothing");
  assert.deepEqual(await consume({ ...row, sessionId: fixture.humanLoggedOut }), [], "another session matches nothing");
  assert.deepEqual(await consume(row), [{ method: "TOTP" }]);
  assert.deepEqual(await consume(row), [], "a used grant matches nothing");
  await expectCode(() => asProbe(`UPDATE public."StepUpGrant" SET "consumedAt" = NULL WHERE id = $1`, [row.id]), "SU001", /STEP_UP_GRANT_SINGLE_USE/);
  await expectCode(() => asProbe(`UPDATE public."StepUpGrant" SET "consumedAt" = now() WHERE id = $1`, [row.id]), "SU001");
  await expectCode(() => asProbe(`UPDATE public."StepUpGrant" SET "bindHash" = $2 WHERE id = $1`, [row.id, OTHER_HASH]), "42501");
  await expectCode(() => asProbe(`DELETE FROM public."StepUpGrant" WHERE id = $1`, [row.id]), "42501");

  // Even a role with every privilege (the administrator) cannot rewrite one without break_glass.
  const fresh = grant();
  await insertGrant(admin, fresh);
  await expectCode(() => admin.query(`UPDATE public."StepUpGrant" SET "bindHash" = $2 WHERE id = $1`, [fresh.id, OTHER_HASH]), "SU001");
  await expectCode(() => admin.query(`UPDATE public."StepUpGrant" SET "consumedAt" = now(), method = 'PASSKEY' WHERE id = $1`, [fresh.id]), "SU001");
  await rolledBack(admin, async () => {
    await admin.query("SELECT set_config('poker.break_glass', 'on', true)");
    const fixed = await admin.query(`UPDATE public."StepUpGrant" SET "bindHash" = $2 WHERE id = $1`, [fresh.id, OTHER_HASH]);
    assert.equal(fixed.rowCount, 1, "poker.break_glass is the maintenance hatch");
  });

  // An expired grant cannot be consumed, by the statement or by hand.
  const createdAt = new Date(Date.now() - 10 * MINUTE);
  const expired = grant({ createdAt, expiresAt: new Date(createdAt.getTime() + 5 * MINUTE) });
  await insertGrant(admin, expired);
  assert.deepEqual(await consume(expired), []);
  await expectCode(() => admin.query(`UPDATE public."StepUpGrant" SET "consumedAt" = now() WHERE id = $1`, [expired.id]), "SU001");
});

test("StepUpEmailChallenge: money purposes only, 5 attempts, at most 10 minutes; the runtime role cannot rewrite the code", async () => {
  const challenge = (overrides = {}) => {
    const createdAt = overrides.createdAt ?? new Date();
    return { id: `c_${tag()}${tag()}`, purpose: "withdrawal", codeHash: HASH, email: "player@example.com", attempts: 0,
      createdAt, expiresAt: new Date(createdAt.getTime() + 10 * MINUTE), ...overrides };
  };
  const insert = (client, row) => client.query(`INSERT INTO public."StepUpEmailChallenge"
      (id, "userId", "sessionId", purpose, "bindHash", "codeHash", email, attempts, "createdAt", "expiresAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [row.id, fixture.userId, fixture.sessionId, row.purpose, HASH, row.codeHash, row.email, row.attempts, row.createdAt, row.expiresAt]);

  for (const row of [
    challenge({ purpose: "admin_payments" }),
    challenge({ attempts: 6 }),
    challenge({ attempts: -1 }),
    challenge({ codeHash: "123456" }),
    challenge({ email: "x" }),
    (() => { const createdAt = new Date(); return challenge({ createdAt, expiresAt: new Date(createdAt.getTime() + 10 * MINUTE + 1) }); })(),
  ]) await expectCode(() => rolledBack(admin, () => insert(admin, row)), "23514");

  const row = challenge({ purpose: "payout_destination" });
  await rolledBack(runtime, async () => {
    await insert(runtime, row);
    const bumped = await runtime.query(`UPDATE public."StepUpEmailChallenge" SET attempts = attempts + 5 WHERE id = $1 AND attempts < 5`, [row.id]);
    assert.equal(bumped.rowCount, 1);
    await runtime.query("SAVEPOINT more");
    await expectCode(() => runtime.query(`UPDATE public."StepUpEmailChallenge" SET attempts = attempts + 1 WHERE id = $1`, [row.id]), "23514");
    await runtime.query("ROLLBACK TO SAVEPOINT more");
    const used = await runtime.query(`UPDATE public."StepUpEmailChallenge" SET "consumedAt" = now() WHERE id = $1 AND "consumedAt" IS NULL`, [row.id]);
    assert.equal(used.rowCount, 1);
    await expectCode(() => runtime.query(`UPDATE public."StepUpEmailChallenge" SET "codeHash" = $2 WHERE id = $1`, [row.id, OTHER_HASH]), "42501");
  });
});

test("AccountSecurityEvent is append-only for every role and keeps its user", async () => {
  const id = `ev_${tag()}${tag()}`;
  await runtime.query(`INSERT INTO public."AccountSecurityEvent" (id, "userId", type, "sessionId", ip, country, data)
    VALUES ($1, $2, 'PASSWORD_CHANGED', $3, '203.0.113.0/24', 'MT', '{"via":"settings"}')`, [id, fixture.userId, fixture.sessionId]);
  await expectCode(() => admin.query(`UPDATE public."AccountSecurityEvent" SET type = 'SIGN_IN' WHERE id = $1`, [id]), "AP001", /APPEND_ONLY/);
  await expectCode(() => admin.query(`DELETE FROM public."AccountSecurityEvent" WHERE id = $1`, [id]), "AP001");
  await expectCode(() => runtime.query(`UPDATE public."AccountSecurityEvent" SET type = 'SIGN_IN' WHERE id = $1`, [id]), "42501");
  for (const [type, data, country] of [["password_changed", "{}", null], ["X", "{}", null], ["SIGN_IN", "[]", null], ["SIGN_IN", "{}", "mt"]]) {
    await expectCode(() => rolledBack(admin, () => admin.query(`INSERT INTO public."AccountSecurityEvent" (id, "userId", type, data, country)
      VALUES ($1, $2, $3, $4, $5)`, [`ev_${tag()}`, fixture.userId, type, data, country])), "23514");
  }
  // A user with security history cannot be deleted (RESTRICT is 23001 today, 23503 on older servers).
  await expectCode(() => rolledBack(admin, () => admin.query(`DELETE FROM public."User" WHERE id = $1`, [fixture.userId])), ["23001", "23503"]);
});

test("CHECKs on auth methods, user handles, TOTP ciphertext, passkeys and devices", async () => {
  const userId = await insertUser(`checks_${tag()}`);
  const sessionId = await insertSession(userId);
  const refused = [
    [`UPDATE public."Session" SET "authMethods" = '{pwd,sms}' WHERE id = $1`, [sessionId]],
    [`UPDATE public."Session" SET "reauthMethods" = '{password}' WHERE id = $1`, [sessionId]],
    [`UPDATE public."User" SET "webauthnUserId" = 'short' WHERE id = $1`, [userId]],
    [`UPDATE public."User" SET "credentialsVersion" = -1 WHERE id = $1`, [userId]],
    [`INSERT INTO public."UserTotp" ("userId", "secretCiphertext") VALUES ($1, 'JBSWY3DPEHPK3PXP')`, [userId]],
    [`INSERT INTO public."UserTotp" ("userId", "secretCiphertext", "disabledAt") VALUES ($1, 'v2.a1.x', now())`, [userId]],
    [`INSERT INTO public."UserBackupCode" (id, "userId", "codeHash") VALUES ('bc1', $1, 'ABCDE-12345')`, [userId]],
    [`INSERT INTO public."WebAuthnCredential" (id, "userId", "credentialId", "publicKey", counter, "deviceType", "rpId", name)
      VALUES ('wa1', $1, 'Y3JlZGVudGlhbC1pZC0x', 'cHVibGljLWtleS1ieXRlcw', 4294967296, 'singleDevice', 'localhost', 'Laptop')`, [userId]],
    [`INSERT INTO public."WebAuthnCredential" (id, "userId", "credentialId", "publicKey", "deviceType", "rpId", name)
      VALUES ('wa2', $1, 'Y3JlZGVudGlhbC1pZC0x', 'cHVibGljLWtleS1ieXRlcw', 'platform', 'localhost', 'Laptop')`, [userId]],
    [`INSERT INTO public."KnownDevice" (id, "userId", "deviceHash") VALUES ('kd1', $1, 'not-a-hash')`, [userId]],
    [`INSERT INTO public."EmailToken" (id, "userId", purpose, "tokenHash", email, "credentialsVersion", "expiresAt")
      VALUES ('et1', $1, 'PASSWORD_RESET', $2, 'a@b.c', 0, now() - interval '1 minute')`, [userId, HASH]],
    [`INSERT INTO public."AuthNonce" (id, purpose, "expiresAt") VALUES ('short', 'mfa:login', now())`, []],
  ];
  for (const [statement, params] of refused) {
    await expectCode(() => rolledBack(admin, () => admin.query(statement, params)), "23514", undefined);
  }
  await rolledBack(admin, async () => {
    await admin.query(`UPDATE public."Session" SET "authMethods" = '{pwd,otp}', "reauthMethods" = '{passkey}', "reauthAt" = now() WHERE id = $1`, [sessionId]);
    await admin.query(`UPDATE public."User" SET "webauthnUserId" = $2 WHERE id = $1`, [userId, "A".repeat(43)]);
    await admin.query(`INSERT INTO public."WebAuthnCredential" (id, "userId", "credentialId", "publicKey", counter, transports, "deviceType", "backedUp", aaguid, "rpId", name)
      VALUES ('wa3', $1, 'Y3JlZGVudGlhbC1pZC0x', 'cHVibGljLWtleS1ieXRlcw', 4294967295, '{internal,hybrid}', 'multiDevice', true,
        'adce0002-35bc-c60a-648b-0b25f1f05503', 'localhost', 'Laptop')`, [userId]);
  });
});

test("forgetting a device keeps its sessions (deviceId set null); removing a session row removes its grants and challenges", async () => {
  const userId = await insertUser(`cascade_${tag()}`);
  const sessionId = await insertSession(userId);
  await runtime.query(`INSERT INTO public."KnownDevice" (id, "userId", "deviceHash", label, country) VALUES ($1, $2, $3, 'Firefox on Linux', 'MT')`,
    [`kd_${tag()}`, userId, HASH]);
  const { rows: [device] } = await runtime.query(`SELECT id FROM public."KnownDevice" WHERE "userId" = $1`, [userId]);
  await runtime.query(`UPDATE public."Session" SET "deviceId" = $2 WHERE id = $1`, [sessionId, device.id]);
  const removed = await runtime.query(`DELETE FROM public."KnownDevice" WHERE id = $1`, [device.id]);
  assert.equal(removed.rowCount, 1);
  const { rows: [session] } = await admin.query(`SELECT "deviceId", "revokedAt" FROM public."Session" WHERE id = $1`, [sessionId]);
  assert.deepEqual(session, { deviceId: null, revokedAt: null });

  const owned = grant({ userId, sessionId });
  await insertGrant(runtime, owned);
  const createdAt = new Date();
  await runtime.query(`INSERT INTO public."StepUpEmailChallenge" (id, "userId", "sessionId", purpose, "bindHash", "codeHash", email, "createdAt", "expiresAt")
    VALUES ($1, $2, $3, 'withdrawal', $4, $4, 'p@example.com', $5, $6)`,
  [`c_${tag()}`, userId, sessionId, HASH, createdAt, new Date(createdAt.getTime() + 10 * MINUTE)]);
  await admin.query(`DELETE FROM public."Session" WHERE id = $1`, [sessionId]);
  const { rows: [left] } = await admin.query(`SELECT
      (SELECT count(*)::int FROM public."StepUpGrant" WHERE "sessionId" = $1) AS grants,
      (SELECT count(*)::int FROM public."StepUpEmailChallenge" WHERE "sessionId" = $1) AS challenges`, [sessionId]);
  assert.deepEqual(left, { grants: 0, challenges: 0 });
});
