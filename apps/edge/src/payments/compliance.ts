/**
 * PlayerCompliance: the per-user KYC/AML/payments state, and the per-user
 * lock row of every payments flow ([L2] in docs/money/WALLET.md section 10).
 * lockCompliance creates the row on first use and locks it; every flow that
 * moves a user's money takes this lock first, so a user's flows serialise.
 */
import type { PaymentsRestriction } from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";
import { logWarn } from "../http/log";
import type { MoneyTx } from "../money/tx";
import type { KycUpdate } from "./providers/types";

export interface ComplianceRow {
  userId: string;
  kycStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
  kycProvider: string | null;
  kycApplicantRef: string | null;
  kycLevel: string | null;
  kycSubmittedAt: Date | null;
  kycVerifiedAt: Date | null;
  kycReviewDueAt: Date | null;
  legalFirstName: string | null;
  legalLastName: string | null;
  birthDate: Date | null;
  residenceCountry: string | null;
  screeningStatus: "NOT_SCREENED" | "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  sourceOfFundsStatus: "NOT_REQUIRED" | "REQUESTED" | "SUBMITTED" | "APPROVED" | "REJECTED";
  restriction: PaymentsRestriction;
  restrictionReason: string | null;
  restrictedAt: Date | null;
  rgLimitsPromptedAt: Date | null;
  lifetimeDepositedMinor: bigint;
  firstDepositAt: Date | null;
  chargebackCount: number;
  chargebackShortfallMinor: bigint;
}

type Db = PrismaClient | MoneyTx;

/** A sanctions or PEP match is on record: withdrawals and deposits wait until a person decides (admin.ts setScreening). */
export function screeningMatched(row: Pick<ComplianceRow, "screeningStatus">): boolean {
  return row.screeningStatus === "POTENTIAL_MATCH" || row.screeningStatus === "CONFIRMED_MATCH";
}

/** A user who never touched payments has this state. */
export function defaultCompliance(userId: string): ComplianceRow {
  return {
    userId, kycStatus: "UNVERIFIED", kycProvider: null, kycApplicantRef: null, kycLevel: null, kycSubmittedAt: null, kycVerifiedAt: null,
    kycReviewDueAt: null, legalFirstName: null, legalLastName: null, birthDate: null, residenceCountry: null, screeningStatus: "NOT_SCREENED",
    riskLevel: "MEDIUM", sourceOfFundsStatus: "NOT_REQUIRED", restriction: "NONE", restrictionReason: null, restrictedAt: null, rgLimitsPromptedAt: null,
    lifetimeDepositedMinor: 0n, firstDepositAt: null, chargebackCount: 0, chargebackShortfallMinor: 0n,
  };
}

/** Read without a lock (views, gates before a transaction). */
export async function readCompliance(db: Db, userId: string): Promise<ComplianceRow> {
  const row = await db.playerCompliance.findUnique({ where: { userId } });
  return (row as ComplianceRow | null) ?? defaultCompliance(userId);
}

/** [L2] Create-if-missing, then SELECT ... FOR UPDATE. Always the first lock of a user-scoped flow. */
export async function lockCompliance(tx: MoneyTx, userId: string): Promise<ComplianceRow> {
  await tx.$executeRaw`INSERT INTO public."PlayerCompliance" ("userId") VALUES (${userId}) ON CONFLICT ("userId") DO NOTHING`;
  await tx.$queryRaw`SELECT "userId" FROM public."PlayerCompliance" WHERE "userId" = ${userId} FOR UPDATE`;
  return readCompliance(tx, userId);
}

/**
 * Two restrictions at once: the stricter one, and DEPOSITS_BLOCKED together
 * with WITHDRAWALS_MANUAL is FROZEN. A restriction is never loosened here
 * (only an admin UNRESTRICT does that).
 */
export function combineRestriction(current: PaymentsRestriction, added: PaymentsRestriction): PaymentsRestriction {
  if (current === added || added === "NONE") return current;
  if (current === "NONE") return added;
  return "FROZEN";
}

