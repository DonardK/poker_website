import type { QuoteView, StepUpGrantMethod, StepUpRequirement } from "@poker/shared";
import { payoutDestinationAction, STEP_UP_GRANT_METHODS, STEP_UP_PURPOSES, stepUpBind, withdrawalAction } from "@poker/shared";
import { ApiError } from "@/lib/api";
import { toMinor } from "@/lib/money";

/**
 * SECURITY: what you see is what you confirm. A money step-up grant is bound
 * to `bind`, the hash of one canonical action (stepUpBind in
 * packages/shared/src/wallet.ts, the same function the payments Worker
 * uses). The API hands the bind over with the quote or the prepared
 * address; before asking the player to confirm, the page recomputes it from
 * exactly the facts it shows them (amount, fee, destination, address) and
 * refuses to go on when the two differ. A confirmation can then never be
 * spent on an action other than the one on screen, whatever the API says.
 */
export class BindMismatch extends Error {
  constructor() {
    super("The confirmation request does not match what is on screen.");
    this.name = "BindMismatch";
  }
}

/** The bind of a withdrawal of exactly this quote to this destination. */
export async function withdrawalBind(input: { userId: string; instrumentId: string; quote: QuoteView }): Promise<string> {
  const amountMinor = toMinor(input.quote.amount);
  const feeMinor = toMinor(input.quote.fee);
  if (amountMinor === null || feeMinor === null) throw new BindMismatch();
  return stepUpBind(withdrawalAction({
    userId: input.userId,
    asset: input.quote.asset,
    instrumentId: input.instrumentId,
    amountMinor: amountMinor.toString(),
    feeMinor: feeMinor.toString(),
    quoteId: input.quote.id,
  }));
}

/**
 * The form of an address the payments Worker stores and binds
 * (apps/edge/src/payments/crypto-address.ts normalizeCryptoAddress): an EVM
 * address in lower case (the API shows it with its EIP-55 mixed-case
 * checksum, which is the same address) and a bech32 bitcoin address in lower
 * case; base58 addresses are case-sensitive and stay exactly as shown.
 */
export function canonicalAddress(network: string, address: string): string {
  const value = address.trim();
  if (network === "ethereum" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (network === "bitcoin" && /^bc1/i.test(value)) return value.toLowerCase();
  return value;
}

/** The bind of saving exactly this payout address (as the prepare step showed it). */
export function payoutDestinationBind(input: { userId: string; asset: string; network: string; address: string; memo: string | null }): Promise<string> {
  return stepUpBind(payoutDestinationAction({
    userId: input.userId, asset: input.asset, addressNormalized: canonicalAddress(input.network, input.address), memo: input.memo,
  }));
}

/** The requirement, once its purpose and bind are the ones expected; otherwise BindMismatch. */
export function checkRequirement(requirement: StepUpRequirement, expected: { purpose: StepUpRequirement["purpose"]; bind: string }): StepUpRequirement {
  if (requirement.purpose !== expected.purpose || requirement.bind !== expected.bind) throw new BindMismatch();
  return requirement;
}

/**
 * The requirement in a 403 STEP_UP_REQUIRED body ({ purpose, bind, methods }),
 * e.g. when a grant expired between the confirmation and the request; null
 * for any other error or a malformed body.
 */
export function stepUpRequirementOf(err: unknown): StepUpRequirement | null {
  if (!(err instanceof ApiError) || err.status !== 403 || err.code !== "STEP_UP_REQUIRED") return null;
  const { purpose, bind, methods } = err.details;
  if (typeof purpose !== "string" || !(STEP_UP_PURPOSES as readonly string[]).includes(purpose)) return null;
  if (typeof bind !== "string" || !/^[0-9a-f]{64}$/.test(bind)) return null;
  const known = Array.isArray(methods)
    ? methods.filter((m): m is StepUpGrantMethod => typeof m === "string" && (STEP_UP_GRANT_METHODS as readonly string[]).includes(m))
    : [];
  return { purpose: purpose as StepUpRequirement["purpose"], bind, methods: known };
}
