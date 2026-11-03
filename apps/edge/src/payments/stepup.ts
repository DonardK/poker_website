/**
 * Money step-up (INTEGRATION.md override 8; docs/money/WALLET.md sections
 * 10.5, 10.6 and 10.8). poker-api mints a single-use StepUpGrant after a
 * proof (POST /api/auth/step-up); payments consumes it here, inside the
 * transaction it authorises, with the bindHash of exactly that action
 * (stepUpBind in packages/shared). The account-security trigger lets
 * consumedAt be set once, before expiry by the database clock; the payments
 * guards then require a consumed grant of the right purpose on the row they
 * protect (PM009), so no code path can skip this.
 */
import { STEP_UP_METHODS_BY_PURPOSE, stepUpBind, type StepUpAction, type StepUpGrantMethod, type StepUpPurpose, type StepUpRequirement } from "@poker/shared";
import type { MoneyTx } from "../money/tx";
import { refuse } from "./errors";

export async function requirementFor(action: StepUpAction): Promise<StepUpRequirement> {
  const purpose = action.purpose as StepUpPurpose;
  return { purpose, bind: await stepUpBind(action), methods: [...STEP_UP_METHODS_BY_PURPOSE[purpose]] };
}

const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Consumes the caller's grant for this action, or refuses STEP_UP_REQUIRED
 * with what to step up for (the transaction then rolls back, so nothing else
 * is written). Returns the proof method (PaymentReviewAction.actorStepUpMethod).
 */
export async function consumeGrant(tx: MoneyTx, input: {
  grantId: string | null | undefined;
  userId: string;
  sessionId: string;
  requirement: StepUpRequirement;
}): Promise<StepUpGrantMethod> {
  const { requirement } = input;
  if (typeof input.grantId !== "string" || !GRANT_ID.test(input.grantId)) {
    refuse("STEP_UP_REQUIRED", "Confirm this with your passkey, authenticator app or emailed code.", { stepUp: requirement });
  }
  const methods = STEP_UP_METHODS_BY_PURPOSE[requirement.purpose].join(",");
  const rows = await tx.$queryRaw<{ method: StepUpGrantMethod }[]>`
    UPDATE public."StepUpGrant" SET "consumedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${input.grantId} AND "userId" = ${input.userId} AND "sessionId" = ${input.sessionId}
       AND "purpose" = ${requirement.purpose} AND "bindHash" = ${requirement.bind}
       AND "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
       AND "method" = ANY (string_to_array(${methods}, ','))
    RETURNING "method"`;
  const method = rows[0]?.method;
  if (!method) refuse("STEP_UP_REQUIRED", "That confirmation expired or was for something else. Confirm again.", { stepUp: requirement });
  return method;
}

/**
 * Voids every unconsumed grant of a user ("This wasn't me" lockdown): a grant
 * minted by whoever had the account can no longer authorise anything.
 */
export async function voidGrants(tx: MoneyTx, userId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE public."StepUpGrant" SET "consumedAt" = CURRENT_TIMESTAMP
     WHERE "userId" = ${userId} AND "consumedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP`;
}
