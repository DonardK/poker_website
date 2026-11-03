import {
  MONEY_AMOUNT_PATTERN,
  RG_LIMIT_PERIODS,
  SELF_EXCLUSION_PERIODS,
  WALLET_DECIMALS,
  WALLET_PAGE_MAX,
  type DepositLimitPeriodView,
  type DepositLimitsResponse,
  type RgLimitPeriod,
  type SelfExclusionPeriod,
  type SelfExclusionResponse,
  type SelfExclusionStatus,
  type StepUpRequiredBody,
  type WalletErrorBody,
  type WalletSummary,
} from "@poker/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { onAccountLockdown } from "../auth/lockdown";
import { recordSecurityEvent } from "../auth/security-events";
import { revokeUserSessions } from "../auth/sessions";
import { assertNoSecurityHold } from "../auth/step-up";
import { formatMinor, parseMinor } from "../money/amounts";
import { paymentsBinding, rpcFail, type Caller, type NotMeTokenClaims, type PaymentsService, type RpcFailure, type RpcResult } from "../payments/contract";
import { NOT_ME_TTL_MS, verifyNotMe } from "../payments/emails";
import type { AppDb } from "./db";
import { defer } from "./defer";
import { authRoute, authed, clientIp, Refusal, requestFacts, type Ctx, type GateOk } from "./guard";
import { errBrief, logWarn } from "./log";
import { fanoutRevoke } from "./realtime";

/**
 * The player wallet (/api/wallet/*; docs/money/WALLET.md sections 11.1 and
 * 12). poker-api authenticates the player and forwards a Caller to the
 * poker-payments Worker over the PAYMENTS service binding; payments re-checks
 * the session, the gates and every money rule itself. Without the binding
 * (production today) the wallet is "off": GET /api/wallet shows the play
 * chips only, and every money route answers 403 REAL_MONEY_DISABLED.
 *
 * Deposit limits and self-exclusion are written here with the runtime login
 * (poker_server may insert ResponsibleGamingLimit and SelfExclusion; the
 * database sets the timing: a stricter limit now, a looser one or a removal
 * after 24 hours). Routes that create money objects need an Idempotency-Key
 * (a UUID v4). A missing step-up grant is 403 STEP_UP_REQUIRED with the
 * purpose and bind to step up for, never 401. Adding a payout address is the
 * one exception to the key: its single-use step-up grant is the idempotency
 * key of that route (a replay with the same grant answers the first result;
 * a different request with it is refused, because the grant is already spent).
 * The header is still required and is not stored.
 */

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const AMOUNT = z.string().regex(MONEY_AMOUNT_PATTERN);
const ASSET = z.string().regex(/^[A-Z0-9_]{2,20}$/);
/** Limits and exclusions are booked in EUR whatever the mode (limits.ts LIMIT_ASSET). */
const LIMIT_ASSET = "EUR";

const depositBody = z.discriminatedUnion("method", [
  z.object({ method: z.literal("CARD"), amount: AMOUNT, instrumentId: z.string().regex(OBJECT_ID).optional(), saveCard: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("CRYPTO"), amount: AMOUNT, payAsset: ASSET }).strict(),
]);
const prepareBody = z.object({ asset: ASSET, address: z.string().min(1).max(200), memo: z.string().max(100).nullable().optional() }).strict();
const addCryptoBody = z.object({
  asset: ASSET,
  address: z.string().min(1).max(200),
  memo: z.string().max(100).nullable().optional(),
  label: z.string().max(40).optional(),
  stepUpGrantId: GRANT_ID,
  ownership: z.object({ method: z.literal("MESSAGE_SIGNATURE"), message: z.string().max(500), signature: z.string().max(500) }).strict().optional(),
}).strict();
const quoteBody = z.object({ instrumentId: z.string().regex(OBJECT_ID), amount: AMOUNT }).strict();
const withdrawBody = z.object({ quoteId: z.string().regex(OBJECT_ID), stepUpGrantId: GRANT_ID }).strict();
const limitBody = z.object({ period: z.enum(RG_LIMIT_PERIODS), amount: AMOUNT.nullable() }).strict();
const exclusionBody = z.object({ period: z.enum(SELF_EXCLUSION_PERIODS) }).strict();
const notMeBody = z.object({ token: z.string().min(10).max(1024) }).strict();

