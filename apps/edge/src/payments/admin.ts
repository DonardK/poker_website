/**
 * Back-office payments (docs/money/WALLET.md sections 10.8, 10.9 and 11.2).
 * poker-api's admin routes already checked Access, the session and the
 * role, but payments checks all of it again (verifyAdmin): the Cloudflare
 * Access JWT (required in live mode), a live session, User.role = ADMIN read
 * from the database. Every change also consumes a single-use passkey
 * step-up grant (purpose admin_payments) bound to adminPaymentsAction
 * ({ subject, decision }) inside its own transaction, so a stolen admin
 * session alone changes nothing.
 *
 * Two distinct administrators are needed for: a withdrawal at or above
 * DUAL_APPROVAL_MIN (or flagged by the rules), every manual withdrawal in
 * live mode, resolving an uncertain payout, crediting a deposit under review
 * in live mode (both naming the same amount), restoring a revoked card, and
 * turning a switch ON in live mode. The database refuses self-approval, an
 * approval by a non-admin and a second approval by the same admin (PM004); the
 * checks below answer those cases with a clear code first.
 *
 * A security hold on an administrator stops everything that adds risk. What
 * can only stop money (isAdminSafetyAction: a switch OFF, a freeze) stays
 * possible with one administrator, always, with its grant and its audit row.
 */
import {
  adminPaymentsAction,
  isAdminSafetyAction,
  MONEY_AMOUNT_PATTERN,
  PAYMENT_SWITCH_KEYS,
  PAYMENTS_RESTRICTIONS,
  WALLET_DECIMALS,
  type AdminAcceptReactivationResponse,
  type AdminComplianceSummary,
  type AdminCustodySnapshotResponse,
  type AdminDepositItem,
  type AdminLedgerEntryView,
  type AdminPaymentEventView,
  type AdminReactivationItem,
  type AdminReconciliationIssueView,
  type AdminReconciliationRunView,
  type AdminRestoreInstrumentResponse,
  type AdminSwitchView,
  type AdminWithdrawalDetail,
  type AdminWithdrawalItem,
  type DepositStatus,
  type Page,
  type PaymentSwitchKey,
  type PaymentsRestriction,
  type SettlementAsset,
  type WithdrawalStatus,
} from "@poker/shared";
import { accessJwtValid } from "../auth/access";
import type { Deposit, PaymentInstrument, Prisma, Withdrawal } from "../generated/prisma/client";
import { logInfo, logWarn } from "../http/log";
import { parseMinor } from "../money/amounts";
import { moneyTx, type MoneyTx } from "../money/tx";
import { lockCompliance, readCompliance, type ComplianceRow } from "./compliance";
import type { AdminCaller, AdminWithdrawalDecision, PageQuery } from "./contract";
import { moneyProviderByKey, type PaymentsContext } from "./context";
import { resolveReviewedDeposit, reviewCreditCap } from "./deposits";
import { refuse } from "./errors";
import { restoreCard } from "./instruments";
import { custodyLiabilities } from "./reconcile";
import { onScreeningHit } from "./security";
import { raiseIssue } from "./issues";
import { isUuid, securityHeld, verifyCaller, type CallerUser } from "./session";
import { consumeGrant, requirementFor } from "./stepup";
import { destinationView, instrumentView, iso, money } from "./views";
import { queueDispatch, releaseWithdrawal, requestCancels, settleRequestedCancels, settleWithdrawal } from "./withdrawals";

const PAGE_MAX = 50;
const LEDGER_PAGE_MAX = 100;

const pageLimit = (value: unknown, max = PAGE_MAX) => Math.min(Math.max(Math.trunc(Number(value ?? 20)) || 20, 1), max);
const note = (value: unknown, max = 500) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Cursor of a (createdAt desc, id desc) page: "<epoch ms 13 digits>:<uuid>". */
function cursorWhere(cursor: unknown): Prisma.WithdrawalWhereInput | null {
  if (typeof cursor !== "string" || !/^\d{13}:[0-9a-f-]{36}$/.test(cursor)) return null;
  const at = new Date(Number(cursor.slice(0, 13)));
  const id = cursor.slice(14);
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
}

function nextCursor<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): string | null {
  const last = rows[limit - 1];
  return rows.length > limit && last ? `${String(last.createdAt.getTime()).padStart(13, "0")}:${last.id}` : null;
}

// ---------------------------------------------------------------------------
// Caller checks
// ---------------------------------------------------------------------------

/** Access (when configured, always in live mode), a live session and the ADMIN role. */
export async function verifyAdmin(ctx: PaymentsContext, admin: AdminCaller): Promise<CallerUser> {
  const { requireCfAccess, accessAud, accessTeamDomain } = ctx.config.admin;
  if (requireCfAccess || ctx.config.mode === "live" || (accessAud && accessTeamDomain)) {
    if (!accessAud || !accessTeamDomain) refuse("ADMIN_ACCESS_REQUIRED", "Cloudflare Access is not configured for payments administration.");
    const jwt = typeof admin?.accessJwt === "string" ? admin.accessJwt : "";
    if (!(await accessJwtValid(jwt, { aud: accessAud, team: accessTeamDomain }))) {
      logWarn({ security: "PAYMENTS_ADMIN_ACCESS_REFUSED", userId: admin?.userId ?? null }, "payments admin call without a valid Access JWT");
      refuse("ADMIN_ACCESS_REQUIRED", "Sign in through Cloudflare Access to use payments administration.");
    }
  }
  const user = await verifyCaller(ctx.db, admin, ctx.now());
  if (user.role !== "ADMIN") {
    logWarn({ security: "PAYMENTS_ADMIN_DENIED", userId: user.id }, "payments admin call by a non-admin");
    refuse("FORBIDDEN", "Administrators only.");
  }
  return user;
}

/**
 * Consumes the admin's passkey grant for exactly this subject and decision
 * (inside the change's transaction). The security hold applies to staff too:
 * poker-api refuses such a grant, and payments does not take its word for it.
 * The exception is an action that can only stop money.
 */
async function adminGrant(tx: MoneyTx, ctx: PaymentsContext, admin: AdminCaller, grantId: unknown, subject: string, decision: string): Promise<string> {
  const user = await tx.user.findUnique({ where: { id: admin.userId }, select: { securityHoldUntil: true } });
  if (!user || (securityHeld(user, ctx.now()) && !isAdminSafetyAction({ subject, decision }))) refuse("SECURITY_HOLD", "Your account is on a security hold. Ask another administrator.");
  const requirement = await requirementFor(adminPaymentsAction({ subject, decision }));
  return consumeGrant(tx, { grantId: typeof grantId === "string" ? grantId : null, userId: admin.userId, sessionId: admin.sessionId, requirement });
}

async function lockWithdrawal(tx: MoneyTx, withdrawalId: string): Promise<Withdrawal> {
  const owner = await tx.withdrawal.findUnique({ where: { id: withdrawalId }, select: { userId: true } });
  if (!owner) refuse("NOT_FOUND", "That withdrawal does not exist.");
  await lockCompliance(tx, owner.userId);
  await tx.$queryRaw`SELECT "id" FROM public."Withdrawal" WHERE "id" = ${withdrawalId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "withdrawalId" FROM public."PayoutDispatch" WHERE "withdrawalId" = ${withdrawalId}::uuid FOR UPDATE`;
  return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
}

