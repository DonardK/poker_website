/**
 * Identity verification start (POST /api/wallet/kyc/session, design-wallet
 * section 11.1): a short-lived SDK token from the KYC provider. The result
 * arrives later as a signed KYC webhook, which payments re-reads from the
 * provider before it changes PlayerCompliance (compliance.ts). The provider
 * gets the opaque customer reference as externalUserId, never our user id;
 * results find their player through the applicant this call binds to the
 * account (kycApplicantRef).
 */
import type { KycSessionResponse } from "@poker/shared";
import { moneyTx } from "../money/tx";
import { lockCompliance, readCompliance } from "./compliance";
import type { PaymentsContext } from "./context";
import { providerCustomerRef } from "./customer";
import { ProviderUnavailable, refuse } from "./errors";
import type { CallerUser } from "./session";

export async function startKyc(ctx: PaymentsContext, user: CallerUser, country: string | null): Promise<KycSessionResponse> {
  const provider = ctx.providers.kyc;
  if (!provider) refuse("METHOD_DISABLED", "Identity verification is not available right now.");
  const compliance = await readCompliance(ctx.db, user.id);
  if (compliance.kycStatus === "VERIFIED") refuse("INVALID_STATE", "Your identity is already verified.");
  const slot = ctx.config.providers.kyc;
  const level = slot.status === "ready" && slot.kind === "sumsub" ? slot.config.levelName : "sandbox-basic";
  const ttlSeconds = slot.status === "ready" && slot.kind === "sumsub" ? slot.config.tokenTtlSeconds : 600;
  const session = await provider.createSession({
    userId: user.id, externalUserId: providerCustomerRef(user.id), email: user.emailVerifiedAt ? user.email : null, country: compliance.residenceCountry ?? country, level, ttlSeconds,
  });
  if (session.kind === "uncertain") throw new ProviderUnavailable(provider.key, session.reason);
  if (session.kind === "rejected") throw new ProviderUnavailable(provider.key, `rejected_${session.code}`.slice(0, 64));
  if (session.value.applicantRef && compliance.kycApplicantRef !== session.value.applicantRef) {
    const applicantRef = session.value.applicantRef;
    await moneyTx(ctx.db, async (tx) => {
      const row = await lockCompliance(tx, user.id);
      // The applicant this account started; a result for any other applicant is refused (compliance.ts).
      if (row.kycApplicantRef === null) await tx.playerCompliance.update({ where: { userId: user.id }, data: { kycApplicantRef: applicantRef, kycProvider: provider.key } });
    }, { label: "kyc.start" });
  }
  const origin = ctx.config.paymentsPublicOrigin;
  return {
    provider: provider.key,
    sdkToken: session.value.sdkToken,
    expiresAt: session.value.expiresAt.toISOString(),
    ...(provider.kind === "sandbox" && origin ? { url: `${origin}/sandbox/kyc/${encodeURIComponent(session.value.sdkToken)}` } : {}),
  };
}