const EXCLUSION_MS: Readonly<Record<Exclude<SelfExclusionPeriod, "indefinite">, number>> = {
  "24h": 86_400_000, "48h": 2 * 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000, "180d": 180 * 86_400_000, "365d": 365 * 86_400_000,
};

// ---------------------------------------------------------------------------
// Calling payments
// ---------------------------------------------------------------------------

/** What payments needs to know about this request's player. */
export function callerOf(c: Ctx, gate: GateOk): Caller {
  const facts = requestFacts(c);
  return {
    userId: gate.userId,
    sessionId: gate.sessionId,
    requestId: c.get("requestId") ?? crypto.randomUUID(),
    ip: clientIp(c),
    ipCountry: facts.country,
    userAgent: facts.userAgent,
  };
}

const NOT_LAUNCHED = () => rpcFail("REAL_MONEY_DISABLED", "Real-money play is not available yet.");

/** Thrown inside the not-me transaction to roll it back: this notice was already reported. */
class NotMeAlreadyReported extends Error {}

/** One RPC to payments. An absent binding is "off"; a dropped or failing binding is 503 PAYMENTS_UNAVAILABLE. */
export async function callPayments<T>(c: Ctx, label: string, call: (payments: PaymentsService) => Promise<unknown>): Promise<RpcResult<T>> {
  const payments = paymentsBinding(c.env);
  if (!payments) return NOT_LAUNCHED();
  try {
    const result = await call(payments) as RpcResult<T> | undefined;
    if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") throw new Error("malformed RPC answer");
    return result;
  } catch (err) {
    logWarn({ ...errBrief(err), rpc: label }, "payments RPC failed; answered 503");
    return rpcFail("PAYMENTS_UNAVAILABLE", "Payments are temporarily unavailable. Please try again.", { retryable: true });
  }
}

/** The documented error body: { error, code, details?, retryable? } (+ purpose, bind, methods for a step-up). */
export function failureResponse(c: Ctx, failure: RpcFailure): Response {
  const body: WalletErrorBody | StepUpRequiredBody = failure.code === "STEP_UP_REQUIRED" && failure.stepUp
    ? { error: failure.message, code: "STEP_UP_REQUIRED", ...failure.stepUp }
    : { error: failure.message, code: failure.code };
  if (failure.details) body.details = failure.details;
  if (failure.retryable) body.retryable = true;
  if (failure.status === 503) c.header("Retry-After", "5");
  if (failure.status === 429) c.header("Retry-After", "60");
  return c.json(body, failure.status);
}

function respond<T>(c: Ctx, result: RpcResult<T>, ok: (value: T) => Response): Response {
  return result.ok ? ok(result.value) : failureResponse(c, result);
}

function invalid(c: Ctx, message = "Check the details and try again."): Response {
  return c.json({ error: message, code: "VALIDATION" }, 422);
}