async function distinctAdmins(db: PaymentsContext["db"] | MoneyTx, where: Prisma.PaymentReviewActionWhereInput): Promise<string[]> {
  const rows = await db.paymentReviewAction.findMany({ where: { ...where, actorKind: "ADMIN" }, select: { actorUserId: true }, distinct: ["actorUserId"] });
  return rows.map((row) => row.actorUserId).filter((id): id is string => id !== null);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type WithdrawalWithRefs = Withdrawal & { instrument: PaymentInstrument | null; user: { username: string } };

async function withdrawalItems(ctx: PaymentsContext, rows: WithdrawalWithRefs[]): Promise<AdminWithdrawalItem[]> {
  const approvals = rows.length === 0 ? [] : await ctx.db.paymentReviewAction.findMany({
    where: { subjectType: "WITHDRAWAL", subjectId: { in: rows.map((row) => row.id) }, verb: "APPROVE", actorKind: "ADMIN" },
    select: { subjectId: true, actorUserId: true },
  });
  return rows.map((row) => ({
    id: row.id, userId: row.userId, username: row.user.username, kind: row.kind, status: row.status, asset: row.assetCode as SettlementAsset,
    amount: money(row.amountMinor), fee: money(row.feeMinor), destination: destinationView(row.instrument),
    reasons: Array.isArray(row.reviewReasons) ? (row.reviewReasons as unknown[]).filter((r): r is string => typeof r === "string") : [],
    approvalsRequired: effectiveApprovals(ctx, row),
    approvals: new Set(approvals.filter((a) => a.subjectId === row.id).map((a) => a.actorUserId)).size,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** The rules' approvalsRequired, raised to two for every manual withdrawal in live mode. */
function effectiveApprovals(ctx: PaymentsContext, row: Pick<Withdrawal, "approvalsRequired">): number {
  return Math.max(row.approvalsRequired, ctx.config.mode === "live" ? 2 : 1);
}

function complianceSummary(row: ComplianceRow, securityHoldUntil: Date | null): AdminComplianceSummary {
  return {
    kycStatus: row.kycStatus, screeningStatus: row.screeningStatus, riskLevel: row.riskLevel, sourceOfFundsStatus: row.sourceOfFundsStatus,
    restriction: row.restriction, restrictionReason: row.restrictionReason, residenceCountry: row.residenceCountry,
    lifetimeDeposited: money(row.lifetimeDepositedMinor), chargebackCount: row.chargebackCount, securityHoldUntil: iso(securityHoldUntil),
  };
}

const USER_REF = { select: { username: true } } as const;

export async function listWithdrawals(ctx: PaymentsContext, query: PageQuery & { status?: WithdrawalStatus }): Promise<Page<AdminWithdrawalItem>> {
  const limit = pageLimit(query?.limit);
  const status = typeof query?.status === "string" ? query.status : "UNDER_REVIEW";
  const after = cursorWhere(query?.cursor);
  const rows = await ctx.db.withdrawal.findMany({
    where: { status: status as WithdrawalStatus, ...(after ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { instrument: true, user: USER_REF },
  }) as WithdrawalWithRefs[];
  return { items: await withdrawalItems(ctx, rows.slice(0, limit)), next: nextCursor(rows, limit) };
}

async function ledgerFor(ctx: PaymentsContext, where: { withdrawalId?: string; depositId?: string }): Promise<AdminLedgerEntryView[]> {
  const key = where.withdrawalId ? "withdrawalId" : "depositId";
  const value = where.withdrawalId ?? where.depositId ?? "";
  const rows = await ctx.db.$queryRaw<LedgerRow[]>`
    SELECT t."seq"::text AS seq, t."id"::text AS "txId", t."type"::text AS type, a."type"::text AS "accountType", e."amount"::text AS amount,
           e."balanceAfter"::text AS "balanceAfter", t."reference", t."createdAt"
      FROM public."LedgerEntry" e JOIN public."LedgerAccount" a ON a."id" = e."accountId"
      JOIN public."LedgerTransaction" t ON t."id" = e."transactionId"
     WHERE t."reference"->>${key} = ${value}
     ORDER BY t."seq", e."id" LIMIT 50`;
  return rows.map(ledgerView);
}

interface LedgerRow {
  seq: string;
  txId: string;
  type: string;
  accountType: string;
  amount: string;
  balanceAfter: string;
  reference: unknown;
  createdAt: Date;
}

function ledgerView(row: LedgerRow): AdminLedgerEntryView {
  const reference: Record<string, string | number | boolean | null> = {};
  if (row.reference && typeof row.reference === "object") {
    for (const [k, v] of Object.entries(row.reference as Record<string, unknown>)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") reference[k] = v;
    }
  }
  return {
    seq: row.seq, txId: row.txId, type: row.type, accountType: row.accountType, amount: money(BigInt(row.amount)),
    balanceAfter: money(BigInt(row.balanceAfter)), reference, createdAt: row.createdAt.toISOString(),
  };
}

export async function getWithdrawal(ctx: PaymentsContext, withdrawalId: string): Promise<AdminWithdrawalDetail> {
  if (!isUuid(withdrawalId)) refuse("NOT_FOUND", "That withdrawal does not exist.");
  const row = await ctx.db.withdrawal.findUnique({ where: { id: withdrawalId }, include: { instrument: true, user: USER_REF } }) as WithdrawalWithRefs | null;
  if (!row) refuse("NOT_FOUND", "That withdrawal does not exist.");
  const [item] = await withdrawalItems(ctx, [row]);
  const dispatch = await ctx.db.payoutDispatch.findUnique({ where: { withdrawalId }, select: { status: true } });
  const attempts = await ctx.db.payoutAttempt.findMany({ where: { withdrawalId }, orderBy: { seq: "asc" }, take: 50 });
  const actions = await ctx.db.paymentReviewAction.findMany({ where: { subjectType: "WITHDRAWAL", subjectId: withdrawalId }, orderBy: { createdAt: "asc" }, take: 50 });
  const user = await ctx.db.user.findUnique({ where: { id: row.userId }, select: { securityHoldUntil: true } });
  return {
    withdrawal: {
      ...item!, providerKey: row.providerKey, providerPayoutId: row.providerPayoutId, txHash: row.txHash, failureCode: row.failureCode,
      rulesVersion: row.rulesVersion, dispatchStatus: dispatch?.status ?? null,
    },
    compliance: complianceSummary(await readCompliance(ctx.db, row.userId), user?.securityHoldUntil ?? null),
    instrument: row.instrument ? instrumentView(row.instrument) : null,
    attempts: attempts.map((a) => ({
      seq: a.seq, action: a.action as "CREATE" | "QUERY" | "REFUND", outcome: a.outcome, httpStatus: a.httpStatus, providerPayoutId: a.providerPayoutId,
      errorClass: a.errorClass, startedAt: a.startedAt.toISOString(), finishedAt: a.finishedAt.toISOString(),
    })),
    reviewActions: actions.map((a) => ({
      id: a.id, verb: a.verb, actorKind: a.actorKind as "ADMIN" | "SYSTEM" | "PLAYER", actorUserId: a.actorUserId, reasonCode: a.reasonCode, note: a.note,
      createdAt: a.createdAt.toISOString(),
    })),
    ledger: await ledgerFor(ctx, { withdrawalId }),
  };
}

async function itemOf(ctx: PaymentsContext, withdrawalId: string): Promise<AdminWithdrawalItem> {
  const row = await ctx.db.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId }, include: { instrument: true, user: USER_REF } }) as WithdrawalWithRefs;
  return (await withdrawalItems(ctx, [row]))[0]!;
}

// ---------------------------------------------------------------------------
// Withdrawal decisions (10.8) and uncertain payouts (10.9)
// ---------------------------------------------------------------------------

/**
 * Where a refund goes. A card deposit's refund goes to that deposit's card and
 * provider, nowhere else, even if the card was revoked since: it returns money
 * to where it came from. A crypto deposit's source address is not known and is
 * never guessed, so an administrator names one of the player's payout addresses
 * that is active and past its cooling-off. Otherwise the answer is a typed 409.
 * That refund is a payout in all but name (the player chose the address), so
 * it is refused while the account could not withdraw: frozen, on a security
 * hold, or with KYC or screening not clear. The dispatcher checks it all again
 * before it sends (dispatch.ts payoutBlock).
 */
async function refundTarget(tx: MoneyTx, ctx: PaymentsContext, withdrawal: Withdrawal, named: string | null): Promise<{ instrumentId: string; providerKey: string; named: boolean }> {
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: withdrawal.sourceDepositId! }, select: { method: true, instrumentId: true, providerKey: true } });
  if (deposit.method === "CARD") {
    if (deposit.instrumentId === null) refuse("REFUND_DESTINATION_REQUIRED", "This deposit has no card on record. Refund it at the provider, then reject this refund.");
    if (named !== null && named !== deposit.instrumentId) refuse("REFUND_DESTINATION_REQUIRED", "A card deposit's refund goes back to that card. Do not name another destination.");
    return { instrumentId: deposit.instrumentId, providerKey: deposit.providerKey, named: false };
  }
  const needed = "A crypto refund needs one of the player's active payout addresses named. Ask the player to add one, or reject the refund to return it to their balance.";
  if (named === null) refuse("REFUND_DESTINATION_REQUIRED", needed);
  const compliance = await readCompliance(tx, withdrawal.userId);
  if (compliance.restriction === "FROZEN" || compliance.kycStatus !== "VERIFIED" || compliance.screeningStatus !== "CLEAR") {
    refuse("ACCOUNT_RESTRICTED", "This account cannot withdraw now (frozen, or KYC or screening not clear), so a refund to an address it chose cannot go either. Resolve that first, or refund at the provider and reject this refund.");
  }
  const owner = await tx.user.findUnique({ where: { id: withdrawal.userId }, select: { securityHoldUntil: true } });
  if (!owner || securityHeld(owner, ctx.now())) refuse("SECURITY_HOLD", "The player's account is on a security hold. Approve this refund when the hold has ended.");
  const instrument = await tx.paymentInstrument.findFirst({ where: { id: named, userId: withdrawal.userId, kind: "CRYPTO_ADDRESS" } });
  if (!instrument || instrument.status !== "ACTIVE" || !instrument.payoutEnabled || instrument.usableAfter.getTime() > ctx.now().getTime()
      || !moneyProviderByKey(ctx.providers, instrument.providerKey)) {
    refuse("REFUND_DESTINATION_REQUIRED", needed);
  }
  return { instrumentId: instrument.id, providerKey: instrument.providerKey, named: true };
}

export async function decideWithdrawal(ctx: PaymentsContext, admin: AdminCaller, withdrawalId: string, input: AdminWithdrawalDecision): Promise<{ withdrawal: AdminWithdrawalItem; approvalsRemaining: number }> {
  if (!isUuid(withdrawalId)) refuse("NOT_FOUND", "That withdrawal does not exist.");
  const decision = input?.decision;
  if (decision !== "APPROVE" && decision !== "REJECT") refuse("VALIDATION", "Choose approve or reject.");
  const reasonCode = decision === "REJECT" ? note((input as { reasonCode?: unknown }).reasonCode, 64) : null;
  if (decision === "REJECT" && (!reasonCode || !/^[A-Z0-9_]{2,64}$/.test(reasonCode))) refuse("VALIDATION", "Give a reason code such as AML_CONCERN.");
  const named = decision === "APPROVE" ? (input as { refundInstrumentId?: unknown }).refundInstrumentId ?? null : null;
  if (named !== null && !isUuid(named)) refuse("VALIDATION", "Name the destination by its id.");
  const result = await moneyTx(ctx.db, async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    // The grant covers the destination too: approving "this refund, to that address".
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `withdrawal:${withdrawalId}`, named ? `APPROVE:${named}` : decision);
    if (withdrawal.status !== "UNDER_REVIEW") refuse("INVALID_STATE", "This withdrawal is not waiting for review.");
    if (decision === "APPROVE") {
      if (withdrawal.userId === admin.userId) refuse("SELF_APPROVAL", "You cannot approve your own withdrawal.");
      if (withdrawal.cancelRequestedAt !== null) refuse("INVALID_STATE", "This withdrawal is being cancelled.");
      if (named !== null && withdrawal.kind !== "REFUND") refuse("VALIDATION", "Only a refund takes a destination here.");
      const target = withdrawal.kind === "REFUND" ? await refundTarget(tx, ctx, withdrawal, named) : null;
      // Administrators who name a destination agree on it: each address has its own count.
      const approval = target?.named ? `REFUND_TO:${target.instrumentId}` : null;
      const before = await distinctAdmins(tx, { subjectType: "WITHDRAWAL", subjectId: withdrawalId, verb: "APPROVE", ...(approval ? { reasonCode: approval } : {}) });
      if (before.includes(admin.userId)) refuse("ALREADY_APPROVED", "You already approved this withdrawal; another administrator must approve it too.");
      await tx.paymentReviewAction.create({
        data: {
          subjectType: "WITHDRAWAL", subjectId: withdrawalId, subjectUserId: withdrawal.userId, actorKind: "ADMIN", actorUserId: admin.userId,
          actorStepUpMethod: method, verb: "APPROVE", reasonCode: approval, note: note(input.note), metadata: {},
        },
      });
      const required = effectiveApprovals(ctx, withdrawal);
      const remaining = Math.max(0, required - (before.length + 1));
      if (remaining === 0) {
        await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: { status: "APPROVED", decidedAt: ctx.now(), ...(target ? { instrumentId: target.instrumentId, providerKey: target.providerKey } : {}) },
        });
        await queueDispatch(tx, withdrawalId);
      }
      return { remaining, approved: remaining === 0 };
    }
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "WITHDRAWAL", subjectId: withdrawalId, subjectUserId: withdrawal.userId, actorKind: "ADMIN", actorUserId: admin.userId,
        actorStepUpMethod: method, verb: "REJECT", reasonCode, note: note((input as { note?: unknown }).note), metadata: {},
      },
    });
    await releaseWithdrawal(tx, ctx, withdrawal, "REJECTED", reasonCode!, "This withdrawal was not approved");
    return { remaining: 0, approved: false };
  }, { label: `admin.withdrawal.${decision.toLowerCase()}` });
  logInfo({ audit: "PAYMENTS_ADMIN_DECISION", adminId: admin.userId, withdrawalId, decision, remaining: result.remaining }, "withdrawal decision recorded");
  if (result.approved) await ctx.kick();
  return { withdrawal: await itemOf(ctx, withdrawalId), approvalsRemaining: result.remaining };
}

