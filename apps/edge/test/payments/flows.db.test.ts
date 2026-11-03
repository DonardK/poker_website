/**
 * The payments flows end to end on the real database (docs/money/WALLET.md
 * sections 10 and 14.3), with the built-in sandbox provider: a deposit is
 * credited exactly once however its webhooks arrive, a balance cannot be
 * withdrawn twice, a step-up grant authorises exactly one action, TEST_EUR
 * and real providers never mix, and "This wasn't me" freezes the money.
 * Every suite ends with Σ balance = 0 per asset.
 */
import { adminPaymentsAction, payoutDestinationAction, stepUpBind } from "@poker/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "../../src/http/db";
import { requestReactivation, selfExclusionStatus } from "../../src/http/wallet";
import { moneyTx } from "../../src/money/tx";
import { acceptReactivation, decideWithdrawal, listReactivations, resolveDeposit, resolveUncertain, restoreInstrument, setRestriction, setScreening, verifyAdmin } from "../../src/payments/admin";
import type { PaymentsContext } from "../../src/payments/context";
import { applyProviderPayment, createDeposit } from "../../src/payments/deposits";
import { dispatchOne } from "../../src/payments/dispatch";
import { NOT_ME_TTL_MS, signNotMe } from "../../src/payments/emails";
import { processEvent } from "../../src/payments/inbox";
import { activeSelfExclusion } from "../../src/payments/limits";
import { addCryptoDestination, prepareCryptoDestination, revokeInstrument } from "../../src/payments/instruments";
import { startKyc } from "../../src/payments/kyc";
import { drainOutbox } from "../../src/payments/notify";
import { applySandboxKyc, applySandboxOutcome, type CryptoOutcome } from "../../src/payments/providers/sandbox";
import type { ProviderPayment } from "../../src/payments/providers/types";
import { applyPendingLockdowns, securityLockdown, verifyNotMeToken } from "../../src/payments/security";
import { ProviderUnavailable } from "../../src/payments/errors";
import { quoteWithdrawal, requestWithdrawal } from "../../src/payments/withdrawals";
import { ageInstrument, assetSums, balances, deliver, makeAdmin, mintGrant, newPlayer, openFixture, SANDBOX_SECRET, type Fixture, type Player } from "./support/fixture";
import {
  adminGrantFor, approvedWithdrawal, asAdmin, cardDeposit, cardOf, cryptoDeposit, dispatchUntilMoved, endCooling, newAdmin, quoteAndGrant, refusal, requestTo, sandboxOptions, user, withoutTriggers,
} from "./support/flows";

let f: Fixture | null = null;

beforeAll(async () => {
  f = await openFixture();
});

afterAll(async () => {
  if (f) {
    expect((await assetSums(f)).TEST_EUR ?? "0").toBe("0");
    await f.close();
  }
});

/** A test that needs the database: skips without it (openFixture already failed the suite in CI). */
function dbTest(name: string, run: (fx: Fixture) => Promise<void>): void {
  it(name, async (context) => {
    if (!f) return context.skip();
    await run(f);
  }, 60_000);
}

describe("deposits: exactly-once credit", () => {
  dbTest("credits a sandbox card deposit once, creates the card and queues the email", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "50.00");
    const deposit = await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.status).toBe("CREDITED");
    expect(deposit.creditedMinor).toBe(5000n);
    expect(deposit.assetCode).toBe("TEST_EUR");
    expect((await balances(fx, player.userId)).available).toBe(5000n);
    const card = await fx.payments.paymentInstrument.findFirstOrThrow({ where: { userId: player.userId, kind: "CARD_TOKEN" } });
    expect(card.payoutEnabled).toBe(true);
    const compliance = await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } });
    expect(compliance.lifetimeDepositedMinor).toBe(5000n);
    const mail = await fx.payments.emailOutbox.findFirst({ where: { userId: player.userId, template: "deposit-credited" } });
    expect(mail).not.toBeNull();
  });

  dbTest("concurrent replays of the same webhook and distinct events for one payment credit once", async (fx) => {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CARD", amount: "30.00", clientRequestId: crypto.randomUUID() });
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } })).providerPaymentId!;
    const first = await applySandboxOutcome(sandboxOptions(fx), paymentId, "approve");
    const replays = Array.from({ length: 8 }, () => deliver(fx, ctx, "sandbox-card", first!));
    // Distinct event ids for the same success (a provider that re-sends with a new id).
    const distinct = Array.from({ length: 4 }, (_, i) => deliver(fx, ctx, "sandbox-card", { ...first!, eventId: `${first!.eventId}_r${i}` }));
    const statuses = (await Promise.all([...replays, ...distinct])).map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    await fx.flush();
    const events = await fx.payments.paymentEvent.findMany({ where: { provider: "sandbox-card", objectRef: paymentId } });
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.processedAt !== null)).toBe(true);
    expect(events.filter((e) => e.outcome === "APPLIED")).toHaveLength(1);
    const credits = await fx.payments.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public."LedgerTransaction" WHERE "type" = 'DEPOSIT_CREDIT' AND "reference"->>'depositId' = ${start.deposit.id}`;
    expect(credits[0]!.n).toBe(1);
    expect((await balances(fx, player.userId)).available).toBe(3000n);
  });

  dbTest("an out-of-order PENDING after SUCCEEDED changes nothing, a forged signature stores nothing", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "20.00");
    const ctx = fx.ctx();
    const before = await fx.payments.paymentEvent.count();
    const forged = await deliver(fx, ctx, "sandbox-card", { eventId: "evt_forged_1", type: "payment.succeeded", createdAt: new Date().toISOString(), data: { objectType: "PAYMENT", id: "sbx_pay_000000000000000000000000" } }, { secret: "wrong-secret-wrong-secret-wrong-secret" });
    expect(forged.status).toBe(401);
    const stale = await deliver(fx, ctx, "sandbox-card", { eventId: "evt_stale_1", type: "payment.succeeded", createdAt: new Date().toISOString(), data: { objectType: "PAYMENT", id: "x" } }, { at: new Date(Date.now() - 600_000) });
    expect(stale.status).toBe(401);
    expect(await fx.payments.paymentEvent.count()).toBe(before);
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("CREDITED");
  });

  dbTest("a prepaid card is credited and the whole amount is held for refund", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "25.00", "approve_prepaid");
    const deposit = await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.status).toBe("CREDITED");
    expect(deposit.excessMinor).toBe(2500n);
    expect(await balances(fx, player.userId)).toEqual({ available: 0n, held: 2500n });
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    expect(refund.sourceDepositId).toBe(depositId);
  });

  dbTest("a chargeback reverses the credit and freezes the account", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "40.00");
    const ctx = fx.ctx();
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).providerPaymentId!;
    const envelope = await applySandboxOutcome(sandboxOptions(fx), paymentId, "chargeback");
    expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
    expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
    await fx.flush();
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("REVERSED");
    expect((await balances(fx, player.userId)).available).toBe(0n);
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).restriction).toBe("FROZEN");
    expect(await fx.payments.depositReversal.count({ where: { depositId } })).toBe(1);
  });

  dbTest("crypto underpayment waits for review and is never credited automatically", async (fx) => {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount: "60.00", payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
    expect(start.next?.type).toBe("CRYPTO_INVOICE");
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } })).providerPaymentId!;
    const envelope = await applySandboxOutcome(sandboxOptions(fx), paymentId, "underpay" satisfies CryptoOutcome);
    expect((await deliver(fx, ctx, "sandbox-crypto", envelope!)).status).toBe(200);
    await fx.flush();
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } })).status).toBe("NEEDS_REVIEW");
    expect((await balances(fx, player.userId)).available).toBe(0n);
  });
});

describe("TEST_EUR isolation (database)", () => {
  dbTest("a real provider cannot book TEST_EUR, and the sandbox cannot book EUR", async (fx) => {
    const player = await newPlayer(fx);
    const base = { userId: player.userId, method: "CARD" as const, requestedMinor: 1000n, expiresAt: new Date(Date.now() + 600_000) };
    await expect(fx.payments.deposit.create({ data: { ...base, clientRequestId: crypto.randomUUID(), requestHash: "a".repeat(64), providerKey: "nuvei", assetCode: "TEST_EUR" } }))
      .rejects.toThrow(/PAYMENT_MISMATCH|PM006/);
    await expect(fx.payments.deposit.create({ data: { ...base, clientRequestId: crypto.randomUUID(), requestHash: "b".repeat(64), providerKey: "sandbox-card", assetCode: "EUR" } }))
      .rejects.toThrow(/PAYMENT_MISMATCH|PM006/);
  });
});

describe("withdrawals: no double spend, grants are single-use and bound", () => {
  dbTest("three concurrent €40 requests on €100: two are held, the third is INSUFFICIENT_FUNDS with no row", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "100.00");
    // To an address: a card would stop the third at its closed-loop limit, before the ledger is asked.
    const u = await user(fx, player.caller);
    const address = "0x52908400098527886e0f7030069857d2e4169ee7";
    const ready = await prepareCryptoDestination(fx.ctx(), u, "MT", { asset: "USDC_ERC20", address });
    const { view: destination } = await addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address, stepUpGrantId: await mintGrant(fx, player, { purpose: "payout_destination", bind: ready.bind }), clientRequestId: crypto.randomUUID(),
    });
    await endCooling(fx, destination.id);
    const prepared = await Promise.all([1, 2, 3].map(() => quoteAndGrant(fx, player, destination.id, "40.00")));
    const results = await Promise.allSettled(prepared.map((p) => requestWithdrawal(fx.ctx(), player.caller, u, { quoteId: p.quoteId, stepUpGrantId: p.grant, clientRequestId: crypto.randomUUID() })));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect((failed[0]!.reason as { code: string }).code).toBe("INSUFFICIENT_FUNDS");
    expect(await balances(fx, player.userId)).toEqual({ available: 2000n, held: 8000n });
    expect(await fx.payments.withdrawal.count({ where: { userId: player.userId, kind: "PLAYER" } })).toBe(2);
  });

  dbTest("one quote and one grant replayed concurrently under new keys: exactly one withdrawal", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "100.00");
    const card = await cardOf(fx, player.userId);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "30.00");
    const u = await user(fx, player.caller);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => requestWithdrawal(fx.ctx(), player.caller, u, { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(["QUOTE_EXPIRED", "STEP_UP_REQUIRED"]).toContain((r.reason as { code: string }).code);
    expect(await balances(fx, player.userId)).toEqual({ available: 7000n, held: 3000n });
  });

  dbTest("a grant for another action, another session, an expired or a used grant is STEP_UP_REQUIRED", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "100.00");
    const card = await cardOf(fx, player.userId);
    const u = await user(fx, player.caller);
    const request = (quoteId: string, grant: string | undefined) => requestWithdrawal(fx.ctx(), player.caller, u, { quoteId, stepUpGrantId: grant as string, clientRequestId: crypto.randomUUID() });

    const a = await quoteAndGrant(fx, player, card, "25.00");
    const b = await quoteAndGrant(fx, player, card, "26.00");
    // b's grant is bound to b's quote: it cannot authorise a.
    const mismatch = await refusal(request(a.quoteId, b.grant));
    expect(mismatch.code).toBe("STEP_UP_REQUIRED");
    expect(mismatch.stepUp?.bind).toBe(a.bind);
    expect((await refusal(request(a.quoteId, undefined))).code).toBe("STEP_UP_REQUIRED");

    const other = await fx.runtime.session.create({ data: { userId: player.userId, refreshToken: `rt_${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } }) as { id: string };
    const foreign = await mintGrant(fx, player, { purpose: "withdrawal", bind: a.bind, sessionId: other.id });
    expect((await refusal(request(a.quoteId, foreign))).code).toBe("STEP_UP_REQUIRED");

    const expired = await mintGrant(fx, player, { purpose: "withdrawal", bind: a.bind, ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await refusal(request(a.quoteId, expired))).code).toBe("STEP_UP_REQUIRED");

    const wrongPurpose = await mintGrant(fx, player, { purpose: "payout_destination", bind: a.bind });
    expect((await refusal(request(a.quoteId, wrongPurpose))).code).toBe("STEP_UP_REQUIRED");

    // Nothing above consumed anything: a's own grant still works once.
    expect((await request(a.quoteId, a.grant)).view.status).toBe("UNDER_REVIEW");
    const c = await quoteAndGrant(fx, player, card, "27.00");
    expect((await refusal(request(c.quoteId, a.grant))).code).toBe("STEP_UP_REQUIRED");
    expect(await fx.payments.withdrawal.count({ where: { userId: player.userId } })).toBe(1);
  });

  dbTest("a security hold refuses the request before any money moves", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "50.00");
    const card = await cardOf(fx, player.userId);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "20.00");
    await fx.runtime.user.update({ where: { id: player.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });
    const u = await user(fx, player.caller);
    const error = await refusal(requestWithdrawal(fx.ctx(), player.caller, u, { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() }));
    expect(error.code).toBe("SECURITY_HOLD");
    expect(await balances(fx, player.userId)).toEqual({ available: 5000n, held: 0n });
  });
});