/** Idempotency-Key header (UUID v4), or the 400 response. */
function idempotencyKey(c: Ctx): string | Response {
  const key = c.req.header("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) return c.json({ error: "Send an Idempotency-Key header (a UUID v4) with this request.", code: "IDEMPOTENCY_KEY_REQUIRED" }, 400);
  return key.toLowerCase();
}

function pageQuery(c: Ctx): { cursor?: string; limit?: number } {
  const cursor = c.req.query("cursor");
  const limit = Number(c.req.query("limit"));
  return {
    ...(cursor && cursor.length <= 200 ? { cursor } : {}),
    ...(Number.isInteger(limit) && limit >= 1 ? { limit: Math.min(limit, WALLET_PAGE_MAX) } : {}),
  };
}

/** A money action that consumes a step-up grant: a verified email and no security hold, before payments is even asked. */
function moneyPrecheck(c: Ctx, gate: GateOk): Response | null {
  if (gate.user.emailVerifiedAt == null) return c.json({ error: "Confirm your email address first.", code: "EMAIL_NOT_VERIFIED" }, 403);
  return assertNoSecurityHold(c, gate.user);
}

// ---------------------------------------------------------------------------
// Deposit limits (runtime login; the database sets the timing)
// ---------------------------------------------------------------------------

interface LimitRow {
  period: RgLimitPeriod;
  amountMinor: bigint | null;
  effectiveFrom: Date;
  requestedAt: Date;
}

const asMoney = (minor: bigint | null) => (minor === null ? null : formatMinor(BigInt(minor), WALLET_DECIMALS));

export async function depositLimitsView(db: AppDb, userId: string, now = Date.now()): Promise<DepositLimitsResponse> {
  const rows = await db.responsibleGamingLimit.findMany({
    where: { userId, kind: "DEPOSIT", assetCode: LIMIT_ASSET, cancelledAt: null },
    orderBy: { effectiveFrom: "desc" },
    take: 60,
    select: { period: true, amountMinor: true, effectiveFrom: true, requestedAt: true },
  }) as LimitRow[];
  const deposit = {} as Record<RgLimitPeriod, DepositLimitPeriodView>;
  for (const period of RG_LIMIT_PERIODS) {
    const mine = rows.filter((row) => row.period === period).sort((a, b) =>
      new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime() || new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
    const active = mine.find((row) => new Date(row.effectiveFrom).getTime() <= now) ?? null;
    const pending = mine.find((row) => new Date(row.effectiveFrom).getTime() > now) ?? null;
    deposit[period] = {
      active: active ? asMoney(active.amountMinor) : null,
      pending: pending ? { amount: asMoney(pending.amountMinor), effectiveFrom: new Date(pending.effectiveFrom).toISOString() } : null,
    };
  }
  return { deposit };
}

// ---------------------------------------------------------------------------
// Self-exclusion: in force until access is restored, whatever endsAt says
// ---------------------------------------------------------------------------

interface ExclusionRow {
  id: string;
  kind: "DEFINITE" | "INDEFINITE";
  endsAt: Date | null;
  reactivationRequestedAt: Date | null;
  accessRestoredAt: Date | null;
}

const EXCLUSION_SELECT = { id: true, kind: true, endsAt: true, reactivationRequestedAt: true, accessRestoredAt: true } as const;
const isoOf = (date: Date | null) => (date ? new Date(date).toISOString() : null);
const latest = (dates: (Date | null)[]) => dates.reduce<Date | null>((best, date) => (date && (!best || new Date(date).getTime() > new Date(best).getTime()) ? date : best), null);

async function exclusionsInForce(db: AppDb, userId: string, now: number): Promise<ExclusionRow[]> {
  const rows = await db.selfExclusion.findMany({ where: { userId }, orderBy: { startsAt: "desc" }, take: 50, select: EXCLUSION_SELECT }) as ExclusionRow[];
  return rows.filter((row) => row.accessRestoredAt === null || new Date(row.accessRestoredAt).getTime() > now);
}

const stillRunning = (row: ExclusionRow, now: number) => row.kind === "DEFINITE" && new Date(row.endsAt!).getTime() > now;

export async function selfExclusionStatus(db: AppDb, userId: string, now = Date.now()): Promise<SelfExclusionStatus> {
  const rows = await exclusionsInForce(db, userId, now);
  if (rows.length === 0) return { active: false, kind: null, endsAt: null, canRequestReturn: false, requestedAt: null, accessRestoredAt: null };
  const indefinite = rows.some((row) => row.kind === "INDEFINITE");
  const unasked = rows.filter((row) => row.reactivationRequestedAt === null);
  return {
    active: true,
    kind: indefinite ? "INDEFINITE" : "DEFINITE",
    endsAt: indefinite ? null : isoOf(latest(rows.map((row) => row.endsAt))),
    canRequestReturn: unasked.length > 0 && !rows.some((row) => stillRunning(row, now)),
    requestedAt: unasked.length > 0 ? null : isoOf(latest(rows.map((row) => row.reactivationRequestedAt))),
    accessRestoredAt: rows.every((row) => row.accessRestoredAt !== null) ? isoOf(latest(rows.map((row) => row.accessRestoredAt))) : null,
  };
}

/**
 * The player asks to come back. A timed exclusion must have ended; access then
 * returns 24 hours after the request. An indefinite one waits for an
 * administrator, then 7 days. The database sets every time (the
 * self_exclusion_guard trigger), and refuses a timed one that has not ended.
 */
export async function requestReactivation(db: AppDb, userId: string, now = Date.now()): Promise<{ status: SelfExclusionStatus } | { code: "INVALID_STATE" | "EXCLUSION_NOT_ENDED"; endsAt?: string }> {
  const rows = await exclusionsInForce(db, userId, now);
  if (rows.length === 0) return { code: "INVALID_STATE" };
  const running = rows.filter((row) => stillRunning(row, now));
  if (running.length > 0) return { code: "EXCLUSION_NOT_ENDED", endsAt: isoOf(latest(running.map((row) => row.endsAt)))! };
  const unasked = rows.filter((row) => row.reactivationRequestedAt === null);
  await db.$transaction(async (tx) => {
    for (const row of unasked) await tx.selfExclusion.update({ where: { id: row.id }, data: { reactivationRequestedAt: new Date(now) }, select: { id: true } });
  });
  return { status: await selfExclusionStatus(db, userId, now) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerWallet(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/wallet", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const play = { chips: gate.user.bankroll, redeemable: false as const };
    if (!paymentsBinding(c.env)) return c.json({ mode: "off", realMoney: null, play } satisfies WalletSummary);
    const result = await callPayments<{ mode: WalletSummary["mode"]; realMoney: WalletSummary["realMoney"] }>(c, "summary", (p) => p.realMoneySummary(callerOf(c, gate)));
    return respond(c, result, (value) => c.json({ mode: value.mode, realMoney: value.mode === "off" ? null : value.realMoney, play } satisfies WalletSummary));
  }));

  app.get("/api/wallet/transactions", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    if (!paymentsBinding(c.env)) return c.json({ items: [], next: null });
    return respond(c, await callPayments(c, "transactions", (p) => p.listTransactions(callerOf(c, gate), pageQuery(c))), (page) => c.json(page));
  }));

  app.post("/api/wallet/deposits", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = depositBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Enter an amount like 50.00 and a payment method.");
    const result = await callPayments<{ deposit: unknown; next: unknown; replay: boolean }>(c, "deposit.create", (p) => p.createDeposit(callerOf(c, gate), { ...parsed.data, clientRequestId: key }));
    return respond(c, result, ({ replay, ...start }) => c.json(start, replay ? 200 : 201));
  }));

  app.get("/api/wallet/deposits/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    if (!OBJECT_ID.test(id)) return c.json({ error: "That deposit does not exist.", code: "NOT_FOUND" }, 404);
    return respond(c, await callPayments(c, "deposit.get", (p) => p.getDeposit(callerOf(c, gate), id)), (deposit) => c.json({ deposit }));
  }));

  app.post("/api/wallet/deposits/:id/cancel", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    if (!OBJECT_ID.test(id)) return c.json({ error: "That deposit does not exist.", code: "NOT_FOUND" }, 404);
    return respond(c, await callPayments(c, "deposit.cancel", (p) => p.cancelDeposit(callerOf(c, gate), id)), (deposit) => c.json({ deposit }));
  }));

  app.get("/api/wallet/instruments", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    if (!paymentsBinding(c.env)) return c.json({ instruments: [] });
    return respond(c, await callPayments(c, "instruments.list", (p) => p.listInstruments(callerOf(c, gate))), (instruments) => c.json({ instruments }));
  }));

  app.post("/api/wallet/instruments/crypto/prepare", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = prepareBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Enter the currency and the address.");
    return respond(c, await callPayments(c, "instruments.prepare", (p) => p.prepareCryptoDestination(callerOf(c, gate), parsed.data)), (value) => c.json(value));
  }));

  app.post("/api/wallet/instruments/crypto", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = addCryptoBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Enter the currency and the address, then confirm it's you.");
    const pre = moneyPrecheck(c, gate);
    if (pre) return pre;
    const result = await callPayments<{ instrument: unknown; replay: boolean }>(c, "instruments.add", (p) => p.addCryptoDestination(callerOf(c, gate), { ...parsed.data, clientRequestId: key }));
    return respond(c, result, ({ instrument, replay }) => c.json({ instrument }, replay ? 200 : 201));
  }));

  app.delete("/api/wallet/instruments/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    if (!OBJECT_ID.test(id)) return c.json({ error: "That payout destination does not exist.", code: "NOT_FOUND" }, 404);
    return respond(c, await callPayments(c, "instruments.revoke", (p) => p.revokeInstrument(callerOf(c, gate), id)), () => c.body(null, 204));
  }));

  app.post("/api/wallet/withdrawals/quote", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = quoteBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Choose a destination and an amount like 50.00.");
    return respond(c, await callPayments(c, "withdrawal.quote", (p) => p.quoteWithdrawal(callerOf(c, gate), parsed.data)), (value) => c.json(value));
  }));

  app.post("/api/wallet/withdrawals", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = withdrawBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Get a new quote and confirm it's you.");
    const pre = moneyPrecheck(c, gate);
    if (pre) return pre;
    const result = await callPayments<{ withdrawal: unknown; replay: boolean }>(c, "withdrawal.request", (p) => p.requestWithdrawal(callerOf(c, gate), { ...parsed.data, clientRequestId: key }));
    return respond(c, result, ({ withdrawal, replay }) => c.json({ withdrawal }, replay ? 200 : 201));
  }));

  app.get("/api/wallet/withdrawals", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    if (!paymentsBinding(c.env)) return c.json({ withdrawals: [], next: null });
    const result = await callPayments<{ items: unknown[]; next: string | null }>(c, "withdrawal.list", (p) => p.listWithdrawals(callerOf(c, gate), pageQuery(c)));
    return respond(c, result, (page) => c.json({ withdrawals: page.items, next: page.next }));
  }));

  app.get("/api/wallet/withdrawals/:id", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    if (!OBJECT_ID.test(id)) return c.json({ error: "That withdrawal does not exist.", code: "NOT_FOUND" }, 404);
    return respond(c, await callPayments(c, "withdrawal.get", (p) => p.getWithdrawal(callerOf(c, gate), id)), (withdrawal) => c.json({ withdrawal }));
  }));

  app.post("/api/wallet/withdrawals/:id/cancel", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const id = c.req.param("id") ?? "";
    if (!OBJECT_ID.test(id)) return c.json({ error: "That withdrawal does not exist.", code: "NOT_FOUND" }, 404);
    return respond(c, await callPayments(c, "withdrawal.cancel", (p) => p.cancelWithdrawal(callerOf(c, gate), id)), (withdrawal) => c.json({ withdrawal }));
  }));

  app.post("/api/wallet/kyc/session", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    return respond(c, await callPayments(c, "kyc.start", (p) => p.startKyc(callerOf(c, gate))), (value) => c.json(value));
  }));

  app.get("/api/wallet/limits", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    return c.json(await depositLimitsView(c.get("db")!, gate.userId));
  }));

  // POST, not PUT: CORS allows GET, POST, DELETE and OPTIONS only.
  app.post("/api/wallet/limits", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = limitBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Choose a period and an amount like 100.00, or no limit.");
    const db: AppDb = c.get("db")!;
    const { period, amount } = parsed.data;
    const current = (await depositLimitsView(db, gate.userId)).deposit[period];
    const amountMinor = amount === null ? null : parseMinor(amount, WALLET_DECIMALS);
    if (amountMinor !== null && amountMinor <= 0n) return invalid(c, "Enter a limit above zero, or choose no limit. To stop depositing for a while, take a break instead.");
    // "No limit" with nothing in force and nothing pending records only the choice.
    const nothingToRemove = amountMinor === null && current.active === null && current.pending === null;
    if (!nothingToRemove) {
      try {
        await db.responsibleGamingLimit.create({
          data: { userId: gate.userId, kind: "DEPOSIT", period, assetCode: LIMIT_ASSET, amountMinor, source: "PLAYER", createdBy: gate.userId },
          select: { id: true },
        });
      } catch (err) {
        logWarn({ ...errBrief(err), userId: gate.userId }, "deposit limit could not be saved");
        return c.json({ error: "Your limit could not be saved. Please try again.", code: "PAYMENTS_UNAVAILABLE", retryable: true }, 503);
      }
    }
    // The first choice unlocks deposits (LIMITS_SETUP_REQUIRED); payments records it. Best effort: it is asked again otherwise.
    if (paymentsBinding(c.env)) {
      const marked = await callPayments(c, "limits.prompted", (p) => p.markLimitsPrompted(callerOf(c, gate)));
      if (!marked.ok && marked.code !== "REAL_MONEY_DISABLED") logWarn({ userId: gate.userId, code: marked.code }, "limits choice not recorded by payments");
    }
    return c.json(await depositLimitsView(db, gate.userId));
  }));

  app.post("/api/account/self-exclusion", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const parsed = exclusionBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return invalid(c, "Choose how long to take a break for.");
    const db: AppDb = c.get("db")!;
    const period = parsed.data.period;
    const startsAt = new Date();
    const endsAt = period === "indefinite" ? null : new Date(startsAt.getTime() + EXCLUSION_MS[period]);
    const row = await db.selfExclusion.create({
      data: { userId: gate.userId, kind: endsAt ? "DEFINITE" : "INDEFINITE", source: "PLAYER", createdBy: gate.userId, endsAt },
      select: { id: true, kind: true, startsAt: true, endsAt: true },
    }) as { id: string; kind: "DEFINITE" | "INDEFINITE"; startsAt: Date; endsAt: Date | null };
    logWarn({ rg: "SELF_EXCLUSION", userId: gate.userId, period }, "player self-excluded");
    // Open deposits are cancelled by payments; anything that still arrives is refunded there.
    if (paymentsBinding(c.env)) {
      const caller = callerOf(c, gate);
      await defer(c, callPayments(c, "self-excluded", (p) => p.onSelfExcluded(caller)));
    }
    return c.json({
      id: row.id, kind: row.kind, startsAt: new Date(row.startsAt).toISOString(), endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
    } satisfies SelfExclusionResponse, 201);
  }));

  app.get("/api/account/self-exclusion", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    return c.json(await selfExclusionStatus(c.get("db")!, gate.userId));
  }));

  app.post("/api/account/self-exclusion/reactivation", authRoute(async (c) => {
    const gate = await authed(c);
    if (!gate.ok) return gate.response;
    const result = await requestReactivation(c.get("db")!, gate.userId);
    if ("status" in result) {
      logWarn({ rg: "SELF_EXCLUSION_RETURN_REQUESTED", userId: gate.userId }, "player asked to come back from a self-exclusion");
      return c.json(result.status);
    }
    if (result.code === "EXCLUSION_NOT_ENDED") {
      return failureResponse(c, rpcFail("EXCLUSION_NOT_ENDED", "Your break has not ended yet.", { details: { endsAt: result.endsAt! } }));
    }
    return failureResponse(c, rpcFail("INVALID_STATE", "You do not have a self-exclusion in force."));
  }));

  /**
   * "This wasn't me" from a payments email (no session). The account is secured
   * first, in one transaction, with the same durability as the auth lockdown:
   * every session ends, withdrawals are held and the report is recorded. Only
   * then is payments asked to lock the money down, after the response, and the
   * recorded report means a failure there only delays it (applyPendingLockdowns).
   * poker-api checks the signed token itself when it holds NOTIFY_LINK_SECRET,
   * so a payments outage cannot stop the account being secured; without the
   * secret payments is asked who the token names.
   *
   * A link works once: the same notice reported again answers secured and
   * changes nothing (a link mailed to an attacker's address cannot sign the
   * owner out over and over). And like the auth lockdown's own links, a link
   * sent at or after the incident of a later account lockdown is void: it may
   * have gone to an address the attacker set, and must not undo the recovery.
   * Both checks run under the user's row lock, so two uses at once are one.
   */
  app.post("/api/wallet/not-me", authRoute(async (c) => {
    const parsed = notMeBody.safeParse(c.get("jsonBody"));
    if (!parsed.success) return c.json({ error: "This link is not valid.", code: "TOKEN_INVALID" }, 400);
    const invalidLink = rpcFail("TOKEN_INVALID", "This link is not valid or has expired.");
    if (!paymentsBinding(c.env)) return failureResponse(c, invalidLink);
    const { token } = parsed.data;
    const secret = c.env.NOTIFY_LINK_SECRET?.trim();
    let claims: NotMeTokenClaims | null = secret ? await verifyNotMe(secret, token, new Date()) : null;
    if (!claims) {
      if (!secret) logWarn({ security: "NOTIFY_LINK_SECRET_MISSING" }, "poker-api cannot check a not-me link itself: a payments outage would stop it");
      const verified = await callPayments<NotMeTokenClaims>(c, "security.not-me", (p) => p.verifyNotMeToken(token));
      if (!verified.ok) return failureResponse(c, verified.code === "REAL_MONEY_DISABLED" ? invalidLink : verified);
      claims = verified.value;
    }
    const { u: userId, k, s } = claims;
    if (typeof claims.e !== "number" || !Number.isFinite(claims.e)) return failureResponse(c, invalidLink);
    const sentAt = new Date(claims.e - NOT_ME_TTL_MS);
    const db: AppDb = c.get("db")!;
    const config = c.get("config")!;
    const facts = requestFacts(c);
    const at = new Date();
    let secured: { ended: string[]; reportId: string } | null;
    try {
      secured = await db.$transaction(async (tx) => {
        // Takes the user's row lock first: a second use of this link waits here, then sees the first report.
        const { count } = await tx.user.updateMany({ where: { id: userId }, data: { securityHoldUntil: new Date(at.getTime() + config.securityHoldMs) } });
        if (count === 0) throw new Refusal(400, { error: invalidLink.message, code: invalidLink.code });
        const since = await tx.accountSecurityEvent.findMany({
          where: { userId, type: "NOT_ME_REPORTED", createdAt: { gte: sentAt } }, select: { data: true }, orderBy: { createdAt: "asc" }, take: 500,
        }) as { data: unknown }[];
        const used = since.some(({ data }) => {
          const notice = (data as { notice?: { k?: unknown; s?: unknown } } | null)?.notice;
          return notice?.k === k && notice?.s === s;
        });
        // Rolls back the hold just set: a used link changes nothing.
        if (used) throw new NotMeAlreadyReported();
        const recovered = since.some(({ data }) => {
          const incidentAt = (data as { incidentAt?: unknown } | null)?.incidentAt;
          const instant = typeof incidentAt === "string" ? new Date(incidentAt).getTime() : NaN;
          return Number.isFinite(instant) && instant <= sentAt.getTime();
        });
        if (recovered) {
          logWarn({ security: "NOT_ME_LINK_VOID", userId }, "a payments not-me link sent after the incident of a later account lockdown was refused");
          throw new Refusal(400, { error: invalidLink.message, code: invalidLink.code });
        }
        const ended = await revokeUserSessions(tx, userId, "SECURITY_LOCKDOWN");
        const reportId = await recordSecurityEvent(tx, { userId, type: "NOT_ME_REPORTED", facts, data: { kind: "PAYMENT_NOTICE", notice: { k, s }, revokedSessions: ended.length } });
        return { ended, reportId };
      });
    } catch (err) {
      if (!(err instanceof NotMeAlreadyReported)) throw err;
      secured = null;
    }
    if (!secured) {
      logWarn({ security: "NOT_ME_LINK_REUSED", userId }, "a payments not-me link was used again; nothing changed");
      return c.json({ secured: true });
    }
    await fanoutRevoke(c.env, userId, secured.ended, "SECURITY_LOCKDOWN");
    await defer(c, onAccountLockdown(c.env, userId, { id: secured.reportId, at: at.toISOString(), notice: { k, s } }));
    logWarn({ security: "PAYMENTS_NOT_ME", userId, revokedSessions: secured.ended.length }, "payments notice reported as not me");
    return c.json({ secured: true });
  }));
}