/** Adds a restriction (combineRestriction); the reason of the first restriction is kept, extra reasons are appended. */
export async function restrict(tx: MoneyTx, row: ComplianceRow, added: PaymentsRestriction, reason: string, by: string | null, now: Date): Promise<PaymentsRestriction> {
  const next = combineRestriction(row.restriction, added);
  if (next === row.restriction && row.restrictionReason?.split(",").includes(reason)) return next;
  const reasons = [...new Set([...(row.restrictionReason ? row.restrictionReason.split(",") : []), reason])].join(",").slice(0, 500);
  await tx.playerCompliance.update({
    where: { userId: row.userId },
    data: { restriction: next, restrictionReason: reasons, restrictedAt: row.restriction === "NONE" ? now : undefined, restrictedBy: by ?? "SYSTEM" },
  });
  row.restriction = next;
  row.restrictionReason = reasons;
  return next;
}

const COUNTRY = /^[A-Z]{2}$/;
const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type KycApplyOutcome = "APPLIED" | "STALE" | "NEEDS_REVIEW";

/**
 * A verification result from the KYC provider (always re-read from the
 * provider, never taken from a webhook body). VERIFIED needs the verified
 * identity (the CHECK requires names, birth date and country); without it the
 * player stays PENDING and ops is alerted. The applicant must be the one this
 * user started (kycApplicantRef), so a result for another applicant cannot
 * verify this account. An automatic CLEAR never lifts a match on record: a
 * person does that.
 */
export async function applyKycUpdate(tx: MoneyTx, input: { userId: string; providerKey: string; update: KycUpdate; now: Date }): Promise<KycApplyOutcome> {
  const { update, now } = input;
  const row = await lockCompliance(tx, input.userId);
  if (row.kycApplicantRef && row.kycApplicantRef !== update.applicantRef) {
    logWarn({ alert: "KYC_APPLICANT_MISMATCH", userId: input.userId, provider: input.providerKey }, "KYC result for another applicant ignored");
    return "NEEDS_REVIEW";
  }
  const base = { kycProvider: input.providerKey, kycApplicantRef: update.applicantRef, kycLevel: update.level ?? row.kycLevel };
  switch (update.decision) {
    case "PENDING":
      if (row.kycStatus === "PENDING") return "STALE";
      await tx.playerCompliance.update({ where: { userId: row.userId }, data: { ...base, kycStatus: "PENDING", kycSubmittedAt: row.kycSubmittedAt ?? now } });
      return "APPLIED";
    case "VERIFIED": {
      const identity = update.identity;
      if (!identity || !identity.firstName || !identity.lastName || !BIRTH_DATE.test(identity.birthDate) || !COUNTRY.test(identity.country)) {
        logWarn({ alert: "KYC_IDENTITY_MISSING", userId: input.userId, provider: input.providerKey }, "verified KYC result without a usable identity; player left PENDING");
        if (row.kycStatus !== "PENDING") {
          await tx.playerCompliance.update({ where: { userId: row.userId }, data: { ...base, kycStatus: "PENDING", kycSubmittedAt: row.kycSubmittedAt ?? now } });
        }
        return "NEEDS_REVIEW";
      }
      const matched = row.screeningStatus === "POTENTIAL_MATCH" || row.screeningStatus === "CONFIRMED_MATCH";
      const screening = update.screening === "CLEAR" && matched ? undefined : update.screening;
      if (update.screening === "CLEAR" && matched) logWarn({ alert: "KYC_CLEAR_IGNORED", userId: input.userId, provider: input.providerKey }, "a passed review did not lift a screening match");
      await tx.playerCompliance.update({
        where: { userId: row.userId },
        data: {
          ...base,
          kycStatus: "VERIFIED",
          kycVerifiedAt: now,
          kycSubmittedAt: row.kycSubmittedAt ?? now,
          kycRejectReason: null,
          kycReviewDueAt: update.reviewDueAt ?? null,
          legalFirstName: identity.firstName.slice(0, 100),
          legalLastName: identity.lastName.slice(0, 100),
          birthDate: new Date(`${identity.birthDate}T00:00:00.000Z`),
          residenceCountry: identity.country,
          ...(screening ? { screeningStatus: screening, screenedAt: now } : {}),
        },
      });
      return "APPLIED";
    }
    case "REJECTED":
    case "RESUBMISSION_REQUESTED":
      await tx.playerCompliance.update({
        where: { userId: row.userId },
        data: {
          ...base,
          kycStatus: "REJECTED",
          kycRejectedAt: now,
          kycRejectReason: (update.rejectReason ?? (update.decision === "RESUBMISSION_REQUESTED" ? "RESUBMISSION_REQUESTED" : "REJECTED")).slice(0, 200),
          ...(update.screening ? { screeningStatus: update.screening, screenedAt: now } : {}),
        },
      });
      return "APPLIED";
  }
}
