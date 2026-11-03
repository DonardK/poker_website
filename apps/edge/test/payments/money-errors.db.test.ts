/**
 * The ledger port and moneyTx against the real embedded PostgreSQL, through
 * the Workers' own Prisma client and @prisma/adapter-pg (docs/money/WALLET.md
 * section 8.3: the driver adapter carries SQLSTATEs in a different place
 * than node-postgres). Two logins, as in production: the runtime
 * (HYPERDRIVE, poker_app) and the payments Worker's (HYPERDRIVE_PAYMENTS,
 * poker_payments_app; a test-only binding from vitest.config.ts).
 *
 * Runs under `node apps/server/test/support/pg.mjs --exec "npm test -w @poker/edge"`.
 * Without that database the suite skips, unless POKER_REQUIRE_DB_TESTS=1 (CI), where it fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { createPrisma } from "../../src/db/client";
import { creditDeposit, ensureAccount, getAccountBalance, holdWithdrawal, post, toLedgerError } from "../../src/money/ledger";
import { ledgerKeys } from "../../src/money/keys";
import { PaymentsInvariant, PaymentsRefusal, moneyTx } from "../../src/money/tx";

const bindings = env as unknown as { HYPERDRIVE: Hyperdrive; HYPERDRIVE_PAYMENTS?: Hyperdrive; POKER_REQUIRE_DB_TESTS?: string };
const SANDBOX = "sandbox-card";

function local(hyperdrive: Hyperdrive | undefined): string | null {
  if (!hyperdrive) return null;
  try {
    const host = new URL(hyperdrive.connectionString).hostname;
    return host === "127.0.0.1" || host === "localhost" || host.endsWith(".hyperdrive.local") ? hyperdrive.connectionString : null;
  } catch {
    return null;
  }
}

let runtime: PrismaClient | null = null;
let payments: PrismaClient | null = null;
let userId = "";

async function connect(connectionString: string | null): Promise<PrismaClient | null> {
  if (!connectionString) return null;
  try {
    const client = createPrisma(connectionString);
    await client.$queryRaw`SELECT current_user::text AS role`;
    return client;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  runtime = await connect(local(bindings.HYPERDRIVE));
  payments = await connect(local(bindings.HYPERDRIVE_PAYMENTS));
  if (runtime) {
    const user = await runtime.user.create({ data: { username: `moneyerr_${crypto.randomUUID().slice(0, 8)}` }, select: { id: true } }) as { id: string };
    userId = user.id;
  }
});

afterAll(async () => {
  await runtime?.$disconnect();
  await payments?.$disconnect();
});

/** vitest.config.ts passes the host's POKER_REQUIRE_DB_TESTS through as a test-only binding. */
const required = bindings.POKER_REQUIRE_DB_TESTS === "1";

/** Skips (or, with POKER_REQUIRE_DB_TESTS=1, fails) when the database is absent. */
function databases(): { runtime: PrismaClient; payments: PrismaClient } | null {
  if (runtime && payments) return { runtime, payments };
  if (required) throw new Error("POKER_REQUIRE_DB_TESTS=1 but the runtime or payments database is unreachable");
  return null;
}