describe("approval and dispatch", () => {
  async function admin(fx: Fixture): Promise<Player> {
    const player = await newPlayer(fx, { verified: false });
    await makeAdmin(fx, player);
    return player;
  }

  async function approve(fx: Fixture, adminPlayer: Player, withdrawalId: string) {
    const bind = await stepUpBind(adminPaymentsAction({ subject: `withdrawal:${withdrawalId}`, decision: "APPROVE" }));
    const grant = await mintGrant(fx, adminPlayer, { purpose: "admin_payments", bind, method: "PASSKEY" });
    return decideWithdrawal(fx.ctx(), { ...adminPlayer.caller, accessJwt: null }, withdrawalId, { decision: "APPROVE", stepUpGrantId: grant });
  }

  dbTest("manual review, admin approval (not by the owner), payout settles with the fee booked", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "100.00");
    const card = await cardOf(fx, player.userId);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "40.00");
    const { view } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    expect(view.status).toBe("UNDER_REVIEW");

    // The owner is not an admin (the RPC checks verifyAdmin first); an admin cannot approve their own withdrawal either.
    expect((await refusal(verifyAdmin(fx.ctx(), { ...player.caller, accessJwt: null }))).code).toBe("FORBIDDEN");
    await makeAdmin(fx, player);
    expect((await refusal(approve(fx, player, view.id))).code).toBe("SELF_APPROVAL");
    const reviewer = await admin(fx);
    expect((await verifyAdmin(fx.ctx(), { ...reviewer.caller, accessJwt: null })).role).toBe("ADMIN");
    const decided = await approve(fx, reviewer, view.id);
    expect(decided.approvalsRemaining).toBe(0);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("APPROVED");
    expect(fx.kicks).toBeGreaterThan(0);

    expect(await dispatchUntilMoved(fx, view.id, ["PENDING", "IN_FLIGHT"])).toBe("COMPLETED");
    const done = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } });
    expect(done.status).toBe("SETTLED");
    expect(done.settleTxId).not.toBeNull();
    expect((await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: view.id } })).status).toBe("COMPLETED");
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
  });

  dbTest("a payout that timed out after the provider executed it is queried, never sent twice", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "100.00");
    const card = await cardOf(fx, player.userId);
    // Cents .02: the sandbox executes the payout and answers with a timeout.
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "20.02");
    const { view } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    await approve(fx, await admin(fx), view.id);
    const dispatch = await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: view.id } });

    expect(await dispatchUntilMoved(fx, view.id, ["PENDING", "IN_FLIGHT"])).toBe("UNCERTAIN");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("SUBMITTED");
    // The hold is never released on an uncertain answer.
    expect((await balances(fx, player.userId)).held).toBe(2002n);

    fx.clock.offsetMs += 2 * 60_000;
    try {
      expect(await dispatchUntilMoved(fx, view.id, ["UNCERTAIN", "IN_FLIGHT"])).toBe("COMPLETED");
    } finally {
      fx.clock.offsetMs -= 2 * 60_000;
    }
    expect((await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: view.id } })).status).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("SETTLED");
    expect(await fx.store.get<number>(`count:create:${dispatch.providerIdempotencyKey}`)).toBe(1);
    const attempts = await fx.payments.payoutAttempt.findMany({ where: { withdrawalId: view.id }, orderBy: { seq: "asc" } });
    expect(attempts.map((a) => a.action)).toEqual(["CREATE", "QUERY"]);
  });
});

describe("payout destinations and \"This wasn't me\"", () => {
  const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";

  dbTest("adding an address needs a payout_destination grant bound to that address; it cools off for 24 h", async (fx) => {
    const player = await newPlayer(fx);
    const u = await user(fx, player.caller);
    const ctx = fx.ctx();
    const prepared = await prepareCryptoDestination(ctx, u, "MT", { asset: "USDC_ERC20", address: ADDRESS });
    const add = (grant: string | undefined, address = ADDRESS) => addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address, stepUpGrantId: grant as string, clientRequestId: crypto.randomUUID(),
    });
    const none = await refusal(add(undefined));
    expect(none.code).toBe("STEP_UP_REQUIRED");
    expect(none.stepUp).toMatchObject({ purpose: "payout_destination", bind: prepared.bind });
    const otherBind = await stepUpBind(payoutDestinationAction({ userId: player.userId, asset: "USDC_ERC20", addressNormalized: "0x0000000000000000000000000000000000000001", memo: null }));
    expect((await refusal(add(await mintGrant(fx, player, { purpose: "payout_destination", bind: otherBind })))).code).toBe("STEP_UP_REQUIRED");

    const grant = await mintGrant(fx, player, { purpose: "payout_destination", bind: prepared.bind });
    const { view } = await add(grant);
    expect(new Date(view.usableAfter).getTime()).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    // Used once: the same grant cannot add another address.
    expect((await refusal(add(grant, "0x0000000000000000000000000000000000000002"))).code).toBe("STEP_UP_REQUIRED");
  });

  dbTest("securityLockdown revokes recent destinations, cancels the open withdrawal with its release and voids grants", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "80.00");
    const card = await cardOf(fx, player.userId);
    // An older card stays: it predates the 72 h window.
    await ageInstrument(fx, card, 80 * 3_600_000);
    const u = await user(fx, player.caller);
    const prepared = await prepareCryptoDestination(fx.ctx(), u, "MT", { asset: "USDC_ERC20", address: ADDRESS });
    const { view: instrument } = await addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address: ADDRESS, stepUpGrantId: await mintGrant(fx, player, { purpose: "payout_destination", bind: prepared.bind }), clientRequestId: crypto.randomUUID(),
    });
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "30.00");
    const { view } = await requestWithdrawal(fx.ctx(), player.caller, u, { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    expect(await balances(fx, player.userId)).toEqual({ available: 5000n, held: 3000n });
    const spare = await quoteAndGrant(fx, player, card, "20.00");

    const result = await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    expect(result).toEqual({ revoked: 1, cancelled: 1 });
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("CANCELLED");
    expect(await balances(fx, player.userId)).toEqual({ available: 8000n, held: 0n });
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: instrument.id } })).status).toBe("REVOKED");
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } })).status).toBe("ACTIVE");
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).restriction).toBe("WITHDRAWALS_MANUAL");
    // The grant minted before the lockdown is void.
    expect((await refusal(requestWithdrawal(fx.ctx(), player.caller, u, { quoteId: spare.quoteId, stepUpGrantId: spare.grant, clientRequestId: crypto.randomUUID() }))).code).toBe("STEP_UP_REQUIRED");
    // Idempotent.
    expect(await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null)).toEqual({ revoked: 0, cancelled: 0 });
  });

  dbTest("a lockdown also revokes a card saved by a deposit in the last 72 hours (no shortcut past the address rules)", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "50.00");
    const card = await cardOf(fx, player.userId);
    expect(await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null)).toEqual({ revoked: 1, cancelled: 0 });
    const row = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } });
    expect([row.status, row.payoutEnabled, row.revokedReason]).toEqual(["REVOKED", false, "SECURITY_LOCKDOWN"]);
  });

  async function addAddress(fx: Fixture, player: Player, address: string): Promise<string> {
    const u = await user(fx, player.caller);
    const prepared = await prepareCryptoDestination(fx.ctx(), u, "MT", { asset: "USDC_ERC20", address });
    const { view } = await addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address, stepUpGrantId: await mintGrant(fx, player, { purpose: "payout_destination", bind: prepared.bind }), clientRequestId: crypto.randomUUID(),
    });
    return view.id;
  }

  const token = (fx: Fixture, userId: string, k: string, s: string) => signNotMe(fx.config.notifyLinkSecret!, { u: userId, k, s, e: fx.now().getTime() + NOT_ME_TTL_MS });

  /** What POST /api/wallet/not-me does, in its order: check the link, record the report, then ask payments. */
  async function reportLink(fx: Fixture, value: unknown): Promise<string> {
    const claims = await verifyNotMeToken(fx.ctx(), value);
    const notice = { k: claims.k, s: claims.s };
    const event = await fx.runtime.accountSecurityEvent.create({ data: { userId: claims.u, type: "NOT_ME_REPORTED", data: { kind: "PAYMENT_NOTICE", notice } }, select: { id: true, createdAt: true } }) as { id: string; createdAt: Date };
    await securityLockdown(fx.ctx(), claims.u, "NOT_ME", null, { id: event.id, at: event.createdAt, notice });
    return claims.u;
  }

  dbTest("the \"This wasn't me\" link revokes the destination it names even when it is older than the 72 h sweep", async (fx) => {
    const player = await newPlayer(fx);
    const named = await addAddress(fx, player, ADDRESS);
    const other = await addAddress(fx, player, "0x0000000000000000000000000000000000000005");
    await ageInstrument(fx, named, 4 * 86_400_000);
    await ageInstrument(fx, other, 4 * 86_400_000);
    expect(await reportLink(fx, await token(fx, player.userId, "destination-added", named))).toBe(player.userId);
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: named } })).status).toBe("REVOKED");
    // Only the one it names: anything else that old stays.
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: other } })).status).toBe("ACTIVE");
  });

  dbTest("the link in a withdrawal email revokes that withdrawal's destination and cancels it", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "80.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 5 * 86_400_000);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "30.00");
    const { view } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    const email = await fx.payments.emailOutbox.findFirstOrThrow({ where: { userId: player.userId, template: "withdrawal-requested" } });
    const notMe = (email.payload as { notMe?: string }).notMe;
    expect(notMe).toMatch(/^w1\./);
    expect(await reportLink(fx, notMe)).toBe(player.userId);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("CANCELLED");
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } })).status).toBe("REVOKED");
    expect(await balances(fx, player.userId)).toEqual({ available: 8000n, held: 0n });
  });

  dbTest("a token for someone else's destination revokes nothing of theirs", async (fx) => {
    const owner = await newPlayer(fx);
    const victim = await newPlayer(fx);
    const theirs = await addAddress(fx, victim, ADDRESS);
    await ageInstrument(fx, theirs, 4 * 86_400_000);
    await reportLink(fx, await token(fx, owner.userId, "destination-added", theirs));
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: theirs } })).status).toBe("ACTIVE");
  });

  dbTest("a report that reached payments both ways is applied once", async (fx) => {
    const player = await newPlayer(fx);
    await reportLink(fx, await token(fx, player.userId, "withdrawal-requested", crypto.randomUUID()));
    await applyPendingLockdowns(fx.ctx(), 50);
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectUserId: player.userId, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } })).toBe(1);
    // Two deliveries of one report at the same moment: the player's lock decides.
    const event = await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED" }, select: { id: true, createdAt: true } }) as { id: string; createdAt: Date };
    const report = { id: event.id, at: event.createdAt, notice: null };
    await Promise.all([securityLockdown(fx.ctx(), player.userId, "NOT_ME", null, report), securityLockdown(fx.ctx(), player.userId, "NOT_ME", null, report), applyPendingLockdowns(fx.ctx(), 50)]);
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectUserId: player.userId, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } })).toBe(2);
  });

  dbTest("the revoke window runs back from the report, not from the retry", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 3_600_000);
    await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED" } });
    // Payments is down for four days after the report, then the sweep runs.
    fx.clock.offsetMs = 4 * 86_400_000;
    try {
      await applyPendingLockdowns(fx.ctx(), 50);
    } finally {
      fx.clock.offsetMs = 0;
    }
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } })).status).toBe("REVOKED");
  });

  dbTest("the sweep keeps what the notice named: a destination older than the window goes when the fast path never ran", async (fx) => {
    const player = await newPlayer(fx);
    const named = await addAddress(fx, player, ADDRESS);
    await ageInstrument(fx, named, 4 * 86_400_000);
    await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED", data: { kind: "PAYMENT_NOTICE", notice: { k: "destination-added", s: named } } } });
    await applyPendingLockdowns(fx.ctx(), 50);
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: named } })).status).toBe("REVOKED");
  });

  dbTest("a report that always fails takes no slot for good, and fails on its own", async (fx) => {
    const broken = await Promise.all([newPlayer(fx), newPlayer(fx), newPlayer(fx)]);
    const good = await newPlayer(fx);
    for (const player of [...broken, good]) await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bad = new Set(broken.map((player) => player.userId));
    // The compliance lock of these three players always fails; older reports of other tests are in the queue too.
    const failing: PaymentsContext = {
      ...fx.ctx(),
      db: new Proxy(fx.payments, {
        get(target, prop, receiver) {
          if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
          return (fn: (tx: unknown) => Promise<unknown>, options: unknown) => (target.$transaction as (a: unknown, b: unknown) => Promise<unknown>)(async (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => fn(new Proxy(tx, {
            get(inner, name, innerReceiver) {
              if (name !== "$executeRaw") return Reflect.get(inner, name, innerReceiver);
              return (strings: TemplateStringsArray, ...values: unknown[]) => {
                if (values.some((value) => typeof value === "string" && bad.has(value))) throw new Error("this row always fails");
                return inner.$executeRaw(strings, ...values);
              };
            },
          })), options);
        },
      }),
    };
    for (let tick = 0; tick < 60; tick += 1) {
      await applyPendingLockdowns(failing, 3);
      if (await fx.payments.paymentReviewAction.count({ where: { subjectUserId: good.userId, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } }) === 1) break;
    }
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectUserId: good.userId, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } })).toBe(1);
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectUserId: { in: [...bad] }, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } })).toBe(0);
    await applyPendingLockdowns(fx.ctx(), 50);
  });

  dbTest("a lockdown payments never heard about is found in the security events and applied once", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 80 * 3_600_000);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "20.00");
    const { view } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    // The auth side committed; the RPC to payments was lost.
    await fx.runtime.accountSecurityEvent.create({ data: { userId: player.userId, type: "NOT_ME_REPORTED" } });
    await applyPendingLockdowns(fx.ctx(), 50);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: view.id } })).status).toBe("CANCELLED");
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).restriction).toBe("WITHDRAWALS_MANUAL");
    const count = () => fx.payments.paymentReviewAction.count({ where: { subjectUserId: player.userId, reasonCode: "SECURITY_LOCKDOWN_NOT_ME" } });
    expect(await count()).toBe(1);
    await applyPendingLockdowns(fx.ctx(), 50);
    expect(await count()).toBe(1);
  });
});

