/**
 * What the database suites do over and over: a player paying in the sandbox,
 * a withdrawal up to the moment it is approved, an administrator's passkey
 * grant, and the superuser changes no runtime login may make. Used by
 * test/payments/flows.db.test.ts and by the suites in test/payments-worker that
 * flip cluster-wide state (those run one file at a time, after the API project).
 */
import { env } from "cloudflare:workers";
import { adminPaymentsAction, stepUpBind } from "@poker/shared";
import { expect } from "vitest";
import { createPrisma } from "../../../src/db/client";
import { decideWithdrawal } from "../../../src/payments/admin";
import type { AdminCaller, Caller } from "../../../src/payments/contract";
import type { PaymentsContext } from "../../../src/payments/context";
import { createDeposit } from "../../../src/payments/deposits";
import { dispatchOne } from "../../../src/payments/dispatch";
import { WalletRefusal } from "../../../src/payments/errors";
import { applySandboxOutcome, type CardOutcome, type CryptoOutcome } from "../../../src/payments/providers/sandbox";
import { verifyCaller } from "../../../src/payments/session";
import { quoteWithdrawal, requestWithdrawal } from "../../../src/payments/withdrawals";
import { ageInstrument, deliver, makeAdmin, mintGrant, newPlayer, SANDBOX_SECRET, type Fixture, type Player } from "./fixture";

export async function refusal(work: Promise<unknown>): Promise<WalletRefusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WalletRefusal) return error;
    if (error instanceof Error && "code" in error) return error as unknown as WalletRefusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

export const sandboxOptions = (fx: Fixture) => ({ store: fx.store, webhookSecret: SANDBOX_SECRET, publicOrigin: fx.config.paymentsPublicOrigin, now: fx.now });

export async function user(fx: Fixture, caller: Caller) {
  return verifyCaller(fx.payments, caller, fx.now());
}

/** Passes a card's cooling-off without moving its createdAt out of the lockdown window. */
export const endCooling = (fx: Fixture, id: string) => ageInstrument(fx, id, 2_000);

/**
 * A card deposit paid in the sandbox; returns the deposit id once credited. A
 * new card cools off for 24 h: the suites that are not about that pass it
 * (hours past the deposit) unless told `cooling: true`.
 */
export async function cardDeposit(fx: Fixture, player: Player, amount: string, outcome: CardOutcome = "approve", opts: { cooling?: boolean; ctx?: PaymentsContext } = {}): Promise<string> {
  const ctx = opts.ctx ?? fx.ctx();
  const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CARD", amount, saveCard: true, clientRequestId: crypto.randomUUID() });
  const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
  const envelope = await applySandboxOutcome(sandboxOptions(fx), row.providerPaymentId!, outcome);
  expect(envelope).not.toBeNull();
  expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
  await fx.flush();
  if (!opts.cooling) {
    const card = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id }, select: { instrumentId: true } });
    if (card.instrumentId) {
      const row = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card.instrumentId } });
      if (row.usableAfter.getTime() > Date.now()) await endCooling(fx, row.id);
    }
  }
  return start.deposit.id;
}

/** A crypto deposit paid in the sandbox; returns the deposit id. */
export async function cryptoDeposit(fx: Fixture, player: Player, amount: string, outcome: CryptoOutcome = "confirm", ctx: PaymentsContext = fx.ctx()): Promise<string> {
  const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount, payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
  const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
  const envelope = await applySandboxOutcome(sandboxOptions(fx), row.providerPaymentId!, outcome);
  expect((await deliver(fx, ctx, "sandbox-crypto", envelope!)).status).toBe(200);
  await fx.flush();
  return start.deposit.id;
}

export async function cardOf(fx: Fixture, userId: string): Promise<string> {
  const card = await fx.payments.paymentInstrument.findFirstOrThrow({ where: { userId, kind: "CARD_TOKEN" }, orderBy: { createdAt: "desc" } });
  return card.id;
}

/** Runs dispatch units until this withdrawal's dispatch leaves `from` (other suites' rows may be due first). */
export async function dispatchUntilMoved(fx: Fixture, withdrawalId: string, from: string[], max = 12): Promise<string> {
  for (let i = 0; i < max; i += 1) {
    const row = await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId } });
    if (!from.includes(row.status)) return row.status;
    if (!(await dispatchOne(fx.ctx()))) break;
  }
  return (await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId } })).status;
}

export async function quoteAndGrant(fx: Fixture, player: Player, instrumentId: string, amount: string) {
  const quoted = await quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId, amount });
  const grant = await mintGrant(fx, player, { purpose: "withdrawal", bind: quoted.stepUp.bind });
  return { quoteId: quoted.quote.id, grant, bind: quoted.stepUp.bind };
}

/** A withdrawal requested to this destination (UNDER_REVIEW: every withdrawal is reviewed in Phase 1). */
export async function requestTo(fx: Fixture, player: Player, instrumentId: string, amount: string): Promise<string> {
  const { quoteId, grant } = await quoteAndGrant(fx, player, instrumentId, amount);
  const { view } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
  return view.id;
}

export async function newAdmin(fx: Fixture): Promise<Player> {
  const player = await newPlayer(fx, { verified: false });
  await makeAdmin(fx, player);
  return player;
}

export const asAdmin = (player: Player): AdminCaller => ({ ...player.caller, accessJwt: null });

export async function adminGrantFor(fx: Fixture, adminPlayer: Player, subject: string, decision: string): Promise<string> {
  const bind = await stepUpBind(adminPaymentsAction({ subject, decision }));
  return mintGrant(fx, adminPlayer, { purpose: "admin_payments", bind, method: "PASSKEY" });
}

/** A card withdrawal an administrator approved: its dispatch is PENDING. */
export async function approvedWithdrawal(fx: Fixture, player: Player, amount: string): Promise<{ id: string; key: string }> {
  const id = await requestTo(fx, player, await cardOf(fx, player.userId), amount);
  const reviewer = await newAdmin(fx);
  await decideWithdrawal(fx.ctx(), asAdmin(reviewer), id, { decision: "APPROVE", stepUpGrantId: await adminGrantFor(fx, reviewer, `withdrawal:${id}`, "APPROVE") });
  const dispatch = await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: id } });
  return { id, key: dispatch.providerIdempotencyKey };
}

const adminUrl = () => (env as unknown as { HYPERDRIVE_TEST_ADMIN?: Hyperdrive }).HYPERDRIVE_TEST_ADMIN?.connectionString ?? "";

/** The test database's superuser, for what no login may do. */
export async function asSuperuser<T>(work: (db: ReturnType<typeof createPrisma>) => Promise<T>): Promise<T> {
  const db = createPrisma(adminUrl());
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

/** The same, with triggers off: for moving a time the guards keep fixed. */
export function withoutTriggers(work: (tx: Parameters<Parameters<ReturnType<typeof createPrisma>["$transaction"]>[0]>[0]) => Promise<unknown>): Promise<unknown> {
  return asSuperuser((db) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    return work(tx);
  }));
}