export async function resolveUncertain(ctx: PaymentsContext, admin: AdminCaller, withdrawalId: string, input: { outcome?: unknown; evidence?: unknown; stepUpGrantId?: unknown }): Promise<{ withdrawal: AdminWithdrawalItem; approvalsRemaining: number }> {
  if (!isUuid(withdrawalId)) refuse("NOT_FOUND", "That withdrawal does not exist.");
  const outcome = input?.outcome;
  if (outcome !== "SETTLED" && outcome !== "FAILED") refuse("VALIDATION", "The outcome is SETTLED or FAILED.");
  const raw = input.evidence && typeof input.evidence === "object" ? input.evidence as Record<string, unknown> : {};
  const evidence = {
    providerPayoutId: note(raw.providerPayoutId, 200), txHash: note(raw.txHash, 200), statementLine: note(raw.statementLine, 200),
  };
  if (!evidence.providerPayoutId && !evidence.txHash && !evidence.statementLine) refuse("VALIDATION", "Attach the evidence: a provider payout id, a transaction hash or a statement line.");
  const reasonCode = `RESOLVE_${outcome}`;
  const result = await moneyTx(ctx.db, async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `withdrawal:${withdrawalId}`, reasonCode);
    const dispatch = await tx.payoutDispatch.findUnique({ where: { withdrawalId } });
    if (withdrawal.status !== "SUBMITTED" || !dispatch || (dispatch.status !== "MANUAL" && dispatch.status !== "UNCERTAIN")) {
      refuse("INVALID_STATE", "Only a payout whose outcome is uncertain can be resolved by hand.");
    }
    const before = await distinctAdmins(tx, { subjectType: "WITHDRAWAL", subjectId: withdrawalId, verb: "RESOLVE", reasonCode });
    if (before.includes(admin.userId)) refuse("ALREADY_APPROVED", "You already confirmed this outcome; another administrator must confirm it too.");
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "WITHDRAWAL", subjectId: withdrawalId, subjectUserId: withdrawal.userId, actorKind: "ADMIN", actorUserId: admin.userId,
        actorStepUpMethod: method, verb: "RESOLVE", reasonCode, metadata: evidence,
      },
    });
    const remaining = Math.max(0, 2 - (before.length + 1));
    if (remaining > 0) return remaining;
    if (dispatch.status === "UNCERTAIN") await tx.payoutDispatch.update({ where: { withdrawalId }, data: { status: "MANUAL", leaseUntil: null } });
    if (outcome === "SETTLED") {
      await tx.payoutDispatch.update({ where: { withdrawalId }, data: { status: "COMPLETED", lastError: null, ...(evidence.providerPayoutId ? { providerPayoutId: evidence.providerPayoutId } : {}) } });
      await settleWithdrawal(tx, ctx, withdrawal, { providerPayoutId: evidence.providerPayoutId, ...(evidence.txHash ? { txHash: evidence.txHash } : {}) });
    } else {
      await tx.payoutDispatch.update({ where: { withdrawalId }, data: { status: "FAILED", lastError: "RESOLVED_FAILED" } });
      await releaseWithdrawal(tx, ctx, withdrawal, "FAILED", "RESOLVED_FAILED", "The payout did not go through");
    }
    return 0;
  }, { label: "admin.withdrawal.resolve" });
  logInfo({ audit: "PAYMENTS_ADMIN_RESOLVE", adminId: admin.userId, withdrawalId, outcome, remaining: result }, "uncertain payout resolution recorded");
  return { withdrawal: await itemOf(ctx, withdrawalId), approvalsRemaining: result };
}