describe("a new card is a new payout destination", () => {
  dbTest("it cools off for 24 h, and the owner is told with a \"This wasn't me\" link", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "50.00", "approve", { cooling: true });
    const card = await fx.payments.paymentInstrument.findFirstOrThrow({ where: { userId: player.userId, kind: "CARD_TOKEN" } });
    expect(card.usableAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    const refused = await refusal(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: card.id, amount: "20.00" }));
    expect(refused.code).toBe("DESTINATION_COOLING_OFF");
    const email = await fx.payments.emailOutbox.findFirstOrThrow({ where: { userId: player.userId, template: "destination-added" } });
    expect(email.payload).toMatchObject({ card: "true", address: expect.stringContaining("••••") });
    expect((email.payload as { notMe?: string }).notMe).toMatch(/^w1\./);
    // A later deposit with the same card announces nothing new.
    await cardDeposit(fx, player, "10.00", "approve", { cooling: true });
    expect(await fx.payments.emailOutbox.count({ where: { userId: player.userId, template: "destination-added" } })).toBe(1);
  });

  dbTest("the database floors the cooling-off even if the application asks for less", async (fx) => {
    const player = await newPlayer(fx);
    await expect(fx.payments.paymentInstrument.create({
      data: {
        userId: player.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: "sandbox-card", assetCode: "TEST_EUR", cardToken: `tok_${crypto.randomUUID()}`,
        depositEnabled: true, payoutEnabled: true, usableAfter: new Date(),
      },
    })).resolves.toMatchObject({ usableAfter: expect.any(Date) });
    const row = await fx.payments.paymentInstrument.findFirstOrThrow({ where: { userId: player.userId } });
    expect(row.usableAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
  });

  dbTest("a card receives at most what it deposited, across withdrawals", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "30.00");
    const card = await cardOf(fx, player.userId);
    // The rest of the balance came by another rail, so the balance is not what stops this.
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount: "40.00", payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
    const paid = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    const envelope = await applySandboxOutcome(sandboxOptions(fx), paid.providerPaymentId!, "confirm");
    expect((await deliver(fx, ctx, "sandbox-crypto", envelope!)).status).toBe(200);
    await fx.flush();
    expect(await balances(fx, player.userId)).toEqual({ available: 7000n, held: 0n });
    const limited = await refusal(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: card, amount: "30.01" }));
    expect(limited.code).toBe("CARD_PAYOUT_LIMIT");
    expect(limited.details).toEqual({ max: "30.00" });

    // Two quotes each inside the room: the second request is refused under the lock, and nothing is spent.
    const first = await quoteAndGrant(fx, player, card, "20.00");
    const second = await quoteAndGrant(fx, player, card, "20.00");
    await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId: first.quoteId, stepUpGrantId: first.grant, clientRequestId: crypto.randomUUID() });
    const refused = await refusal(requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId: second.quoteId, stepUpGrantId: second.grant, clientRequestId: crypto.randomUUID() }));
    expect(refused.code).toBe("CARD_PAYOUT_LIMIT");
    expect(refused.details).toEqual({ max: "10.00" });
    expect(await balances(fx, player.userId)).toEqual({ available: 5000n, held: 2000n });
    expect((await fx.payments.stepUpGrant.findUniqueOrThrow({ where: { id: second.grant } })).consumedAt).toBeNull();
  });

  const cardOnly = (fx: Fixture): PaymentsContext => {
    const ctx = fx.ctx();
    return { ...ctx, providers: { ...ctx.providers, crypto: null } };
  };

  dbTest("the closed loop has no clock: a deposit older than 90 days can still go back to its card", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."Deposit" SET "createdAt" = now() - interval '91 days', "creditedAt" = now() - interval '91 days' WHERE "userId" = ${player.userId}`);
    await expect(quoteWithdrawal(cardOnly(fx), await user(fx, player.caller), { instrumentId: card, amount: "60.00" })).resolves.toMatchObject({ quote: { amount: "60.00" } });
  });

  dbTest("deposit, payout, deposit leaves room equal to the second deposit", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    const payout = await approvedWithdrawal(fx, player, "60.00");
    expect(await dispatchUntilMoved(fx, payout.id, ["PENDING", "IN_FLIGHT"], 30)).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("SETTLED");
    await cardDeposit(fx, player, "60.00");
    await expect(quoteWithdrawal(cardOnly(fx), await user(fx, player.caller), { instrumentId: card, amount: "60.00" })).resolves.toMatchObject({ quote: { amount: "60.00" } });
    expect((await refusal(quoteWithdrawal(cardOnly(fx), await user(fx, player.caller), { instrumentId: card, amount: "60.01" }))).code).toBe("INSUFFICIENT_FUNDS");
  });

  dbTest("a payout that failed or was cancelled does not count against the card", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    const staff = await newAdmin(fx);
    const refused = await requestTo(fx, player, card, "60.00");
    await decideWithdrawal(fx.ctx(), asAdmin(staff), refused, { decision: "REJECT", reasonCode: "AML_CONCERN", stepUpGrantId: await adminGrantFor(fx, staff, `withdrawal:${refused}`, "REJECT") });
    // Cents .01: the sandbox declines it for good.
    const declined = await approvedWithdrawal(fx, player, "40.01");
    expect(await dispatchUntilMoved(fx, declined.id, ["PENDING", "IN_FLIGHT"], 30)).toBe("FAILED");
    await expect(quoteWithdrawal(cardOnly(fx), await user(fx, player.caller), { instrumentId: card, amount: "60.00" })).resolves.toMatchObject({ quote: { amount: "60.00" } });
  });

  dbTest("a card the player removed comes back only through a fresh deposit: a new row, cooling off and announced", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const removed = await cardOf(fx, player.userId);
    await revokeInstrument(fx.ctx(), await user(fx, player.caller), removed);
    const again = await cardDeposit(fx, player, "10.00", "approve", { cooling: true });
    const deposit = await fx.payments.deposit.findUniqueOrThrow({ where: { id: again } });
    expect(deposit.status).toBe("CREDITED");
    expect(deposit.instrumentId).not.toBeNull();
    expect(deposit.instrumentId).not.toBe(removed);
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: removed } })).status).toBe("REVOKED");
    const fresh = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: deposit.instrumentId! } });
    expect(fresh.status).toBe("ACTIVE");
    expect(fresh.usableAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    expect(await fx.payments.emailOutbox.count({ where: { userId: player.userId, template: "destination-added" } })).toBe(2);
    expect((await refusal(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: fresh.id, amount: "10.00" }))).code).toBe("DESTINATION_COOLING_OFF");
    // One card, however many rows: the first deposit still counts.
    await endCooling(fx, fresh.id);
    await expect(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: fresh.id, amount: "70.00" })).resolves.toMatchObject({ quote: { amount: "70.00" } });
  });

  dbTest("the database keeps one live row per player and card", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "10.00");
    const row = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: await cardOf(fx, player.userId) } });
    await expect(fx.payments.paymentInstrument.create({
      data: { userId: player.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: row.providerKey, assetCode: row.assetCode, cardToken: row.cardToken },
    })).rejects.toThrow(/PM005|DUPLICATE_INSTRUMENT/);
  });

  dbTest("a card token another player holds still names the deposit, and takes no payout", async (fx) => {
    const first = await newPlayer(fx);
    await cardDeposit(fx, first, "10.00");
    const token = (await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: await cardOf(fx, first.userId) } })).cardToken!;
    const second = await newPlayer(fx);
    const { start } = await createDeposit(fx.ctx(), second.caller, await user(fx, second.caller), { method: "CARD", amount: "15.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    const payment: ProviderPayment = {
      providerPaymentId: `shared_${crypto.randomUUID()}`, merchantRef: start.deposit.id, channelRef: null, state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 1500n, feeMinor: null, occurredAt: fx.now(),
      card: { token, fingerprint: null, brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030, issuerCountry: "MT", funding: "debit", payoutEligible: true, holderName: null },
    };
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => applyProviderPayment(tx, ctx, ctx.providers.card!, payment), { label: "test" });
    const deposit = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    expect(deposit.status).toBe("CREDITED");
    const row = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: deposit.instrumentId! } });
    expect([row.userId, row.payoutEnabled, row.depositEnabled]).toEqual([second.userId, false, false]);
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectId: start.deposit.id, reasonCode: "CARD_SHARED" } })).toBe(1);
  });

  dbTest("a card payment with no card named goes to review, and a person cannot credit it", async (fx) => {
    const player = await newPlayer(fx);
    const { start } = await createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), { method: "CARD", amount: "15.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    const payment: ProviderPayment = { providerPaymentId: `nocard_${crypto.randomUUID()}`, merchantRef: start.deposit.id, channelRef: null, state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 1500n, feeMinor: null, occurredAt: fx.now() };
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => applyProviderPayment(tx, ctx, ctx.providers.card!, payment), { label: "test" });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    expect([row.status, row.statusReason, row.instrumentId]).toEqual(["NEEDS_REVIEW", "CARD_UNKNOWN", null]);
    const staff = await newAdmin(fx);
    const refused = await refusal(resolveDeposit(fx.ctx(), asAdmin(staff), row.id, { action: "CREDIT", creditAmount: "15.00", note: "looks fine", stepUpGrantId: await adminGrantFor(fx, staff, `deposit:${row.id}`, "CREDIT:1500") }));
    expect(refused.code).toBe("CARD_UNKNOWN");
    // And the database agrees: nothing credits a card deposit that names no card.
    await expect(withoutTriggers((tx) => tx.$executeRaw`
      UPDATE public."Deposit" SET "status" = 'CREDITED', "creditedMinor" = 1500, "confirmedAt" = now(), "ledgerCreditTxId" = gen_random_uuid() WHERE "id" = ${row.id}::uuid`)).rejects.toThrow();
  });

  dbTest("a card that went to review is linked, so a person can credit it", async (fx) => {
    const player = await newPlayer(fx);
    const id = await cardDeposit(fx, player, "20.00", "approve", { cooling: true });
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id } })).instrumentId).not.toBeNull();
    const second = await createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), { method: "CARD", amount: "15.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    const card = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: await cardOf(fx, player.userId) } });
    const payment: ProviderPayment = {
      providerPaymentId: `mismatch_${crypto.randomUUID()}`, merchantRef: second.start.deposit.id, channelRef: null, state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 1400n, feeMinor: null, occurredAt: fx.now(),
      card: { token: card.cardToken!, fingerprint: null, brand: "VISA", last4: "4242", expMonth: 12, expYear: 2030, issuerCountry: "MT", funding: "debit", payoutEligible: true, holderName: null },
    };
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => applyProviderPayment(tx, ctx, ctx.providers.card!, payment), { label: "test" });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: second.start.deposit.id } });
    expect([row.status, row.statusReason, row.instrumentId]).toEqual(["NEEDS_REVIEW", "AMOUNT_MISMATCH", card.id]);
  });
});

describe("restoring one revoked card", () => {
  async function lockedOut(fx: Fixture): Promise<{ player: Player; card: string; attackerCard: string }> {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    // A second card the owner never added.
    const attacker = await fx.payments.paymentInstrument.create({
      data: { userId: player.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: "sandbox-card", assetCode: "TEST_EUR", cardToken: `tok_${crypto.randomUUID()}`, depositEnabled: true, payoutEnabled: true },
    });
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    const staff = await newAdmin(fx);
    await setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "NONE", reason: "owner confirmed", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:NONE") });
    return { player, card, attackerCard: attacker.id };
  }

  const restore = async (fx: Fixture, staff: Player, player: Player, card: string) => restoreInstrument(fx.ctx(), asAdmin(staff), player.userId, card, { reason: "owner's own card, checked by phone", stepUpGrantId: await adminGrantFor(fx, staff, `instrument:${card}`, "RESTORE") });

  dbTest("two administrators bring back exactly that card: a new row, cooling off, the notice, and the other card stays revoked", async (fx) => {
    const { player, card, attackerCard } = await lockedOut(fx);
    const first = await newAdmin(fx);
    const second = await newAdmin(fx);
    expect(await restore(fx, first, player, card)).toEqual({ instrument: null, approvalsRemaining: 1 });
    expect((await refusal(restore(fx, first, player, card))).code).toBe("ALREADY_APPROVED");
    expect(await fx.payments.paymentInstrument.count({ where: { userId: player.userId, status: "ACTIVE" } })).toBe(0);
    const done = await restore(fx, second, player, card);
    expect(done.approvalsRemaining).toBe(0);
    const row = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: done.instrument!.id } });
    expect(row.id).not.toBe(card);
    expect([row.status, row.payoutEnabled, row.cardToken]).toEqual(["ACTIVE", true, (await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } })).cardToken]);
    expect(row.usableAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } })).status).toBe("REVOKED");
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: attackerCard } })).status).toBe("REVOKED");
    expect(await fx.payments.paymentInstrument.count({ where: { userId: player.userId, status: "ACTIVE" } })).toBe(1);
    const mail = await fx.payments.emailOutbox.findFirstOrThrow({ where: { userId: player.userId, template: "destination-added" }, orderBy: { createdAt: "desc" } });
    expect(mail.payload).toMatchObject({ card: "true", restored: "true" });
    expect((mail.payload as { notMe?: string }).notMe).toMatch(/^w1\./);
    // The old row is spent: only the card's newest row can be named.
    expect((await refusal(restore(fx, await newAdmin(fx), player, card))).code).toBe("INVALID_STATE");
    await endCooling(fx, row.id);
    await expect(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: row.id, amount: "60.00" })).resolves.toMatchObject({ quote: { amount: "60.00" } });
  });

  dbTest("it is refused for the admin's own card, an address, a live card, and during the player's security hold", async (fx) => {
    const { player, card } = await lockedOut(fx);
    const staff = await newAdmin(fx);
    const selfTarget = await refusal(restoreInstrument(fx.ctx(), asAdmin(staff), staff.userId, card, { reason: "mine", stepUpGrantId: "g" }));
    expect(selfTarget.code).toBe("SELF_APPROVAL");
    const other = await newPlayer(fx);
    await cardDeposit(fx, other, "10.00");
    expect((await refusal(restore(fx, staff, other, await cardOf(fx, other.userId)))).code).toBe("INVALID_STATE");
    await fx.runtime.user.update({ where: { id: player.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });
    expect((await refusal(restore(fx, staff, player, card))).code).toBe("SECURITY_HOLD");
  });

  dbTest("a card another account also holds is not restored: it never takes payouts here", async (fx) => {
    const { player, card } = await lockedOut(fx);
    const revoked = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: card } });
    const other = await newPlayer(fx);
    await fx.payments.paymentInstrument.create({
      data: { userId: other.userId, kind: "CARD_TOKEN", origin: "DEPOSIT", providerKey: revoked.providerKey, assetCode: revoked.assetCode, cardToken: revoked.cardToken },
    });
    const staff = await newAdmin(fx);
    expect((await refusal(restore(fx, staff, player, card))).code).toBe("INVALID_STATE");
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectType: "INSTRUMENT", subjectId: card } })).toBe(0);
    expect(await fx.payments.paymentInstrument.count({ where: { userId: player.userId, status: "ACTIVE" } })).toBe(0);
  });

  dbTest("the database will not let a review action name another owner's instrument", async (fx) => {
    const { player, card } = await lockedOut(fx);
    const staff = await newAdmin(fx);
    await expect(fx.payments.paymentReviewAction.create({
      data: { subjectType: "INSTRUMENT", subjectId: card, subjectUserId: staff.userId, actorKind: "ADMIN", actorUserId: staff.userId, verb: "NOTE" },
    })).rejects.toThrow(/PM004|APPROVAL_REQUIRED/);
    void player;
  });
});

describe("refunds to source", () => {
  async function overLimit(fx: Fixture, kind: "CARD" | "CRYPTO"): Promise<{ player: Player; refundId: string; depositId: string }> {
    const player = await newPlayer(fx);
    await fx.runtime.responsibleGamingLimit.create({ data: { userId: player.userId, kind: "DEPOSIT", period: "DAY", assetCode: "EUR", amountMinor: 2500n, source: "PLAYER", createdBy: player.userId } });
    const depositId = kind === "CARD" ? await cardDeposit(fx, player, "20.00", "approve_prepaid") : await cryptoDeposit(fx, player, "20.00", "overpay");
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    return { player, refundId: refund.id, depositId };
  }

  const approve = async (fx: Fixture, staff: Player, id: string, named?: string) => decideWithdrawal(fx.ctx(), asAdmin(staff), id, {
    decision: "APPROVE", ...(named ? { refundInstrumentId: named } : {}), stepUpGrantId: await adminGrantFor(fx, staff, `withdrawal:${id}`, named ? `APPROVE:${named}` : "APPROVE"),
  });

  async function address(fx: Fixture, player: Player, value = "0x52908400098527886e0f7030069857d2e4169ee7"): Promise<string> {
    const u = await user(fx, player.caller);
    const prepared = await prepareCryptoDestination(fx.ctx(), u, "MT", { asset: "USDC_ERC20", address: value });
    const { view } = await addCryptoDestination(fx.ctx(), player.caller, u, "MT", {
      asset: "USDC_ERC20", address: value, stepUpGrantId: await mintGrant(fx, player, { purpose: "payout_destination", bind: prepared.bind }), clientRequestId: crypto.randomUUID(),
    });
    return view.id;
  }

  dbTest("a crypto refund cannot be approved without a destination: a typed 409, never INTERNAL", async (fx) => {
    const { refundId, player } = await overLimit(fx, "CRYPTO");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).status).toBe("UNDER_REVIEW");
    const staff = await newAdmin(fx);
    expect((await refusal(approve(fx, staff, refundId))).code).toBe("REFUND_DESTINATION_REQUIRED");
    // An address still cooling off, or someone else's, is no destination either.
    const cooling = await address(fx, player);
    expect((await refusal(approve(fx, staff, refundId, cooling))).code).toBe("REFUND_DESTINATION_REQUIRED");
    const stranger = await newPlayer(fx);
    const theirs = await address(fx, stranger, "0x0000000000000000000000000000000000000007");
    await endCooling(fx, theirs);
    expect((await refusal(approve(fx, staff, refundId, theirs))).code).toBe("REFUND_DESTINATION_REQUIRED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).status).toBe("UNDER_REVIEW");
  });

  dbTest("named by an administrator, a crypto refund reaches a payout: the promise to a self-excluded player holds", async (fx) => {
    const { refundId, player } = await overLimit(fx, "CRYPTO");
    const held = (await balances(fx, player.userId)).held;
    expect(held).toBeGreaterThan(0n);
    const mail = await fx.payments.emailOutbox.findFirstOrThrow({ where: { userId: player.userId, template: "refund-held" } });
    expect(mail.payload).toMatchObject({ needsAddress: "true" });
    const destination = await address(fx, player);
    await endCooling(fx, destination);
    const staff = await newAdmin(fx);
    await approve(fx, staff, refundId, destination);
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } });
    expect([row.status, row.instrumentId, row.providerKey]).toEqual(["APPROVED", destination, "sandbox-crypto"]);
    expect(await dispatchUntilMoved(fx, refundId, ["PENDING", "IN_FLIGHT"], 30)).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).status).toBe("SETTLED");
    expect((await balances(fx, player.userId)).held).toBe(0n);
  });

  dbTest("with two approvals needed, administrators must agree on the destination", async (fx) => {
    const { refundId, player } = await overLimit(fx, "CRYPTO");
    await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."Withdrawal" SET "approvalsRequired" = 2 WHERE "id" = ${refundId}::uuid`);
    const one = await address(fx, player);
    const two = await address(fx, player, "0x0000000000000000000000000000000000000008");
    await endCooling(fx, one);
    await endCooling(fx, two);
    const first = await newAdmin(fx);
    const second = await newAdmin(fx);
    expect((await approve(fx, first, refundId, one)).approvalsRemaining).toBe(1);
    expect((await approve(fx, second, refundId, two)).approvalsRemaining).toBe(1);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).status).toBe("UNDER_REVIEW");
    expect((await approve(fx, second, refundId, one)).approvalsRemaining).toBe(0);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).instrumentId).toBe(one);
  });

  // A crypto refund to an address an administrator named goes where someone chose: it is a payout in all but name.
  async function namedRefund(fx: Fixture): Promise<{ player: Player; refundId: string; destination: string; key: string }> {
    const { refundId, player } = await overLimit(fx, "CRYPTO");
    const destination = await address(fx, player);
    await endCooling(fx, destination);
    await approve(fx, await newAdmin(fx), refundId, destination);
    const dispatch = await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: refundId } });
    expect(dispatch.status).toBe("PENDING");
    return { player, refundId, destination, key: dispatch.providerIdempotencyKey };
  }
  const sends = (fx: Fixture, key: string) => fx.store.get<number>(`count:create:${key}`).then((n) => n ?? 0);

  dbTest("a named crypto refund is stopped by a not-me lockdown that revokes its address: cancelled, never sent", async (fx) => {
    const { player, refundId, destination, key } = await namedRefund(fx);
    await securityLockdown(fx.ctx(), player.userId, "NOT_ME", null);
    expect((await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: destination } })).status).toBe("REVOKED");
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } });
    expect([row.status, row.cancelCode]).toEqual(["CANCELLED", "SECURITY_LOCKDOWN"]);
    expect(await dispatchUntilMoved(fx, refundId, ["PENDING", "IN_FLIGHT"], 30)).toBe("CANCELLED");
    expect(await sends(fx, key)).toBe(0);
    expect((await balances(fx, player.userId)).held).toBe(0n);
  });

  dbTest("an admin freeze stops a named crypto refund too", async (fx) => {
    const { player, refundId, key } = await namedRefund(fx);
    const staff = await newAdmin(fx);
    await setRestriction(fx.ctx(), asAdmin(staff), player.userId, { restriction: "FROZEN", reason: "account takeover", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:FROZEN") });
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } });
    expect([row.status, row.cancelCode]).toEqual(["CANCELLED", "ACCOUNT_FROZEN"]);
    expect(await dispatchUntilMoved(fx, refundId, ["PENDING", "IN_FLIGHT"], 30)).toBe("CANCELLED");
    expect(await sends(fx, key)).toBe(0);
  });

  for (const [name, spoil, expected] of [
    ["its address revoked behind the route", async (fx: Fixture, _p: Player, destination: string) => {
      await fx.payments.paymentInstrument.update({ where: { id: destination }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "TEST", revokedBy: "SYSTEM", payoutEnabled: false } });
    }, "DESTINATION_UNAVAILABLE"],
    ["a security hold (a lockdown payments has not heard of)", async (fx: Fixture, p: Player) => {
      await fx.runtime.user.update({ where: { id: p.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });
    }, "SECURITY_HOLD"],
    ["a freeze written behind the admin route", async (fx: Fixture, p: Player) => {
      await fx.payments.playerCompliance.update({ where: { userId: p.userId }, data: { restriction: "FROZEN", restrictionReason: "TEST" } });
    }, "ACCOUNT_FROZEN"],
  ] as const) {
    dbTest(`the dispatcher re-reads a named crypto refund like a payout: ${name} cancels it before any send`, async (fx) => {
      const { player, refundId, destination, key } = await namedRefund(fx);
      await spoil(fx, player, destination);
      expect(await dispatchUntilMoved(fx, refundId, ["PENDING"])).toBe("CANCELLED");
      const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } });
      expect([row.status, row.failureCode]).toEqual(["CANCELLED", expected]);
      expect(await sends(fx, key)).toBe(0);
    });
  }

  dbTest("the database submits a payout only to an active destination; a card refund to its own revoked card is the one exception", async (fx) => {
    const { refundId, destination } = await namedRefund(fx);
    await fx.payments.paymentInstrument.update({ where: { id: destination }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "TEST", revokedBy: "SYSTEM", payoutEnabled: false } });
    await expect(fx.payments.withdrawal.update({ where: { id: refundId }, data: { status: "SUBMITTED", submittedAt: new Date() } })).rejects.toThrow(/PM010|INSTRUMENT_UNAVAILABLE/);
    // A player's own card payout too, once its card is revoked.
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const payout = await approvedWithdrawal(fx, player, "20.00");
    await fx.payments.paymentInstrument.update({ where: { id: await cardOf(fx, player.userId) }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "TEST", revokedBy: "SYSTEM", payoutEnabled: false } });
    await expect(fx.payments.withdrawal.update({ where: { id: payout.id }, data: { status: "SUBMITTED", submittedAt: new Date() } })).rejects.toThrow(/PM010|INSTRUMENT_UNAVAILABLE/);
  });

  dbTest("no address is named for a refund while the account could not withdraw: frozen, or on a security hold", async (fx) => {
    const { refundId, player } = await overLimit(fx, "CRYPTO");
    const destination = await address(fx, player);
    await endCooling(fx, destination);
    const staff = await newAdmin(fx);
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { restriction: "FROZEN", restrictionReason: "TEST" } });
    expect((await refusal(approve(fx, staff, refundId, destination))).code).toBe("ACCOUNT_RESTRICTED");
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { restriction: "NONE", restrictionReason: null } });
    await fx.runtime.user.update({ where: { id: player.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });
    expect((await refusal(approve(fx, staff, refundId, destination))).code).toBe("SECURITY_HOLD");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refundId } })).status).toBe("UNDER_REVIEW");
  });

  dbTest("a card deposit's refund stays bound to that card, even revoked, and goes back after review", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    const card = await cardOf(fx, player.userId);
    await ageInstrument(fx, card, 2 * 3_600_000);
    await revokeInstrument(fx.ctx(), await user(fx, player.caller), card);
    // The same card pays again with a limit in the way, but the deposit names the revoked row.
    const id = crypto.randomUUID();
    const deposit = await fx.payments.deposit.create({
      data: { id, userId: player.userId, method: "CARD", providerKey: "sandbox-card", assetCode: "TEST_EUR", requestedMinor: 3000n, instrumentId: card, expiresAt: new Date(Date.now() + 600_000) },
    });
    await fx.runtime.selfExclusion.create({ data: { userId: player.userId, kind: "INDEFINITE", source: "PLAYER", createdBy: player.userId } });
    const payment: ProviderPayment = { providerPaymentId: `revoked_${id}`, merchantRef: deposit.id, channelRef: null, state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 3000n, feeMinor: null, occurredAt: fx.now() };
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => applyProviderPayment(tx, ctx, ctx.providers.card!, payment), { label: "test" });
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    expect([refund.status, refund.instrumentId, refund.providerKey]).toEqual(["UNDER_REVIEW", card, "sandbox-card"]);
    const staff = await newAdmin(fx);
    const other = await newPlayer(fx);
    expect((await refusal(approve(fx, staff, refund.id, crypto.randomUUID()))).code).toBe("REFUND_DESTINATION_REQUIRED");
    void other;
    await approve(fx, staff, refund.id);
    expect(await dispatchUntilMoved(fx, refund.id, ["PENDING", "IN_FLIGHT"], 30)).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("SETTLED");
  });
});