const entries = [
  { accountId: 1n, asset: "TEST_EUR", amount: -1n },
  { accountId: 2n, asset: "TEST_EUR", amount: 1n },
];
const raise = (db: PrismaClient, sqlstate: string, message: string) =>
  db.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '${sqlstate}', MESSAGE = '${message}'; END $$`);
const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the database to refuse");
};

describe("ledger refusals through @prisma/adapter-pg map to LedgerError", () => {
  it("LG022: the runtime's entry point refuses a payment type; 42501: it may not call the payments entry point", async (context) => {
    const db = databases();
    if (!db) return context.skip();
    const forbidden = await caught(() => db.runtime.$queryRaw`SELECT public.ledger_post('k'::text, 'DEPOSIT_CREDIT'::text, '{}'::jsonb, '[]'::jsonb, NULL::text)::text AS id`);
    expect(toLedgerError(forbidden)).toMatchObject({ code: "FORBIDDEN", dbCode: "LEDGER_TYPE_FORBIDDEN" });
    // post() routes a payment type to ledger_post_payments, which the runtime may not execute.
    const denied = await caught(() => post(db.runtime, { key: `k-${crypto.randomUUID()}`, type: "DEPOSIT_CREDIT", reference: {}, entries }));
    expect(denied).toMatchObject({ name: "LedgerError", code: "FORBIDDEN", dbCode: "PERMISSION_DENIED" });
    // And the payments login cannot reach the runtime's entry point.
    const mirror = await caught(() => db.payments.$queryRaw`SELECT public.ledger_post('k'::text, 'BUY_IN'::text, '{}'::jsonb, '[]'::jsonb, NULL::text)::text AS id`);
    expect(toLedgerError(mirror)).toMatchObject({ code: "FORBIDDEN", dbCode: "PERMISSION_DENIED" });
  });

  it("LG011 (a hold above the balance), 40001 and 40P01 (raised by the database) map to INSUFFICIENT_FUNDS and RETRY", async (context) => {
    const db = databases();
    if (!db) return context.skip();
    const short = await caught(() => holdWithdrawal(db.payments, { key: ledgerKeys.withdrawalHold(crypto.randomUUID()), asset: "TEST_EUR", userId, withdrawalId: crypto.randomUUID(), amount: 1n }));
    expect(short).toMatchObject({ name: "LedgerError", code: "INSUFFICIENT_FUNDS", dbCode: "LEDGER_INSUFFICIENT_FUNDS" });
    expect(toLedgerError(await caught(() => raise(db.payments, "40001", "could not serialize access")))).toMatchObject({ code: "RETRY", dbCode: "SERIALIZATION_FAILURE" });
    expect(toLedgerError(await caught(() => raise(db.payments, "40001", "LEDGER_RETRY: probe")))).toMatchObject({ code: "RETRY", dbCode: "LEDGER_RETRY" });
    expect(toLedgerError(await caught(() => raise(db.payments, "40P01", "deadlock detected")))).toMatchObject({ code: "RETRY", dbCode: "DEADLOCK_DETECTED" });
  });
});

describe("moneyTx on the payments login", () => {
  it("a deposit credit without its Deposit row is refused at SET CONSTRAINTS ALL IMMEDIATE (LG023) and rolled back", async (context) => {
    const db = databases();
    if (!db) return context.skip();
    const depositId = crypto.randomUUID();
    let posted = "";
    const error = await caught(() => moneyTx(db.payments, async (tx) => {
      posted = await creditDeposit(tx, { key: ledgerKeys.depositCredit(depositId), depositId, asset: "TEST_EUR", userId, providerKey: SANDBOX, amount: 500n, providerReference: depositId });
    }, { label: "test.unbound", backoffMs: () => 0 }));
    expect(error).toBeInstanceOf(PaymentsInvariant);
    expect(error).toMatchObject({ code: "INTERNAL", dbCode: "LEDGER_UNBOUND_PAYMENT" });
    expect(posted).not.toBe("");
    const rows = await db.payments.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM public."LedgerTransaction" WHERE "id" = ${posted}::uuid`;
    expect(rows[0]!.n).toBe(0);
  });

  it("a bound TEST_EUR credit commits, a guard refusal from a model query (PM003) is an invariant, and a serialization failure is retried", async (context) => {
    const db = databases();
    if (!db) return context.skip();
    let tries = 0;
    const credited = await moneyTx(db.payments, async (tx) => {
      tries += 1;
      if (tries === 1) await raise(tx as unknown as PrismaClient, "40001", "could not serialize access");
      const deposit = await tx.deposit.create({
        data: { userId, method: "CRYPTO", payAssetCode: "USDC_ERC20", providerKey: SANDBOX, assetCode: "TEST_EUR", requestedMinor: 2_500n, expiresAt: new Date(Date.now() + 30 * 60_000) },
        select: { id: true },
      });
      const txId = await creditDeposit(tx, { key: ledgerKeys.depositCredit(deposit.id), depositId: deposit.id, asset: "TEST_EUR", userId, providerKey: SANDBOX, amount: 2_500n, providerReference: deposit.id });
      await tx.deposit.update({ where: { id: deposit.id }, data: { status: "CONFIRMED", creditedMinor: 2_500n, confirmedAt: new Date() }, select: { id: true } });
      await tx.deposit.update({ where: { id: deposit.id }, data: { status: "CREDITED", ledgerCreditTxId: txId, creditedAt: new Date() }, select: { id: true } });
      return { depositId: deposit.id, txId };
    }, { label: "test.credit", backoffMs: () => 0 });
    expect(tries).toBe(2);
    const account = await ensureAccount(db.payments, { asset: "TEST_EUR", type: "USER_AVAILABLE", userId });
    expect(await getAccountBalance(db.payments, account)).toBe(2_500n);

    const bad = await caught(() => moneyTx(db.payments, async (tx) => {
      await tx.deposit.update({ where: { id: credited.depositId }, data: { status: "CREATED" }, select: { id: true } });
    }, { label: "test.transition", backoffMs: () => 0 }));
    expect(bad).toBeInstanceOf(PaymentsInvariant);
    expect(bad).toMatchObject({ dbCode: "PAYMENT_BAD_TRANSITION" });

    // A hold above the new balance is a domain refusal, and nothing of the transaction remains.
    const withdrawalId = crypto.randomUUID();
    const refused = await caught(() => moneyTx(db.payments, (tx) => holdWithdrawal(tx, { key: ledgerKeys.withdrawalHold(withdrawalId), asset: "TEST_EUR", userId, withdrawalId, amount: 2_501n }),
      { label: "test.hold", backoffMs: () => 0 }));
    expect(refused).toBeInstanceOf(PaymentsRefusal);
    expect(refused).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await getAccountBalance(db.payments, account)).toBe(2_500n);
  });
});