// ---------------------------------------------------------------------------
// Deposits under review
// ---------------------------------------------------------------------------

function depositItem(row: Deposit & { user: { username: string } }): AdminDepositItem {
  return {
    id: row.id, userId: row.userId, username: row.user.username, method: row.method, status: row.status, providerKey: row.providerKey,
    asset: row.assetCode as SettlementAsset, amount: money(row.requestedMinor), reportedAmount: row.reportedMinor === null ? null : money(row.reportedMinor),
    creditedAmount: row.creditedMinor === null ? null : money(row.creditedMinor), payAsset: row.payAssetCode, statusReason: row.statusReason, createdAt: row.createdAt.toISOString(),
  };
}

export async function listDeposits(ctx: PaymentsContext, query: PageQuery & { status?: DepositStatus }): Promise<Page<AdminDepositItem>> {
  const limit = pageLimit(query?.limit);
  const status = typeof query?.status === "string" ? query.status : "NEEDS_REVIEW";
  const after = cursorWhere(query?.cursor) as Prisma.DepositWhereInput | null;
  const rows = await ctx.db.deposit.findMany({
    where: { status: status as DepositStatus, ...(after ?? {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: { user: USER_REF },
  });
  return { items: rows.slice(0, limit).map(depositItem), next: nextCursor(rows, limit) };
}

export async function resolveDeposit(ctx: PaymentsContext, admin: AdminCaller, depositId: string, input: { action?: unknown; creditAmount?: unknown; note?: unknown; stepUpGrantId?: unknown }): Promise<{ deposit: AdminDepositItem; approvalsRemaining: number }> {
  if (!isUuid(depositId)) refuse("NOT_FOUND", "That deposit does not exist.");
  const action = input?.action;
  if (action !== "CREDIT" && action !== "FAIL") refuse("VALIDATION", "The action is CREDIT or FAIL.");
  const reason = note(input.note);
  if (!reason) refuse("VALIDATION", "Explain the decision in the note.");
  let creditMinor: bigint | null = null;
  if (action === "CREDIT") {
    if (typeof input.creditAmount !== "string" || !MONEY_AMOUNT_PATTERN.test(input.creditAmount)) refuse("VALIDATION", "Enter the amount to credit, like 50.00.");
    creditMinor = parseMinor(input.creditAmount, WALLET_DECIMALS);
  }
  const decision = action === "CREDIT" ? `CREDIT:${creditMinor}` : "FAIL";
  const approvalsRemaining = await moneyTx(ctx.db, async (tx) => {
    const owner = await tx.deposit.findUnique({ where: { id: depositId }, select: { userId: true } });
    if (!owner) refuse("NOT_FOUND", "That deposit does not exist.");
    await lockCompliance(tx, owner.userId);
    await tx.$queryRaw`SELECT "id" FROM public."Deposit" WHERE "id" = ${depositId}::uuid FOR UPDATE`;
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `deposit:${depositId}`, decision);
    if (owner.userId === admin.userId) refuse("SELF_APPROVAL", "You cannot resolve your own deposit.");
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
    if (deposit.status !== "NEEDS_REVIEW") refuse("INVALID_STATE", "Only a deposit under review can be resolved.");
    let remaining = 0;
    if (action === "CREDIT") {
      if (deposit.method === "CARD" && deposit.instrumentId === null) refuse("CARD_UNKNOWN", "The provider named no card for this deposit, so it cannot be credited. Fail it and refund it at the provider.");
      if (deposit.statusReason === "CARD_MISMATCH") refuse("CARD_UNKNOWN", "This deposit was paid with another card than the one it named, so it cannot be credited. Fail it and refund it at the provider.");
      const cap = reviewCreditCap(deposit);
      if (creditMinor! <= 0n || creditMinor! > cap) refuse("VALIDATION", `Credit an amount from 0.01 to ${money(cap)}, what the provider reported.`, { details: { max: money(cap) } });
      // The second administrator confirms the same amount: the amount is part of the reason code.
      const before = await distinctAdmins(tx, { subjectType: "DEPOSIT", subjectId: depositId, verb: "RESOLVE", reasonCode: decision });
      if (before.includes(admin.userId)) refuse("ALREADY_APPROVED", "You already confirmed this credit; another administrator must confirm it too.");
      if (ctx.config.mode === "live") remaining = Math.max(0, 2 - (before.length + 1));
    }
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "DEPOSIT", subjectId: depositId, subjectUserId: owner.userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: "RESOLVE", reasonCode: decision, note: reason, metadata: creditMinor === null ? {} : { creditMinor: creditMinor.toString() },
      },
    });
    if (remaining === 0) await resolveReviewedDeposit(tx, ctx, depositId, action, creditMinor);
    return remaining;
  }, { label: "admin.deposit.resolve" });
  logInfo({ audit: "PAYMENTS_ADMIN_DEPOSIT", adminId: admin.userId, depositId, action, approvalsRemaining }, "deposit under review resolved");
  const row = await ctx.db.deposit.findUniqueOrThrow({ where: { id: depositId }, include: { user: USER_REF } });
  return { deposit: depositItem(row), approvalsRemaining };
}