describe("an administrator's own payments restriction", () => {
  const restrictSelf = async (fx: Fixture, insider: Player, restriction: string) => setRestriction(fx.ctx(), asAdmin(insider), insider.userId, {
    restriction, reason: "mine", stepUpGrantId: await adminGrantFor(fx, insider, `user:${insider.userId}`, `RESTRICT:${restriction}`),
  });
  const restrictionOf = async (fx: Fixture, userId: string) => (await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId } })).restriction;

  dbTest("frozen by a colleague, an administrator cannot loosen it to anything, and still cannot withdraw", async (fx) => {
    const insider = await newPlayer(fx);
    await makeAdmin(fx, insider);
    await cardDeposit(fx, insider, "60.00");
    const colleague = await newAdmin(fx);
    await setRestriction(fx.ctx(), asAdmin(colleague), insider.userId, {
      restriction: "FROZEN", reason: "chargeback fraud", stepUpGrantId: await adminGrantFor(fx, colleague, `user:${insider.userId}`, "RESTRICT:FROZEN"),
    });
    for (const loosened of ["DEPOSITS_BLOCKED", "WITHDRAWALS_MANUAL", "NONE"]) {
      expect((await refusal(restrictSelf(fx, insider, loosened))).code).toBe("SELF_APPROVAL");
    }
    expect(await restrictionOf(fx, insider.userId)).toBe("FROZEN");
    expect((await refusal(quoteWithdrawal(fx.ctx(), await user(fx, insider.caller), { instrumentId: await cardOf(fx, insider.userId), amount: "60.00" }))).code).toBe("ACCOUNT_RESTRICTED");
  });

  dbTest("a lockdown's WITHDRAWALS_MANUAL is not lifted by that administrator either; freezing one's own account still works", async (fx) => {
    const insider = await newPlayer(fx);
    await makeAdmin(fx, insider);
    await securityLockdown(fx.ctx(), insider.userId, "NOT_ME", null);
    expect(await restrictionOf(fx, insider.userId)).toBe("WITHDRAWALS_MANUAL");
    expect((await refusal(restrictSelf(fx, insider, "DEPOSITS_BLOCKED"))).code).toBe("SELF_APPROVAL");
    expect(await restrictionOf(fx, insider.userId)).toBe("WITHDRAWALS_MANUAL");
    await restrictSelf(fx, insider, "FROZEN");
    expect(await restrictionOf(fx, insider.userId)).toBe("FROZEN");
  });
});

