/**
 * What providers learn about a player: a stable pseudonymous customer id
 * (never our user id), the verified identity for the travel rule, and the
 * request's address and country. Built from PlayerCompliance (KYC data) and
 * the caller.
 */
import { createHash } from "node:crypto";
import type { ComplianceRow } from "./compliance";
import type { CustomerRef, TravelRuleParty } from "./providers/types";

/** 32 characters, deterministic per user (Nuvei userTokenId, BVNK customerId, Sumsub externalUserId). */
export function providerCustomerRef(userId: string): string {
  return `u${createHash("sha256").update(`poker-customer:v1:${userId}`, "utf8").digest("hex").slice(0, 31)}`;
}

export function customerRef(input: { userId: string; email: string | null; emailVerified: boolean; ip: string | null; country: string | null; compliance: ComplianceRow }): CustomerRef {
  const { compliance } = input;
  return {
    userId: input.userId,
    providerCustomerRef: providerCustomerRef(input.userId),
    email: input.emailVerified ? input.email : null,
    country: compliance.residenceCountry ?? input.country,
    legalName: compliance.legalFirstName && compliance.legalLastName ? { first: compliance.legalFirstName, last: compliance.legalLastName } : null,
    ip: input.ip,
  };
}

/** The verified player as a travel-rule party, or null before KYC. */
export function travelRuleParty(compliance: ComplianceRow, type: TravelRuleParty["type"]): TravelRuleParty | null {
  if (compliance.kycStatus !== "VERIFIED" || !compliance.legalFirstName || !compliance.legalLastName || !compliance.birthDate || !compliance.residenceCountry) return null;
  return {
    type,
    firstName: compliance.legalFirstName,
    lastName: compliance.legalLastName,
    dateOfBirth: compliance.birthDate.toISOString().slice(0, 10),
    countryCode: compliance.residenceCountry,
    relationship: "SELF_OWNED",
  };
}