// ---------------------------------------------------------------------------
// Users: ledger journal and payments restriction
// ---------------------------------------------------------------------------

export async function userLedger(ctx: PaymentsContext, userId: string, query: { asset?: string; before?: string; limit?: number }): Promise<{ entries: AdminLedgerEntryView[]; next: string | null }> {
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) refuse("NOT_FOUND", "Unknown account.");
  const asset = typeof query?.asset === "string" && /^[A-Z0-9_]{2,20}$/.test(query.asset) ? query.asset : ctx.config.settlementAsset;
  const before = typeof query?.before === "string" && /^\d{1,19}$/.test(query.before) ? query.before : null;
  const limit = pageLimit(query?.limit, LEDGER_PAGE_MAX);
  const rows = await ctx.db.$queryRaw<LedgerRow[]>`
    SELECT t."seq"::text AS seq, t."id"::text AS "txId", t."type"::text AS type, a."type"::text AS "accountType", e."amount"::text AS amount,
           e."balanceAfter"::text AS "balanceAfter", t."reference", t."createdAt"
      FROM public."LedgerEntry" e JOIN public."LedgerAccount" a ON a."id" = e."accountId"
      JOIN public."LedgerTransaction" t ON t."id" = e."transactionId"
     WHERE a."userId" = ${userId} AND a."assetCode" = ${asset} AND (${before}::bigint IS NULL OR t."seq" < ${before}::bigint)
     ORDER BY t."seq" DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return { entries: page.map(ledgerView), next: rows.length > limit && page.length > 0 ? page[page.length - 1]!.seq : null };
}

export async function setRestriction(ctx: PaymentsContext, admin: AdminCaller, userId: string, input: { restriction?: unknown; reason?: unknown; stepUpGrantId?: unknown }): Promise<{ compliance: AdminComplianceSummary }> {
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) refuse("NOT_FOUND", "Unknown account.");
  const restriction = input?.restriction;
  if (typeof restriction !== "string" || !(PAYMENTS_RESTRICTIONS as readonly string[]).includes(restriction)) refuse("VALIDATION", "Choose NONE, DEPOSITS_BLOCKED, WITHDRAWALS_MANUAL or FROZEN.");
  const reason = note(input.reason, 200);
  if (!reason) refuse("VALIDATION", "Give the reason.");
  const target = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, securityHoldUntil: true } });
  if (!target) refuse("NOT_FOUND", "Unknown account.");
  // On their own account an administrator may only freeze it: any other value
  // could loosen what a colleague or a lockdown set (FROZEN to DEPOSITS_BLOCKED reopens withdrawals).
  if (userId === admin.userId && restriction !== "FROZEN") refuse("SELF_APPROVAL", "You cannot change your own restriction, except to freeze your account. Ask another administrator.");
  await moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, userId);
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `user:${userId}`, `RESTRICT:${restriction}`);
    const now = ctx.now();
    await tx.playerCompliance.update({
      where: { userId },
      data: restriction === "NONE"
        ? { restriction: "NONE", restrictionReason: null, restrictedAt: null, restrictedBy: admin.userId }
        : { restriction: restriction as PaymentsRestriction, restrictionReason: `ADMIN:${reason}`.slice(0, 500), restrictedAt: now, restrictedBy: admin.userId },
    });
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "USER", subjectId: userId, subjectUserId: userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: restriction === "NONE" ? "UNRESTRICT" : "RESTRICT", reasonCode: restriction, note: reason, metadata: {},
      },
    });
    // A freeze stops what has not been sent, now, and commits whether or not the ledger can post;
    // the releases follow. A payout already past its first attempt stops at the dispatcher.
    if (restriction === "FROZEN") await requestCancels(tx, userId, "ACCOUNT_FROZEN", { kinds: ["PLAYER"], now: ctx.now() });
  }, { label: "admin.restriction" });
  if (restriction === "FROZEN") await settleRequestedCancels(ctx, { userId });
  logInfo({ audit: "PAYMENTS_ADMIN_RESTRICTION", adminId: admin.userId, userId, restriction }, "payments restriction changed");
  return { compliance: complianceSummary(await readCompliance(ctx.db, userId), target.securityHoldUntil) };
}

const SCREENING_DECISIONS = ["CLEAR", "POTENTIAL_MATCH", "CONFIRMED_MATCH"] as const;

/**
 * A person's screening decision, so a database edit is never the process. A
 * match (POTENTIAL_MATCH, CONFIRMED_MATCH) only stops money: one
 * administrator, and it acts as a hit from the KYC provider does (unsent
 * withdrawals and refunds are stopped, a confirmed match also freezes).
 * CLEAR lets withdrawals go again, so it takes two administrators, both after
 * the last screening change; it lifts the match only, never a freeze (that is
 * setRestriction, by another decision). Never on one's own account.
 */
export async function setScreening(ctx: PaymentsContext, admin: AdminCaller, userId: string, input: { status?: unknown; reason?: unknown; stepUpGrantId?: unknown }): Promise<{ compliance: AdminComplianceSummary; approvalsRemaining: number }> {
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) refuse("NOT_FOUND", "Unknown account.");
  const status = input?.status;
  if (typeof status !== "string" || !(SCREENING_DECISIONS as readonly string[]).includes(status)) refuse("VALIDATION", "Choose CLEAR, POTENTIAL_MATCH or CONFIRMED_MATCH.");
  const decided = status as (typeof SCREENING_DECISIONS)[number];
  const reason = note(input.reason, 500);
  if (!reason) refuse("VALIDATION", "Give the reason: what was checked, and where.");
  const target = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, securityHoldUntil: true } });
  if (!target) refuse("NOT_FOUND", "Unknown account.");
  if (userId === admin.userId) refuse("SELF_APPROVAL", "You cannot decide your own screening. Ask another administrator.");
  const result = await moneyTx(ctx.db, async (tx) => {
    const compliance = await lockCompliance(tx, userId);
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `user:${userId}`, `SCREENING:${decided}`);
    const now = ctx.now();
    const row = await tx.playerCompliance.findUniqueOrThrow({ where: { userId }, select: { screenedAt: true } });
    if (decided !== "CLEAR") {
      if (compliance.screeningStatus === decided) refuse("INVALID_STATE", `Screening is already ${decided}.`);
      // A confirmed match is not lowered to a potential one here: CLEAR is the only way down.
      if (compliance.screeningStatus === "CONFIRMED_MATCH") refuse("INVALID_STATE", "A confirmed match is lifted only by clearing it (two administrators).");
      await tx.playerCompliance.update({ where: { userId }, data: { screeningStatus: decided, screenedAt: now } });
      await tx.paymentReviewAction.create({
        data: {
          subjectType: "USER", subjectId: userId, subjectUserId: userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
          verb: "RESTRICT", reasonCode: `SCREENING_${decided}`, note: reason, metadata: {},
        },
      });
      const marked = await onScreeningHit(tx, ctx, userId, decided);
      return { remaining: 0, marked };
    }
    if (compliance.screeningStatus === "CLEAR") refuse("INVALID_STATE", "Screening is already CLEAR.");
    // Each administrator confirms once per screening state: an approval from before the last change does not count.
    const since = row.screenedAt ?? new Date(0);
    const before = await distinctAdmins(tx, { subjectType: "USER", subjectId: userId, verb: "RESOLVE", reasonCode: "SCREENING_CLEAR", createdAt: { gte: since } });
    if (before.includes(admin.userId)) refuse("ALREADY_APPROVED", "You already cleared this screening; another administrator must confirm it too.");
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "USER", subjectId: userId, subjectUserId: userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: "RESOLVE", reasonCode: "SCREENING_CLEAR", note: reason, metadata: { from: compliance.screeningStatus },
      },
    });
    const remaining = Math.max(0, 2 - (before.length + 1));
    if (remaining === 0) await tx.playerCompliance.update({ where: { userId }, data: { screeningStatus: "CLEAR", screenedAt: now } });
    return { remaining, marked: 0 };
  }, { label: "admin.screening" });
  if (result.marked > 0) await settleRequestedCancels(ctx, { userId });
  logWarn({ audit: "PAYMENTS_ADMIN_SCREENING", adminId: admin.userId, userId, status: decided, approvalsRemaining: result.remaining }, "screening decision recorded");
  return { compliance: complianceSummary(await readCompliance(ctx.db, userId), target.securityHoldUntil), approvalsRemaining: result.remaining };
}

/**
 * One named revoked card back for its owner, after a lockdown left a player
 * with money, no card and no address. Two administrators, each with a grant for
 * this instrument. Only the card's newest row, and only that row: nothing is
 * restored in bulk, so an attacker's card stays revoked. A card another account
 * also holds (same token, or same fingerprint when known) is refused. A new row
 * cools off for 24 hours and the player is told, with a "This wasn't me" link.
 */
export async function restoreInstrument(ctx: PaymentsContext, admin: AdminCaller, userId: string, instrumentId: string, input: { reason?: unknown; stepUpGrantId?: unknown }): Promise<AdminRestoreInstrumentResponse> {
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !isUuid(instrumentId)) refuse("NOT_FOUND", "That instrument does not exist.");
  const reason = note(input?.reason, 200);
  if (!reason) refuse("VALIDATION", "Give the reason.");
  if (userId === admin.userId) refuse("SELF_APPROVAL", "You cannot restore your own card.");
  const result = await moneyTx(ctx.db, async (tx) => {
    await lockCompliance(tx, userId);
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `instrument:${instrumentId}`, "RESTORE");
    const revoked = await tx.paymentInstrument.findFirst({ where: { id: instrumentId, userId } });
    if (!revoked) refuse("NOT_FOUND", "That instrument does not exist.");
    if (revoked.kind !== "CARD_TOKEN" || revoked.status !== "REVOKED") refuse("INVALID_STATE", "Only a revoked card can be restored. A player adds an address again themselves.");
    const newer = await tx.paymentInstrument.findFirst({
      where: { userId, providerKey: revoked.providerKey, cardToken: revoked.cardToken, createdAt: { gt: revoked.createdAt } }, select: { id: true },
    });
    if (newer) refuse("INVALID_STATE", "This card already has a newer record.");
    // A card another account also holds never takes payouts here (upsertCardFromDeposit, CARD_SHARED): a restore must not change that.
    const shared = await tx.paymentInstrument.findFirst({
      where: {
        userId: { not: userId }, providerKey: revoked.providerKey,
        OR: [{ cardToken: revoked.cardToken }, ...(revoked.cardFingerprint ? [{ cardFingerprint: revoked.cardFingerprint }] : [])],
      },
      select: { id: true },
    });
    if (shared) refuse("INVALID_STATE", "This card is also on another account, so it cannot be restored for payouts. The player withdraws to a payout address instead.");
    const owner = await tx.user.findUnique({ where: { id: userId }, select: { securityHoldUntil: true } });
    if (!owner) refuse("NOT_FOUND", "Unknown account.");
    if (securityHeld(owner, ctx.now())) refuse("SECURITY_HOLD", "This account is on a security hold. Restore the card after it ends.");
    const before = await distinctAdmins(tx, { subjectType: "INSTRUMENT", subjectId: instrumentId, verb: "APPROVE", createdAt: { gte: revoked.revokedAt! } });
    if (before.includes(admin.userId)) refuse("ALREADY_APPROVED", "You already approved this; another administrator must approve it too.");
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "INSTRUMENT", subjectId: instrumentId, subjectUserId: userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: "APPROVE", reasonCode: "RESTORE", note: reason, metadata: {},
      },
    });
    const remaining = Math.max(0, 2 - (before.length + 1));
    return { remaining, instrument: remaining === 0 ? await restoreCard(tx, ctx, revoked) : null };
  }, { label: "admin.instrument.restore" });
  logWarn({ audit: "PAYMENTS_ADMIN_RESTORE", adminId: admin.userId, userId, instrumentId, approvalsRemaining: result.remaining }, "card restore recorded");
  return { instrument: result.instrument ? instrumentView(result.instrument) : null, approvalsRemaining: result.remaining };
}

/** Indefinite self-exclusions whose player asked to come back, oldest request first. */
export async function listReactivations(ctx: PaymentsContext, query: PageQuery): Promise<Page<AdminReactivationItem>> {
  const limit = pageLimit(query?.limit);
  const rows = await ctx.db.selfExclusion.findMany({
    where: { kind: "INDEFINITE", reactivationRequestedAt: { not: null }, reactivationAcceptedAt: null },
    orderBy: [{ reactivationRequestedAt: "asc" }, { id: "asc" }], take: limit, include: { user: USER_REF },
  });
  return {
    items: rows.map((row) => ({ id: row.id, userId: row.userId, username: row.user.username, startsAt: row.startsAt.toISOString(), requestedAt: row.reactivationRequestedAt!.toISOString() })),
    next: null,
  };
}

/** An administrator accepts: access returns 7 days later (the database sets it). A timed exclusion needs no administrator. */
export async function acceptReactivation(ctx: PaymentsContext, admin: AdminCaller, exclusionId: string, input: { note?: unknown; stepUpGrantId?: unknown }): Promise<AdminAcceptReactivationResponse> {
  if (!isUuid(exclusionId)) refuse("NOT_FOUND", "That self-exclusion does not exist.");
  const reason = note(input?.note);
  if (!reason) refuse("VALIDATION", "Explain the decision in the note.");
  const accessRestoredAt = await moneyTx(ctx.db, async (tx) => {
    const found = await tx.selfExclusion.findUnique({ where: { id: exclusionId }, select: { userId: true } });
    if (!found) refuse("NOT_FOUND", "That self-exclusion does not exist.");
    await lockCompliance(tx, found.userId);
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `self-exclusion:${exclusionId}`, "ACCEPT");
    if (found.userId === admin.userId) refuse("SELF_APPROVAL", "You cannot accept your own request.");
    const row = await tx.selfExclusion.findUniqueOrThrow({ where: { id: exclusionId } });
    if (row.kind !== "INDEFINITE" || row.reactivationRequestedAt === null || row.reactivationAcceptedAt !== null) refuse("INVALID_STATE", "This self-exclusion is not waiting for an administrator.");
    const updated = await tx.selfExclusion.update({ where: { id: exclusionId }, data: { reactivationAcceptedAt: ctx.now(), reactivationAcceptedBy: admin.userId } });
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "USER", subjectId: found.userId, subjectUserId: found.userId, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: "NOTE", reasonCode: "SELF_EXCLUSION_REACTIVATED", note: reason, metadata: { exclusionId },
      },
    });
    return updated.accessRestoredAt!;
  }, { label: "admin.self-exclusion.accept" });
  logWarn({ audit: "PAYMENTS_ADMIN_REACTIVATION", adminId: admin.userId, exclusionId }, "self-exclusion reactivation accepted");
  return { accessRestoredAt: accessRestoredAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

function switchView(row: { key: string; enabled: boolean; updatedBy: string | null; reason: string | null; updatedAt: Date }): AdminSwitchView {
  return { key: row.key as PaymentSwitchKey, enabled: row.enabled, updatedBy: row.updatedBy, reason: row.reason, updatedAt: row.updatedAt.toISOString() };
}

export async function listSwitches(ctx: PaymentsContext): Promise<{ switches: AdminSwitchView[] }> {
  const rows = await ctx.db.paymentSwitch.findMany({ orderBy: { key: "asc" } });
  return { switches: rows.map(switchView) };
}

/** A switch ON in live mode waits for a second administrator (within 24 hours, since the switch last changed). */
export async function setSwitch(ctx: PaymentsContext, admin: AdminCaller, input: { key?: unknown; enabled?: unknown; reason?: unknown; stepUpGrantId?: unknown }): Promise<{ switch: AdminSwitchView; approvalsRemaining: number }> {
  const key = input?.key;
  if (typeof key !== "string" || !(PAYMENT_SWITCH_KEYS as readonly string[]).includes(key)) refuse("VALIDATION", "Unknown switch.");
  if (typeof input.enabled !== "boolean") refuse("VALIDATION", "enabled is true or false.");
  const enabled = input.enabled;
  const reason = note(input.reason, 200);
  if (!reason) refuse("VALIDATION", "Give the reason.");
  const remaining = await moneyTx(ctx.db, async (tx) => {
    await tx.$queryRaw`SELECT "key" FROM public."PaymentSwitch" WHERE "key" = ${key} FOR UPDATE`;
    const current = await tx.paymentSwitch.findUnique({ where: { key } });
    if (!current) refuse("NOT_FOUND", "Unknown switch.");
    const method = await adminGrant(tx, ctx, admin, input.stepUpGrantId, `switch:${key}`, enabled ? "ON" : "OFF");
    const now = ctx.now();
    await tx.paymentReviewAction.create({
      data: {
        subjectType: "SWITCH", subjectId: key, actorKind: "ADMIN", actorUserId: admin.userId, actorStepUpMethod: method,
        verb: enabled ? "SWITCH_ON" : "SWITCH_OFF", note: reason, metadata: {},
      },
    });
    let left = 0;
    if (enabled && !current.enabled && ctx.config.mode === "live") {
      const since = new Date(Math.max(current.updatedAt.getTime(), now.getTime() - 86_400_000));
      const admins = await distinctAdmins(tx, { subjectType: "SWITCH", subjectId: key, verb: "SWITCH_ON", createdAt: { gte: since } });
      left = Math.max(0, 2 - admins.length);
    }
    if (left === 0 && current.enabled !== enabled) {
      await tx.paymentSwitch.update({ where: { key }, data: { enabled, updatedBy: admin.userId, reason, updatedAt: now } });
    }
    return left;
  }, { label: "admin.switch" });
  logWarn({ audit: "PAYMENTS_SWITCH", adminId: admin.userId, key, enabled, approvalsRemaining: remaining }, "payments switch change recorded");
  if (enabled && remaining === 0) await ctx.kick();
  const row = await ctx.db.paymentSwitch.findUniqueOrThrow({ where: { key } });
  return { switch: switchView(row), approvalsRemaining: remaining };
}

// ---------------------------------------------------------------------------
// Reconciliation, events, custody
// ---------------------------------------------------------------------------

export async function listRuns(ctx: PaymentsContext, query: PageQuery): Promise<Page<AdminReconciliationRunView>> {
  const limit = pageLimit(query?.limit);
  const after = cursorWhere(query?.cursor) as Prisma.ReconciliationRunWhereInput | null;
  const rows = await ctx.db.reconciliationRun.findMany({ where: after ?? {}, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const withCreated = rows.map((row) => ({ ...row, createdAt: row.startedAt }));
  return {
    items: withCreated.slice(0, limit).map((row) => ({
      id: row.id, kind: row.kind as AdminReconciliationRunView["kind"], scopeDate: row.scopeDate ? row.scopeDate.toISOString().slice(0, 10) : null,
      status: row.status, summary: (row.summary ?? {}) as Record<string, unknown>, startedAt: row.startedAt.toISOString(), finishedAt: iso(row.finishedAt),
    })),
    next: nextCursor(withCreated, limit),
  };
}

export async function listIssues(ctx: PaymentsContext, query: PageQuery & { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" }): Promise<Page<AdminReconciliationIssueView>> {
  const limit = pageLimit(query?.limit);
  const status = query?.status === "ACKNOWLEDGED" || query?.status === "RESOLVED" ? query.status : "OPEN";
  const after = cursorWhere(query?.cursor) as Prisma.ReconciliationIssueWhereInput | null;
  const rows = await ctx.db.reconciliationIssue.findMany({ where: { status, ...(after ?? {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id, runId: row.runId, code: row.code, severity: row.severity as AdminReconciliationIssueView["severity"], subjectType: row.subjectType,
      subjectId: row.subjectId, details: (row.details ?? {}) as Record<string, unknown>, status: row.status, resolvedBy: row.resolvedBy,
      resolvedAt: iso(row.resolvedAt), resolution: row.resolution, createdAt: row.createdAt.toISOString(),
    })),
    next: nextCursor(rows, limit),
  };
}

export async function resolveIssue(ctx: PaymentsContext, admin: AdminCaller, issueId: string, input: { status?: unknown; resolution?: unknown; stepUpGrantId?: unknown }): Promise<null> {
  if (!isUuid(issueId)) refuse("NOT_FOUND", "That issue does not exist.");
  const status = input?.status;
  if (status !== "ACKNOWLEDGED" && status !== "RESOLVED") refuse("VALIDATION", "The status is ACKNOWLEDGED or RESOLVED.");
  const resolution = note(input.resolution);
  if (!resolution) refuse("VALIDATION", "Describe the resolution.");
  await moneyTx(ctx.db, async (tx) => {
    const issue = await tx.reconciliationIssue.findUnique({ where: { id: issueId }, select: { status: true } });
    if (!issue) refuse("NOT_FOUND", "That issue does not exist.");
    await adminGrant(tx, ctx, admin, input.stepUpGrantId, `issue:${issueId}`, status);
    if (issue.status === "RESOLVED") refuse("INVALID_STATE", "This issue is already resolved.");
    await tx.reconciliationIssue.update({ where: { id: issueId }, data: { status, resolution, resolvedBy: admin.userId, resolvedAt: ctx.now() } });
  }, { label: "admin.issue.resolve" });
  logInfo({ audit: "PAYMENTS_ISSUE", adminId: admin.userId, issueId, status }, "reconciliation issue updated");
  return null;
}

export async function listEvents(ctx: PaymentsContext, query: PageQuery & { outcome?: "DEAD" | "NEEDS_REVIEW" | "UNKNOWN_OBJECT" }): Promise<Page<AdminPaymentEventView>> {
  const limit = pageLimit(query?.limit);
  const outcome = query?.outcome === "NEEDS_REVIEW" || query?.outcome === "UNKNOWN_OBJECT" ? query.outcome : "DEAD";
  const cursor = typeof query?.cursor === "string" && /^\d{13}:[0-9a-f-]{36}$/.test(query.cursor) ? query.cursor : null;
  const at = cursor ? new Date(Number(cursor.slice(0, 13))) : null;
  const rows = await ctx.db.paymentEvent.findMany({
    where: { outcome, ...(at ? { OR: [{ receivedAt: { lt: at } }, { receivedAt: at, id: { lt: cursor!.slice(14) } }] } : {}) },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: limit + 1,
    select: { id: true, provider: true, providerEventId: true, eventType: true, objectType: true, objectRef: true, outcome: true, attempts: true, lastError: true, receivedAt: true, processedAt: true },
  });
  const withCreated = rows.map((row) => ({ ...row, createdAt: row.receivedAt }));
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id, provider: row.provider, providerEventId: row.providerEventId, eventType: row.eventType, objectType: row.objectType, objectRef: row.objectRef,
      outcome: row.outcome, attempts: row.attempts, lastError: row.lastError, receivedAt: row.receivedAt.toISOString(), processedAt: iso(row.processedAt),
    })),
    next: nextCursor(withCreated, limit),
  };
}

/** A DEAD event gets one more processing attempt (attempts never go down, so it dies again after one more failure). */
export async function requeueEvent(ctx: PaymentsContext, admin: AdminCaller, eventId: string, input: { stepUpGrantId?: unknown }): Promise<null> {
  if (!isUuid(eventId)) refuse("NOT_FOUND", "That event does not exist.");
  await moneyTx(ctx.db, async (tx) => {
    const locked = await tx.$queryRaw<{ outcome: string | null }[]>`SELECT "outcome"::text AS outcome FROM public."PaymentEvent" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
    if (locked.length === 0) refuse("NOT_FOUND", "That event does not exist.");
    await adminGrant(tx, ctx, admin, input?.stepUpGrantId, `event:${eventId}`, "REQUEUE");
    if (locked[0]!.outcome !== "DEAD") refuse("INVALID_STATE", "Only a dead event can be requeued.");
    await tx.$executeRaw`
      UPDATE public."PaymentEvent" SET "processedAt" = NULL, "outcome" = NULL, "nextAttemptAt" = ${ctx.now().toISOString()}::timestamp, "lastError" = 'REQUEUED'
       WHERE "id" = ${eventId}::uuid`;
  }, { label: "admin.event.requeue" });
  logInfo({ audit: "PAYMENTS_EVENT_REQUEUE", adminId: admin.userId, eventId }, "dead payment event requeued");
  await ctx.kick();
  return null;
}