describe("a person decides screening", () => {
  const decide = async (fx: Fixture, staff: Player, userId: string, status: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH") => setScreening(fx.ctx(), asAdmin(staff), userId, {
    status, reason: "sanctions list checked by hand", stepUpGrantId: await adminGrantFor(fx, staff, `user:${userId}`, `SCREENING:${status}`),
  });
  const complianceOf = (fx: Fixture, userId: string) => fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId } });
  const cardDepositStart = async (fx: Fixture, player: Player) => createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), {
    method: "CARD", amount: "10.00", saveCard: true, clientRequestId: crypto.randomUUID(),
  });

  dbTest("a match takes one administrator: unsent payouts stop and deposits close; a confirmed match freezes", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "20.00");
    const a = await newAdmin(fx);
    expect((await decide(fx, a, player.userId, "POTENTIAL_MATCH")).approvalsRemaining).toBe(0);
    expect((await complianceOf(fx, player.userId)).screeningStatus).toBe("POTENTIAL_MATCH");
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect([row.status, row.failureCode]).toEqual(["CANCELLED", "SCREENING_HIT"]);
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
    // No new money goes in while the money that is there cannot come out.
    expect((await refusal(cardDepositStart(fx, player))).code).toBe("ACCOUNT_RESTRICTED");
    expect((await refusal(decide(fx, a, player.userId, "POTENTIAL_MATCH"))).code).toBe("INVALID_STATE");
    expect((await decide(fx, a, player.userId, "CONFIRMED_MATCH")).compliance).toMatchObject({ screeningStatus: "CONFIRMED_MATCH", restriction: "FROZEN" });
    expect((await refusal(decide(fx, a, player.userId, "POTENTIAL_MATCH"))).code).toBe("INVALID_STATE");
    expect(await fx.payments.paymentReviewAction.count({ where: { subjectUserId: player.userId, actorUserId: a.userId, reasonCode: { startsWith: "SCREENING_" } } })).toBe(2);
  });

  dbTest("CLEAR takes two administrators after the last screening change, never one's own, and reopens withdrawals", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const card = await cardOf(fx, player.userId);
    const [a, b, c] = [await newAdmin(fx), await newAdmin(fx), await newAdmin(fx)];
    await decide(fx, a, player.userId, "POTENTIAL_MATCH");
    expect((await refusal(quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: card, amount: "20.00" }))).code).toBe("ACCOUNT_RESTRICTED");
    // The grant names the decision: one for a match does not clear.
    expect((await refusal(setScreening(fx.ctx(), asAdmin(b), player.userId, {
      status: "CLEAR", reason: "x", stepUpGrantId: await adminGrantFor(fx, b, `user:${player.userId}`, "SCREENING:POTENTIAL_MATCH"),
    }))).code).toBe("STEP_UP_REQUIRED");
    expect((await decide(fx, b, player.userId, "CLEAR")).approvalsRemaining).toBe(1);
    expect((await refusal(decide(fx, b, player.userId, "CLEAR"))).code).toBe("ALREADY_APPROVED");
    expect((await complianceOf(fx, player.userId)).screeningStatus).toBe("POTENTIAL_MATCH");
    // The provider screens again: an approval from before that change no longer counts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { screenedAt: new Date() } });
    expect((await decide(fx, c, player.userId, "CLEAR")).approvalsRemaining).toBe(1);
    expect((await decide(fx, b, player.userId, "CLEAR")).approvalsRemaining).toBe(0);
    expect((await complianceOf(fx, player.userId)).screeningStatus).toBe("CLEAR");
    expect((await quoteWithdrawal(fx.ctx(), await user(fx, player.caller), { instrumentId: card, amount: "20.00" })).quote.amount).toBe("20.00");
    // Never on one's own account.
    const insider = await newPlayer(fx);
    await makeAdmin(fx, insider);
    expect((await refusal(decide(fx, insider, insider.userId, "CLEAR"))).code).toBe("SELF_APPROVAL");
  });

  dbTest("clearing a confirmed match lifts the match, not the freeze it brought", async (fx) => {
    const player = await newPlayer(fx);
    const [a, b] = [await newAdmin(fx), await newAdmin(fx)];
    await decide(fx, a, player.userId, "CONFIRMED_MATCH");
    await decide(fx, a, player.userId, "CLEAR");
    await decide(fx, b, player.userId, "CLEAR");
    expect(await complianceOf(fx, player.userId)).toMatchObject({ screeningStatus: "CLEAR", restriction: "FROZEN" });
  });
});

describe("a deposit that names a saved card", () => {
  async function namedCardDeposit(fx: Fixture): Promise<{ player: Player; named: string; depositId: string; providerPaymentId: string }> {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "20.00");
    const named = await cardOf(fx, player.userId);
    const { start } = await createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), {
      method: "CARD", amount: "15.00", instrumentId: named, saveCard: true, clientRequestId: crypto.randomUUID(),
    });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    return { player, named, depositId: start.deposit.id, providerPaymentId: row.providerPaymentId ?? `pay_${crypto.randomUUID()}` };
  }
  const paidWith = (fx: Fixture, depositId: string, providerPaymentId: string, card: { token: string; fingerprint: string | null }): ProviderPayment => ({
    providerPaymentId, merchantRef: depositId, channelRef: null, state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 1500n, feeMinor: null, occurredAt: fx.now(),
    card: { ...card, brand: "VISA", last4: "1111", expMonth: 12, expYear: 2031, issuerCountry: "MT", funding: "debit", payoutEligible: true, holderName: null },
  });
  const apply = async (fx: Fixture, payment: ProviderPayment) => {
    const ctx = fx.ctx();
    return moneyTx(ctx.db, (tx) => applyProviderPayment(tx, ctx, ctx.providers.card!, payment), { label: "test" });
  };

  dbTest("paid with another card, it goes to a person (CARD_MISMATCH), is never credited to the named card, and cannot be credited by hand", async (fx) => {
    const { player, named, depositId, providerPaymentId } = await namedCardDeposit(fx);
    const roomBefore = await balances(fx, player.userId);
    expect(await apply(fx, paidWith(fx, depositId, providerPaymentId, { token: `tok_other_${crypto.randomUUID()}`, fingerprint: `fp_other_${crypto.randomUUID()}` }))).toBe("NEEDS_REVIEW");
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect([row.status, row.statusReason, row.instrumentId, row.creditedMinor, row.ledgerCreditTxId]).toEqual(["NEEDS_REVIEW", "CARD_MISMATCH", named, null, null]);
    expect(await balances(fx, player.userId)).toEqual(roomBefore);
    const staff = await newAdmin(fx);
    expect((await refusal(resolveDeposit(fx.ctx(), asAdmin(staff), depositId, {
      action: "CREDIT", creditAmount: "15.00", note: "statement", stepUpGrantId: await adminGrantFor(fx, staff, `deposit:${depositId}`, "CREDIT:1500"),
    }))).code).toBe("CARD_UNKNOWN");
    await resolveDeposit(fx.ctx(), asAdmin(staff), depositId, { action: "FAIL", note: "refunded at the provider", stepUpGrantId: await adminGrantFor(fx, staff, `deposit:${depositId}`, "FAIL") });
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("FAILED");
  });

  dbTest("the same card is credited as before, under its token or, when the provider reissued the token, its fingerprint", async (fx) => {
    for (const sameBy of ["token", "fingerprint"] as const) {
      const { player, named, depositId, providerPaymentId } = await namedCardDeposit(fx);
      const card = await fx.payments.paymentInstrument.findUniqueOrThrow({ where: { id: named } });
      expect(card.cardFingerprint).not.toBeNull();
      const paid = sameBy === "token" ? { token: card.cardToken!, fingerprint: card.cardFingerprint } : { token: `tok_new_${crypto.randomUUID()}`, fingerprint: card.cardFingerprint };
      await apply(fx, paidWith(fx, depositId, providerPaymentId, paid));
      const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } });
      expect([sameBy, row.status, row.instrumentId]).toEqual([sameBy, "CREDITED", named]);
      expect((await balances(fx, player.userId)).available).toBe(3500n);
    }
  });
});

describe("the way back from a self-exclusion", () => {
  const runtime = (fx: Fixture) => fx.runtime as unknown as AppDb;

  async function exclude(fx: Fixture, player: Player, endsInDays: number | null) {
    const row = await fx.runtime.selfExclusion.create({
      data: {
        userId: player.userId, kind: endsInDays === null ? "INDEFINITE" : "DEFINITE", source: "PLAYER", createdBy: player.userId,
        ...(endsInDays === null ? {} : { endsAt: new Date(Date.now() + endsInDays * 86_400_000) }),
      },
      select: { id: true },
    }) as { id: string };
    return row.id;
  }

  /** The break's end date is fixed, so time is moved the other way: everything happens that far back. */
  const endItAgo = (id: string, ms: number) => withoutTriggers(async (tx) => {
    const at = new Date(Date.now() - ms).toISOString();
    await tx.$executeRaw`UPDATE public."SelfExclusion" SET "startsAt" = ${at}::timestamp - interval '7 days', "endsAt" = ${at}::timestamp WHERE "id" = ${id}::uuid`;
  });

  dbTest("a timed break stays in force after it ends, until the player asks and 24 hours pass", async (fx) => {
    const player = await newPlayer(fx);
    const id = await exclude(fx, player, 7);
    expect(await requestReactivation(runtime(fx), player.userId)).toMatchObject({ code: "EXCLUSION_NOT_ENDED" });
    // The database refuses it too, whatever the route thinks.
    await expect(fx.runtime.selfExclusion.update({ where: { id }, data: { reactivationRequestedAt: new Date() } })).rejects.toThrow(/PM007|RG_RULE/);
    expect(await selfExclusionStatus(runtime(fx), player.userId)).toMatchObject({ active: true, kind: "DEFINITE", canRequestReturn: false, requestedAt: null });

    await endItAgo(id, 3 * 3_600_000);
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date())).not.toBeNull();
    expect((await refusal(createDeposit(fx.ctx(), player.caller, await user(fx, player.caller), { method: "CARD", amount: "10.00", clientRequestId: crypto.randomUUID() }))).code).toBe("SELF_EXCLUDED");
    expect(await selfExclusionStatus(runtime(fx), player.userId)).toMatchObject({ active: true, canRequestReturn: true });

    const asked = await requestReactivation(runtime(fx), player.userId);
    if (!("status" in asked)) throw new Error("refused");
    expect(asked.status).toMatchObject({ active: true, canRequestReturn: false, requestedAt: expect.any(String) });
    const reopens = Date.parse(asked.status.accessRestoredAt!);
    expect(reopens).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    expect(reopens).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 60_000);
    expect((await fx.payments.selfExclusion.findUniqueOrThrow({ where: { id } })).reactivationAcceptedBy).toBe("PLAYER_REQUEST");
    // Still closed for the 24 hours, and asking again changes nothing.
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date())).not.toBeNull();
    await expect(fx.runtime.selfExclusion.update({ where: { id }, data: { reactivationRequestedAt: new Date(Date.now() - 86_400_000) } })).rejects.toThrow();
    // Open again after them.
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date(reopens + 1_000))).toBeNull();
    expect(await selfExclusionStatus(runtime(fx), player.userId, reopens + 1_000)).toMatchObject({ active: false });
  });

  dbTest("two breaks: the way back opens when the last one ended", async (fx) => {
    const player = await newPlayer(fx);
    const over = await exclude(fx, player, 2);
    await endItAgo(over, 3_600_000);
    await exclude(fx, player, 30);
    expect(await selfExclusionStatus(runtime(fx), player.userId)).toMatchObject({ active: true, canRequestReturn: false });
    expect(await requestReactivation(runtime(fx), player.userId)).toMatchObject({ code: "EXCLUSION_NOT_ENDED" });
  });

  dbTest("an indefinite exclusion needs an administrator, and then 7 days", async (fx) => {
    const player = await newPlayer(fx);
    const id = await exclude(fx, player, null);
    const staff = await newAdmin(fx);
    const accept = async (who: Player) => acceptReactivation(fx.ctx(), asAdmin(who), id, { note: "reviewed with the player", stepUpGrantId: await adminGrantFor(fx, who, `self-exclusion:${id}`, "ACCEPT") });
    expect((await refusal(accept(staff))).code).toBe("INVALID_STATE");
    const asked = await requestReactivation(runtime(fx), player.userId);
    if (!("status" in asked)) throw new Error("refused");
    expect(asked.status).toMatchObject({ active: true, kind: "INDEFINITE", requestedAt: expect.any(String), accessRestoredAt: null });
    expect((await listReactivations(fx.ctx(), { limit: 50 })).items.map((item) => item.id)).toContain(id);
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date(Date.now() + 365 * 86_400_000))).not.toBeNull();
    const { accessRestoredAt } = await accept(staff);
    expect(Date.parse(accessRestoredAt)).toBeGreaterThanOrEqual(Date.now() + 7 * 86_400_000 - 60_000);
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date(Date.parse(accessRestoredAt) - 1_000))).not.toBeNull();
    expect(await activeSelfExclusion(fx.payments, player.userId, new Date(Date.parse(accessRestoredAt) + 1_000))).toBeNull();
  });

  dbTest("an operator cannot end a timed break, and a player cannot accept their own indefinite one", async (fx) => {
    const player = await newPlayer(fx);
    const timed = await exclude(fx, player, 2);
    await endItAgo(timed, 3_600_000);
    await withoutTriggers((tx) => tx.$executeRaw`UPDATE public."SelfExclusion" SET "reactivationRequestedAt" = NULL WHERE "id" = ${timed}::uuid`);
    await expect(fx.payments.selfExclusion.update({ where: { id: timed }, data: { reactivationAcceptedAt: new Date(), reactivationAcceptedBy: "x" } })).rejects.toThrow(/PM007|RG_RULE/);
    await expect(fx.runtime.selfExclusion.update({ where: { id: timed }, data: { reactivationAcceptedAt: new Date(), reactivationAcceptedBy: "x" } })).rejects.toThrow();
  });
});

describe("what a Worker leaves alone", () => {
  dbTest("the outbox: a Worker sends only the mail its own environment wrote", async (fx) => {
    const player = await newPlayer(fx);
    const dedupeKey = `live-row:${crypto.randomUUID()}`;
    await fx.payments.emailOutbox.create({ data: { userId: player.userId, template: "chargeback", scope: "EUR", payload: {}, dedupeKey } });
    for (let i = 0; i < 40; i += 1) if (await drainOutbox(fx.payments, {} as never, fx.config, fx.now(), 50) === 0) break;
    const row = await fx.payments.emailOutbox.findUniqueOrThrow({ where: { dedupeKey } });
    expect([row.status, row.attempts, row.lastError]).toEqual(["PENDING", 0, null]);
  });
});

describe("Sumsub's clear", () => {
  dbTest("an automatic CLEAR never lifts a match on record", async (fx) => {
    const player = await newPlayer(fx);
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { screeningStatus: "POTENTIAL_MATCH" } });
    const { applyKycUpdate } = await import("../../src/payments/compliance");
    const ctx = fx.ctx();
    await moneyTx(ctx.db, (tx) => applyKycUpdate(tx, {
      userId: player.userId, providerKey: "sandbox-kyc", now: fx.now(),
      update: { applicantRef: "app_1", userId: null, decision: "VERIFIED", final: true, rejectReason: null, level: null, occurredAt: fx.now(), screening: "CLEAR", identity: { firstName: "Test", lastName: "Player", birthDate: "1990-01-01", country: "MT" } },
    }), { label: "test" });
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).screeningStatus).toBe("POTENTIAL_MATCH");
  });
});

describe("deposits under review", () => {
  async function underpaid(fx: Fixture, amount: string): Promise<{ player: Player; depositId: string }> {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount, payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    const envelope = await applySandboxOutcome(sandboxOptions(fx), row.providerPaymentId!, "underpay");
    expect((await deliver(fx, ctx, "sandbox-crypto", envelope!)).status).toBe(200);
    await fx.flush();
    return { player, depositId: start.deposit.id };
  }

  const resolve = async (fx: Fixture, a: Player, depositId: string, creditAmount: string, ctx: PaymentsContext = fx.ctx()) => {
    const minor = BigInt(creditAmount.replace(".", ""));
    return resolveDeposit(ctx, { ...a.caller, accessJwt: null }, depositId, {
      action: "CREDIT", creditAmount, note: "statement checked", stepUpGrantId: await adminGrantFor(fx, a, `deposit:${depositId}`, `CREDIT:${minor}`),
    });
  };

  dbTest("a credit is capped at what the provider reported (the 1000x credit of a single admin is refused)", async (fx) => {
    const { player, depositId } = await underpaid(fx, "100.00");
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect([row.status, row.reportedMinor]).toEqual(["NEEDS_REVIEW", 5000n]);
    const reviewer = await newAdmin(fx);
    const refused = await refusal(resolve(fx, reviewer, depositId, "100.00"));
    expect(refused.code).toBe("VALIDATION");
    expect(refused.details).toEqual({ max: "50.00" });
    expect((await refusal(resolve(fx, reviewer, depositId, "5000.00"))).code).toBe("VALIDATION");
    const done = await resolve(fx, reviewer, depositId, "50.00");
    expect(done.approvalsRemaining).toBe(0);
    expect(done.deposit.status).toBe("CREDITED");
    expect(await balances(fx, player.userId)).toEqual({ available: 5000n, held: 0n });
  });

  dbTest("in live mode a credit waits for a second administrator naming the same amount", async (fx) => {
    const { player, depositId } = await underpaid(fx, "80.00");
    const live = (): PaymentsContext => { const ctx = fx.ctx(); return { ...ctx, config: { ...ctx.config, mode: "live" } }; };
    const first = await newAdmin(fx);
    const second = await newAdmin(fx);
    const start = await resolve(fx, first, depositId, "40.00", live());
    expect(start.approvalsRemaining).toBe(1);
    expect(start.deposit.status).toBe("NEEDS_REVIEW");
    expect((await refusal(resolve(fx, first, depositId, "40.00", live()))).code).toBe("ALREADY_APPROVED");
    // Another amount is another decision: it does not count towards this one.
    expect((await resolve(fx, second, depositId, "30.00", live())).approvalsRemaining).toBe(1);
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("NEEDS_REVIEW");
    const done = await resolve(fx, second, depositId, "40.00", live());
    expect(done.approvalsRemaining).toBe(0);
    expect(done.deposit.status).toBe("CREDITED");
    expect(await balances(fx, player.userId)).toEqual({ available: 4000n, held: 0n });
  });

  dbTest("the database refuses a credit above the ceiling, whatever the application asked", async (fx) => {
    const { depositId } = await underpaid(fx, "100.00");
    await expect(fx.payments.deposit.update({ where: { id: depositId }, data: { status: "CONFIRMED", creditedMinor: 5001n, confirmedAt: new Date() } })).rejects.toThrow(/PAYMENT_MISMATCH|PM006/);
    await expect(fx.payments.deposit.update({ where: { id: depositId }, data: { reportedMinor: 999_999n } })).rejects.toThrow(/PAYMENT_IMMUTABLE_FIELD|PM002/);
  });

  dbTest("an administrator on a security hold cannot sign a payment decision", async (fx) => {
    const { depositId } = await underpaid(fx, "60.00");
    const held = await newAdmin(fx);
    await fx.runtime.user.update({ where: { id: held.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } });
    expect((await refusal(resolve(fx, held, depositId, "30.00"))).code).toBe("SECURITY_HOLD");
    expect((await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).status).toBe("NEEDS_REVIEW");
  });
});

describe("provider URLs reach the browser only on the provider's declared hosts", () => {
  dbTest("a card session on another host is refused and nothing is stored", async (fx) => {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const card = ctx.providers.card!;
    const evil: PaymentsContext = {
      ...ctx,
      providers: {
        ...ctx.providers,
        card: { ...card, createDepositSession: async () => ({ kind: "ok" as const, value: { type: "REDIRECT" as const, providerPaymentId: null, url: "https://evil.example/pay", expiresAt: new Date(Date.now() + 60_000) } }) },
      },
    };
    await expect(createDeposit(evil, player.caller, await user(fx, player.caller), { method: "CARD", amount: "10.00", clientRequestId: crypto.randomUUID() })).rejects.toBeInstanceOf(ProviderUnavailable);
    const row = await fx.payments.deposit.findFirstOrThrow({ where: { userId: player.userId } });
    expect([row.status, row.hostedUrl]).toEqual(["CREATED", null]);
  });
});