/** The segregated player-funds balance the operator read from the bank, compared with what is owed to players. */
export async function custodySnapshot(ctx: PaymentsContext, admin: AdminCaller, input: { asOf?: unknown; segregatedBalance?: unknown; source?: unknown; stepUpGrantId?: unknown }): Promise<AdminCustodySnapshotResponse> {
  const asOf = typeof input?.asOf === "string" ? new Date(input.asOf) : new Date(NaN);
  if (!Number.isFinite(asOf.getTime()) || asOf.getTime() > ctx.now().getTime() + 300_000) refuse("VALIDATION", "asOf is the ISO time the balance was read.");
  if (typeof input.segregatedBalance !== "string" || !MONEY_AMOUNT_PATTERN.test(input.segregatedBalance)) refuse("VALIDATION", "Enter the balance like 123456.78.");
  const source = note(input.source, 200);
  if (!source) refuse("VALIDATION", "Name the source (bank statement, portal export).");
  const segregatedMinor = parseMinor(input.segregatedBalance, WALLET_DECIMALS);
  const asset = ctx.config.settlementAsset;
  const liabilities = await custodyLiabilities(ctx.db, asset);
  await moneyTx(ctx.db, async (tx) => {
    await adminGrant(tx, ctx, admin, input.stepUpGrantId, `custody:${asOf.toISOString()}`, `SNAPSHOT:${segregatedMinor}`);
    const run = await tx.reconciliationRun.create({
      data: {
        kind: "CUSTODY", scopeDate: new Date(`${asOf.toISOString().slice(0, 10)}T00:00:00.000Z`), status: segregatedMinor < liabilities ? "ISSUES" : "OK",
        startedAt: ctx.now(), finishedAt: ctx.now(),
        summary: { source: "snapshot", asset, asOf: asOf.toISOString(), statement: source, by: admin.userId, segregatedMinor: segregatedMinor.toString(), liabilities: liabilities.toString() },
      },
      select: { id: true },
    });
    if (segregatedMinor < liabilities) {
      await raiseIssue(tx, {
        code: "CUSTODY_SHORTFALL", severity: "CRITICAL", subjectType: "CUSTODY", subjectId: asset,
        details: { liabilities: liabilities.toString(), segregated: segregatedMinor.toString() },
      }, ctx.now(), run.id);
    }
  }, { label: "admin.custody" });
  logInfo({ audit: "PAYMENTS_CUSTODY_SNAPSHOT", adminId: admin.userId, shortfall: segregatedMinor < liabilities }, "custody snapshot recorded");
  return { liabilities: money(liabilities), segregatedBalance: money(segregatedMinor), surplus: money(segregatedMinor - liabilities) };
}