describe("the dispatcher re-reads the player before it sends", () => {
  const code = (fx: Fixture, key: string) => fx.store.get<number>(`count:create:${key}`);

  dbTest("an admin freeze cancels an approved payout in the same transaction, and nothing is sent", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "22.00");
    const staff = await newAdmin(fx);
    await setRestriction(fx.ctx(), { ...staff.caller, accessJwt: null }, player.userId, {
      restriction: "FROZEN", reason: "fraud report", stepUpGrantId: await adminGrantFor(fx, staff, `user:${player.userId}`, "RESTRICT:FROZEN"),
    });
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("CANCELLED");
    expect(await dispatchStatus(fx, w.id)).toBe("CANCELLED");
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
    expect(await code(fx, w.key)).toBeNull();
  });

  for (const [name, spoil, expected] of [
    ["a security hold (a lockdown payments has not heard of)", async (fx: Fixture, p: Player) => { await fx.runtime.user.update({ where: { id: p.userId }, data: { securityHoldUntil: new Date(Date.now() + 3_600_000) } }); }, "SECURITY_HOLD"],
    ["a freeze written behind the admin route", async (fx: Fixture, p: Player) => { await fx.payments.playerCompliance.update({ where: { userId: p.userId }, data: { restriction: "FROZEN", restrictionReason: "TEST" } }); }, "ACCOUNT_FROZEN"],
    ["a screening result that is no longer clear", async (fx: Fixture, p: Player) => { await fx.payments.playerCompliance.update({ where: { userId: p.userId }, data: { screeningStatus: "CONFIRMED_MATCH" } }); }, "SCREENING_HIT"],
  ] as const) {
    dbTest(`${name}: an approved payout is cancelled before any send`, async (fx) => {
      const player = await newPlayer(fx);
      await cardDeposit(fx, player, "60.00");
      const w = await approvedWithdrawal(fx, player, "23.00");
      await spoil(fx, player);
      expect(await dispatchUntilMoved(fx, w.id, ["PENDING"])).toBe("CANCELLED");
      const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
      expect([row.status, row.failureCode]).toEqual(["CANCELLED", expected]);
      expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
      expect(await code(fx, w.key)).toBeNull();
    });
  }

  dbTest("WITHDRAWALS_MANUAL set after an approval stops it; an approval after the restriction goes through", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const before = await approvedWithdrawal(fx, player, "24.00");
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { restriction: "WITHDRAWALS_MANUAL", restrictionReason: "TEST", restrictedAt: fx.now() } });
    expect(await dispatchUntilMoved(fx, before.id, ["PENDING"])).toBe("CANCELLED");
    const after = await approvedWithdrawal(fx, player, "25.00");
    expect(await dispatchUntilMoved(fx, after.id, ["PENDING", "IN_FLIGHT"])).toBe("COMPLETED");
  });

  dbTest("a send that was already attempted goes to a person (MANUAL, CRITICAL issue), not out again", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    // Cents .03: lost on the way; two NOT_FOUND answers later it is due to be sent again.
    const w = await approvedWithdrawal(fx, player, "20.03");
    const base = fx.clock.offsetMs;
    try {
      await dispatchUntilAttempts(fx, w.id, 1);
      fx.clock.offsetMs = base + 2 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 2);
      fx.clock.offsetMs = base + 8 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 3);
      fx.clock.offsetMs = base + 24 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 4);
      expect(await dispatchStatus(fx, w.id)).toBe("RETRY_WAIT");
      await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { restriction: "FROZEN", restrictionReason: "TEST" } });
      expect(await dispatchUntilMoved(fx, w.id, ["RETRY_WAIT"])).toBe("MANUAL");
    } finally {
      fx.clock.offsetMs = base;
    }
    expect(await code(fx, w.key)).toBe(1);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("SUBMITTED");
    expect(await balances(fx, player.userId)).toEqual({ available: 3997n, held: 2003n });
    expect((await fx.payments.reconciliationIssue.findFirstOrThrow({ where: { code: "PAYOUT_MANUAL", subjectId: w.id } })).details).toMatchObject({ reason: "ACCOUNT_FROZEN" });
  });

  dbTest("a refund to source still goes out for a frozen account (it is how the money goes back)", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "40.00");
    // The second payment was under way when the account was frozen: it is credited and refund-held.
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CARD", amount: "20.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    await fx.payments.playerCompliance.update({ where: { userId: player.userId }, data: { restriction: "FROZEN", restrictionReason: "TEST" } });
    const envelope = await applySandboxOutcome(sandboxOptions(fx), row.providerPaymentId!, "approve");
    expect((await deliver(fx, ctx, "sandbox-card", envelope!)).status).toBe(200);
    await fx.flush();
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    expect(await dispatchUntilMoved(fx, refund.id, ["PENDING", "IN_FLIGHT"])).toBe("COMPLETED");
  });

  dbTest("a screening hit from the KYC provider cancels unsent withdrawals, refunds included, and a confirmed match freezes", async (fx) => {
    const player = await newPlayer(fx, { verified: false, limitsChosen: true });
    const u = await user(fx, player.caller);
    const session = await startKyc(fx.ctx(), u, "MT");
    const compliance = await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } });
    // Providers get an opaque reference: the result finds the player through the bound applicant.
    expect(compliance.kycApplicantRef).toMatch(/^sbx_app_/);
    expect(session.sdkToken).not.toContain(player.userId);
    const options = sandboxOptions(fx);
    const identity = { firstName: "Test", lastName: "Player", birthDate: "1990-01-01", country: "MT" };
    const kyc = async (screening: "CLEAR" | "CONFIRMED_MATCH") => {
      const envelope = await applySandboxKyc(options, compliance.kycApplicantRef!, { decision: "VERIFIED", identity, screening });
      const ctx = fx.ctx();
      expect((await deliver(fx, ctx, "sandbox-kyc", envelope!)).status).toBe(200);
      await fx.flush();
    };
    await kyc("CLEAR");
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).kycStatus).toBe("VERIFIED");
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "26.00");
    await kyc("CONFIRMED_MATCH");
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect([row.status, row.failureCode]).toEqual(["CANCELLED", "SCREENING_HIT"]);
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).restriction).toBe("FROZEN");
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
  });

  dbTest("a Worker never touches a queued payout of a provider it does not serve", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "27.00");
    const ctx = fx.ctx();
    const elsewhere: PaymentsContext = { ...ctx, providers: { ...ctx.providers, card: null } };
    for (let i = 0; i < 5; i += 1) await dispatchOne(elsewhere);
    const dispatch = await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: w.id } });
    expect([dispatch.status, dispatch.attempts]).toEqual(["PENDING", 0]);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("APPROVED");
    expect(await dispatchUntilMoved(fx, w.id, ["PENDING", "IN_FLIGHT"], 30)).toBe("COMPLETED");
  });
});

describe("travel-rule information requests", () => {
  async function infoEvent(fx: Fixture, deposit: { providerPaymentId: string | null }): Promise<string> {
    const rows = await fx.payments.$queryRaw<{ id: string }[]>`
      INSERT INTO public."PaymentEvent" ("provider", "providerEventId", "eventType", "objectType", "objectRef", "payloadSha256", "payload", "signatureScheme", "signatureVerified")
      VALUES ('sandbox-crypto', ${`info-${crypto.randomUUID()}`}, 'compliance.information-request', 'PAYMENT', NULL, ${"0".repeat(64)},
              ${JSON.stringify({ _n: { kind: "info", externalId: crypto.randomUUID(), providerPaymentId: deposit.providerPaymentId } })}::jsonb, 'test', true)
      RETURNING "id"::text AS id`;
    return rows[0]!.id;
  }

  dbTest("a refused answer raises a CRITICAL issue and the event needs review; an accepted one is applied", async (fx) => {
    const player = await newPlayer(fx);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount: "30.00", payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
    const row = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    const crypto2 = ctx.providers.crypto!;
    const refusing: PaymentsContext = { ...ctx, providers: { ...ctx.providers, crypto: { ...crypto2, answerInformationRequest: async () => ({ kind: "rejected" as const, final: false, code: "ADDRESS_REQUIRED", message: "no address" }) } } };
    const event = await infoEvent(fx, row);
    expect(await processEvent(refusing, event)).toBe("NEEDS_REVIEW");
    expect((await fx.payments.reconciliationIssue.findFirstOrThrow({ where: { code: "TRAVEL_RULE_UNANSWERED", subjectId: event } })).details).toMatchObject({ reason: "ADDRESS_REQUIRED", userId: player.userId });

    const answering: PaymentsContext = { ...ctx, providers: { ...ctx.providers, crypto: { ...crypto2, answerInformationRequest: async () => ({ kind: "ok" as const, value: null }) } } };
    const fine = await infoEvent(fx, row);
    expect(await processEvent(answering, fine)).toBe("APPLIED");
    expect(await fx.payments.reconciliationIssue.count({ where: { code: "TRAVEL_RULE_UNANSWERED", subjectId: fine } })).toBe(0);
  });

  dbTest("no provider method or no known deposit is unanswered too", async (fx) => {
    const event = await infoEvent(fx, { providerPaymentId: "unknown-payment" });
    expect(await processEvent(fx.ctx(), event)).toBe("NEEDS_REVIEW");
    expect((await fx.payments.reconciliationIssue.findFirstOrThrow({ where: { code: "TRAVEL_RULE_UNANSWERED", subjectId: event } })).details).toMatchObject({ reason: "DEPOSIT_UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// Payout faults, disputes after a payout, deposit limits and self-exclusion.
// In this file on purpose: the sandbox store is per fixture (per file), and a
// dispatch unit picks any due row, so a second file's dispatcher would answer
// this file's payouts from the wrong store.
// ---------------------------------------------------------------------------

async function dispatchUntilAttempts(fx: Fixture, withdrawalId: string, n: number, max = 15): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await fx.payments.payoutAttempt.count({ where: { withdrawalId } }) >= n) break;
    if (!(await dispatchOne(fx.ctx()))) break;
  }
  expect(await fx.payments.payoutAttempt.count({ where: { withdrawalId } })).toBe(n);
}

const dispatchStatus = async (fx: Fixture, withdrawalId: string) => (await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId } })).status;

/** Σ balance of a house account type (all providers), minor units. */
async function houseBalance(fx: Fixture, type: string, asset = "TEST_EUR"): Promise<bigint> {
  const rows = await fx.payments.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM("balance"), 0)::text AS balance FROM public."LedgerAccount" WHERE "type"::text = ${type} AND "assetCode" = ${asset}`;
  return BigInt(rows[0]?.balance ?? "0");
}

/** A deposit limit as poker-api writes it (runtime login; the database sets effectiveFrom). */
async function setDepositLimit(fx: Fixture, player: Player, period: "DAY" | "WEEK" | "MONTH", amountMinor: bigint | null): Promise<{ id: string; effectiveFrom: Date; cancelledAt: Date | null }> {
  const row = await fx.runtime.responsibleGamingLimit.create({
    data: { userId: player.userId, kind: "DEPOSIT", period, assetCode: "EUR", amountMinor, source: "PLAYER", createdBy: player.userId },
    select: { id: true },
  }) as { id: string };
  return limitRow(fx, row.id);
}

const limitRow = (fx: Fixture, id: string) => fx.payments.responsibleGamingLimit.findUniqueOrThrow({ where: { id }, select: { id: true, effectiveFrom: true, cancelledAt: true } });

describe("payout faults", () => {
  dbTest("a declined payout fails and releases the hold back to the player", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    // Cents .01: the sandbox declines the payout.
    const w = await approvedWithdrawal(fx, player, "20.01");
    expect(await dispatchUntilMoved(fx, w.id, ["PENDING", "IN_FLIGHT"])).toBe("FAILED");
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.status).toBe("FAILED");
    expect(row.releaseTxId).not.toBeNull();
    expect(row.settleTxId).toBeNull();
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
    expect(await fx.payments.emailOutbox.count({ where: { userId: player.userId, template: "withdrawal-failed" } })).toBe(1);
  });

  dbTest("a payout lost on the way is queried; only two NOT_FOUND answers 10 minutes apart allow a re-send, with the same key", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    // Cents .03: the first create "never arrives" (a timeout); the provider knows nothing of it.
    const w = await approvedWithdrawal(fx, player, "20.03");
    const base = fx.clock.offsetMs;
    try {
      await dispatchUntilAttempts(fx, w.id, 1);
      expect(await dispatchStatus(fx, w.id)).toBe("UNCERTAIN");
      fx.clock.offsetMs = base + 2 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 2);
      expect(await dispatchStatus(fx, w.id)).toBe("UNCERTAIN");
      // Six minutes after the first NOT_FOUND: too soon to send again.
      fx.clock.offsetMs = base + 8 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 3);
      expect(await dispatchStatus(fx, w.id)).toBe("UNCERTAIN");
      expect(await fx.store.get<number>(`count:create:${w.key}`)).toBe(1);
      // Sixteen minutes after the second: safe to send again, with the same key.
      fx.clock.offsetMs = base + 24 * 60_000;
      await dispatchUntilAttempts(fx, w.id, 4);
      expect(await dispatchStatus(fx, w.id)).toBe("RETRY_WAIT");
      // The hold never moved while the outcome was unknown.
      expect(await balances(fx, player.userId)).toEqual({ available: 3997n, held: 2003n });
      await dispatchUntilAttempts(fx, w.id, 5);
    } finally {
      fx.clock.offsetMs = base;
    }
    expect(await dispatchStatus(fx, w.id)).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("SETTLED");
    const attempts = await fx.payments.payoutAttempt.findMany({ where: { withdrawalId: w.id }, orderBy: { seq: "asc" } });
    expect(attempts.map((a) => `${a.action}:${a.outcome}`)).toEqual(["CREATE:UNCERTAIN", "QUERY:NOT_FOUND", "QUERY:NOT_FOUND", "QUERY:NOT_FOUND", "CREATE:COMPLETED"]);
    expect(await fx.store.get<number>(`count:create:${w.key}`)).toBe(2);
    expect(await balances(fx, player.userId)).toEqual({ available: 3997n, held: 0n });
  });

  dbTest("after 24 hours of uncertainty the payout is MANUAL with a CRITICAL issue; two different admins resolve it", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "20.03");
    const base = fx.clock.offsetMs;
    try {
      await dispatchUntilAttempts(fx, w.id, 1);
      fx.clock.offsetMs = base + 25 * 3_600_000;
      expect(await dispatchUntilMoved(fx, w.id, ["UNCERTAIN", "IN_FLIGHT"])).toBe("MANUAL");
    } finally {
      fx.clock.offsetMs = base;
    }
    const issue = await fx.payments.reconciliationIssue.findFirstOrThrow({ where: { code: "PAYOUT_MANUAL", subjectId: w.id } });
    expect(issue.severity).toBe("CRITICAL");
    // Nothing moved: still submitted, still held, never re-sent.
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("SUBMITTED");
    expect((await balances(fx, player.userId)).held).toBe(2003n);
    expect(await fx.store.get<number>(`count:create:${w.key}`)).toBe(1);

    const first = await newAdmin(fx);
    const second = await newAdmin(fx);
    const resolve = (a: Player) => adminGrantFor(fx, a, `withdrawal:${w.id}`, "RESOLVE_FAILED")
      .then((grant) => resolveUncertain(fx.ctx(), { ...a.caller, accessJwt: null }, w.id, { outcome: "FAILED", evidence: { statementLine: "not on the provider statement" }, stepUpGrantId: grant }));
    expect((await refusal(resolveUncertain(fx.ctx(), { ...first.caller, accessJwt: null }, w.id, { outcome: "FAILED", evidence: {}, stepUpGrantId: "x" }))).code).toBe("VALIDATION");
    expect((await resolve(first)).approvalsRemaining).toBe(1);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("SUBMITTED");
    expect((await refusal(resolve(first))).code).toBe("ALREADY_APPROVED");
    expect((await resolve(second)).approvalsRemaining).toBe(0);
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("FAILED");
    expect(await dispatchStatus(fx, w.id)).toBe("FAILED");
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
  });

  dbTest("a payout the provider returns after paying it comes back to the available balance once", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    // Cents .05: paid, then returned a minute later.
    const w = await approvedWithdrawal(fx, player, "20.05");
    expect(await dispatchUntilMoved(fx, w.id, ["PENDING", "IN_FLIGHT"])).toBe("COMPLETED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("SETTLED");
    expect(await balances(fx, player.userId)).toEqual({ available: 3995n, held: 0n });
    const payout = await fx.store.get<{ id: string }>(`po:${w.key}`);
    expect(payout).not.toBeNull();
    const base = fx.clock.offsetMs;
    try {
      fx.clock.offsetMs = base + 2 * 60_000;
      const ctx = fx.ctx();
      const envelope = { eventId: `sbx_evt_ret_${crypto.randomUUID().slice(0, 8)}`, type: "payout.returned", createdAt: fx.now().toISOString(), data: { objectType: "PAYOUT" as const, id: payout!.id } };
      expect((await deliver(fx, ctx, "sandbox-card", envelope)).status).toBe(200);
      expect((await deliver(fx, ctx, "sandbox-card", { ...envelope, eventId: `${envelope.eventId}_again` })).status).toBe(200);
      await fx.flush();
    } finally {
      fx.clock.offsetMs = base;
    }
    const row = await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.status).toBe("RETURNED");
    expect(row.returnTxId).not.toBeNull();
    expect(await balances(fx, player.userId)).toEqual({ available: 6000n, held: 0n });
  });

  dbTest("three dispatch units at once claim a payout once: one provider call, one attempt", async (fx) => {
    const player = await newPlayer(fx);
    await cardDeposit(fx, player, "60.00");
    const w = await approvedWithdrawal(fx, player, "21.00");
    for (let i = 0; i < 8 && (await dispatchStatus(fx, w.id)) !== "COMPLETED"; i += 1) {
      await Promise.all([dispatchOne(fx.ctx()), dispatchOne(fx.ctx()), dispatchOne(fx.ctx())]);
    }
    expect(await dispatchStatus(fx, w.id)).toBe("COMPLETED");
    expect(await fx.store.get<number>(`count:create:${w.key}`)).toBe(1);
    expect(await fx.payments.payoutAttempt.count({ where: { withdrawalId: w.id } })).toBe(1);
    expect(await balances(fx, player.userId)).toEqual({ available: 3900n, held: 0n });
  });
});

describe("disputes after a payout", () => {
  dbTest("a chargeback cancels the open withdrawal first, takes what the balance covers and books the rest as a loss; a won dispute gives the player's part back", async (fx) => {
    const player = await newPlayer(fx);
    const depositId = await cardDeposit(fx, player, "60.00");
    const paid = await approvedWithdrawal(fx, player, "30.00");
    expect(await dispatchUntilMoved(fx, paid.id, ["PENDING", "IN_FLIGHT"])).toBe("COMPLETED");
    const card = await cardOf(fx, player.userId);
    const { quoteId, grant } = await quoteAndGrant(fx, player, card, "20.00");
    const { view: open } = await requestWithdrawal(fx.ctx(), player.caller, await user(fx, player.caller), { quoteId, stepUpGrantId: grant, clientRequestId: crypto.randomUUID() });
    expect(await balances(fx, player.userId)).toEqual({ available: 1000n, held: 2000n });
    const lossesBefore = await houseBalance(fx, "CHARGEBACK_LOSSES");

    const ctx = fx.ctx();
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: depositId } })).providerPaymentId!;
    const chargeback = await applySandboxOutcome(sandboxOptions(fx), paymentId, "chargeback");
    expect((await deliver(fx, ctx, "sandbox-card", chargeback!)).status).toBe(200);
    await fx.flush();
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("CANCELLED");
    expect((await fx.payments.withdrawal.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe("SETTLED");
    const reversal = await fx.payments.depositReversal.findFirstOrThrow({ where: { depositId, kind: "CHARGEBACK" } });
    expect(reversal.amountMinor).toBe(6000n);
    expect(reversal.userPortionMinor).toBe(3000n);
    expect(reversal.lossMinor).toBe(3000n);
    expect(await balances(fx, player.userId)).toEqual({ available: 0n, held: 0n });
    const lossesAfter = await houseBalance(fx, "CHARGEBACK_LOSSES");
    expect(lossesAfter - lossesBefore === 3000n || lossesBefore - lossesAfter === 3000n).toBe(true);
    expect((await fx.payments.playerCompliance.findUniqueOrThrow({ where: { userId: player.userId } })).restriction).toBe("FROZEN");
    expect(await fx.payments.emailOutbox.count({ where: { userId: player.userId, template: "chargeback" } })).toBe(1);

    // The dispute is won: the exact inverse, pro rata, once.
    const won = { id: `sbx_dsp_won${crypto.randomUUID().slice(0, 8)}`, paymentId, kind: "CHARGEBACK_RECOVERY" as const, amountMinor: "6000", recovers: reversal.providerReversalId, createdAt: fx.now().toISOString() };
    await fx.store.put(`dsp:${won.id}`, won);
    const envelope = { eventId: `sbx_evt_won_${crypto.randomUUID().slice(0, 8)}`, type: "dispute.won", createdAt: fx.now().toISOString(), data: { objectType: "DISPUTE" as const, id: won.id } };
    expect((await deliver(fx, ctx, "sandbox-card", envelope)).status).toBe(200);
    expect((await deliver(fx, ctx, "sandbox-card", { ...envelope, eventId: `${envelope.eventId}_again` })).status).toBe(200);
    await fx.flush();
    const recovery = await fx.payments.depositReversal.findFirstOrThrow({ where: { depositId, kind: "CHARGEBACK_RECOVERY" } });
    expect(recovery.recoversReversalId).toBe(reversal.id);
    expect(recovery.userPortionMinor).toBe(3000n);
    expect(await fx.payments.depositReversal.count({ where: { depositId } })).toBe(2);
    expect(await balances(fx, player.userId)).toEqual({ available: 3000n, held: 0n });
    expect(await houseBalance(fx, "CHARGEBACK_LOSSES")).toBe(lossesBefore);
  });
});

describe("deposit limits, idempotency and self-exclusion", () => {
  dbTest("a daily limit holds under concurrent deposits; a raise waits 24 h, a cut is immediate and cancels the pending raise", async (fx) => {
    const player = await newPlayer(fx);
    const first = await setDepositLimit(fx, player, "DAY", 2500n);
    expect(Math.abs(first.effectiveFrom.getTime() - Date.now())).toBeLessThan(60_000);
    const u = await user(fx, player.caller);
    const deposit = (amount: string) => createDeposit(fx.ctx(), player.caller, u, { method: "CARD", amount, clientRequestId: crypto.randomUUID() });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => deposit("10.00")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { code: string }).code).toBe("DEPOSIT_LIMIT_EXCEEDED");
    const sum = await fx.payments.deposit.aggregate({ where: { userId: player.userId }, _sum: { requestedMinor: true } });
    expect(sum._sum.requestedMinor).toBe(2000n);

    const raise = await setDepositLimit(fx, player, "DAY", 10_000n);
    expect(raise.effectiveFrom.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // The old limit stays in force until then: 20 of 25 used.
    const over = await refusal(deposit("10.00"));
    expect(over.code).toBe("DEPOSIT_LIMIT_EXCEEDED");
    expect(over.details).toMatchObject({ remaining: "5.00" });

    const cut = await setDepositLimit(fx, player, "DAY", 2000n);
    expect(Math.abs(cut.effectiveFrom.getTime() - Date.now())).toBeLessThan(60_000);
    expect((await limitRow(fx, raise.id)).cancelledAt).not.toBeNull();
    expect((await refusal(deposit("10.00"))).code).toBe("DEPOSIT_LIMIT_EXCEEDED");
  });

  dbTest("the same Idempotency-Key returns the same deposit; with another body it is a conflict", async (fx) => {
    const player = await newPlayer(fx);
    const u = await user(fx, player.caller);
    const key = crypto.randomUUID();
    const a = await createDeposit(fx.ctx(), player.caller, u, { method: "CARD", amount: "15.00", clientRequestId: key });
    const b = await createDeposit(fx.ctx(), player.caller, u, { method: "CARD", amount: "15.00", clientRequestId: key });
    expect(a.replay).toBe(false);
    expect(b.replay).toBe(true);
    expect(b.start.deposit.id).toBe(a.start.deposit.id);
    expect((await refusal(createDeposit(fx.ctx(), player.caller, u, { method: "CARD", amount: "16.00", clientRequestId: key }))).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await fx.payments.deposit.count({ where: { userId: player.userId } })).toBe(1);
  });

  dbTest("a credit over the limit keeps only the part within it; a payment that lands after self-exclusion is refunded in full", async (fx) => {
    const player = await newPlayer(fx);
    await setDepositLimit(fx, player, "DAY", 3000n);
    const ctx = fx.ctx();
    const { start } = await createDeposit(ctx, player.caller, await user(fx, player.caller), { method: "CRYPTO", amount: "25.00", payAsset: "USDC_ERC20", clientRequestId: crypto.randomUUID() });
    const paymentId = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } })).providerPaymentId!;
    // The player sends half as much again (37.50 against a 30.00 daily limit).
    const overpaid = await applySandboxOutcome(sandboxOptions(fx), paymentId, "overpay" satisfies CryptoOutcome);
    expect((await deliver(fx, ctx, "sandbox-crypto", overpaid!)).status).toBe(200);
    await fx.flush();
    const credited = await fx.payments.deposit.findUniqueOrThrow({ where: { id: start.deposit.id } });
    expect(credited.status).toBe("CREDITED");
    expect(credited.creditedMinor).toBe(3750n);
    expect(credited.excessMinor).toBe(750n);
    expect(await balances(fx, player.userId)).toEqual({ available: 3000n, held: 750n });
    const refund = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: player.userId, kind: "REFUND" } });
    // Crypto goes back to its source only after review.
    expect(refund.status).toBe("UNDER_REVIEW");
    expect(refund.amountMinor).toBe(750n);

    const excluded = await newPlayer(fx);
    const u2 = await user(fx, excluded.caller);
    const { start: open } = await createDeposit(fx.ctx(), excluded.caller, u2, { method: "CARD", amount: "40.00", saveCard: true, clientRequestId: crypto.randomUUID() });
    // Self-excluded while the payment page was open (onSelfExcluded cancels open deposits; this one pays anyway).
    await fx.runtime.selfExclusion.create({
      data: { userId: excluded.userId, kind: "DEFINITE", source: "PLAYER", createdBy: excluded.userId, endsAt: new Date(Date.now() + 7 * 86_400_000) },
      select: { id: true },
    });
    const pid = (await fx.payments.deposit.findUniqueOrThrow({ where: { id: open.deposit.id } })).providerPaymentId!;
    expect((await deliver(fx, fx.ctx(), "sandbox-card", (await applySandboxOutcome(sandboxOptions(fx), pid, "approve"))!)).status).toBe(200);
    await fx.flush();
    const late = await fx.payments.deposit.findUniqueOrThrow({ where: { id: open.deposit.id } });
    expect(late.status).toBe("CREDITED");
    expect(late.excessMinor).toBe(4000n);
    expect(await balances(fx, excluded.userId)).toEqual({ available: 0n, held: 4000n });
    // Back to the same card, without a person (a SYSTEM approval and a REFUND dispatch).
    const back = await fx.payments.withdrawal.findFirstOrThrow({ where: { userId: excluded.userId, kind: "REFUND" } });
    expect(back.status).toBe("APPROVED");
    expect((await fx.payments.payoutDispatch.findUniqueOrThrow({ where: { withdrawalId: back.id } })).operation).toBe("REFUND");
    expect((await refusal(createDeposit(fx.ctx(), excluded.caller, u2, { method: "CARD", amount: "10.00", clientRequestId: crypto.randomUUID() }))).code).toBe("SELF_EXCLUDED");
  });
});

describe("database clocks", () => {
  dbTest("limit and self-exclusion times are UTC whatever the writing session's time zone (the guard triggers pin UTC)", async (fx) => {
    const player = await newPlayer(fx);
    const ids = await fx.runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL timezone = 'Pacific/Kiritimati'");
      const limit = await tx.responsibleGamingLimit.create({
        data: { userId: player.userId, kind: "DEPOSIT", period: "WEEK", assetCode: "EUR", amountMinor: 5000n, source: "PLAYER", createdBy: player.userId },
        select: { id: true },
      }) as { id: string };
      const exclusion = await tx.selfExclusion.create({
        data: { userId: player.userId, kind: "DEFINITE", source: "PLAYER", createdBy: player.userId, endsAt: new Date(Date.now() + 2 * 86_400_000) },
        select: { id: true },
      }) as { id: string };
      return { limit: limit.id, exclusion: exclusion.id };
    });
    expect(Math.abs((await limitRow(fx, ids.limit)).effectiveFrom.getTime() - Date.now())).toBeLessThan(60_000);
    const exclusion = await fx.payments.selfExclusion.findUniqueOrThrow({ where: { id: ids.exclusion }, select: { startsAt: true } });
    expect(Math.abs(exclusion.startsAt.getTime() - Date.now())).toBeLessThan(60_000);
  });
});
