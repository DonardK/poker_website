/**
 * How payments code refuses (docs/money/WALLET.md sections 8.3 and 11).
 *
 * A refusal decided by our own checks is thrown as WalletRefusal (a
 * PaymentsRefusal, so moneyTx rolls the transaction back and rethrows it
 * untouched). The RPC boundary (answer) turns every error into an
 * RpcFailure: refusals keep their code and details, infrastructure is 503
 * retryable, and anything unexpected is 500 with an alert (never a message
 * from the database or a provider).
 */
import type { StepUpRequirement, WalletErrorCode } from "@poker/shared";
import { errBrief, logError, logWarn } from "../http/log";
import { MoneyTxError, PaymentsInvariant, PaymentsRefusal, PaymentsUnavailable } from "../money/tx";
import { PaymentsConfigError } from "./config";
import { rpcFail, rpcOk, type RpcFailure, type RpcResult } from "./contract";

export class WalletRefusal extends PaymentsRefusal {
  readonly details?: Record<string, string>;
  readonly stepUp?: StepUpRequirement;
  readonly retryable?: boolean;
  constructor(code: WalletErrorCode, message: string, extra: { details?: Record<string, string>; stepUp?: StepUpRequirement; retryable?: boolean } = {}) {
    super("wallet", code, message, null);
    this.name = "WalletRefusal";
    if (extra.details) this.details = extra.details;
    if (extra.stepUp) this.stepUp = extra.stepUp;
    if (extra.retryable !== undefined) this.retryable = extra.retryable;
  }
}

/** Throw a domain refusal (inside a moneyTx it also rolls the transaction back). */
export function refuse(code: WalletErrorCode, message: string, extra?: ConstructorParameters<typeof WalletRefusal>[2]): never {
  throw new WalletRefusal(code, message, extra);
}

/** A provider call that did not give a definite answer before we wrote anything. 503, retryable. */
export class ProviderUnavailable extends Error {
  constructor(readonly provider: string, readonly reason: string) {
    super(`provider ${provider} unavailable (${reason})`);
    this.name = "ProviderUnavailable";
  }
}

/** The error as a failure the caller can show (no SQL, no provider text). */
export function toRpcFailure(error: unknown, label: string): RpcFailure {
  if (error instanceof WalletRefusal) {
    return rpcFail(error.code, error.message, {
      ...(error.details ? { details: error.details } : {}),
      ...(error.stepUp ? { stepUp: error.stepUp } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    });
  }
  if (error instanceof PaymentsRefusal) return rpcFail(error.code, error.message);
  if (error instanceof PaymentsUnavailable) return rpcFail("PAYMENTS_UNAVAILABLE", error.message, { retryable: true });
  if (error instanceof PaymentsInvariant) return rpcFail("INTERNAL", error.message);
  if (error instanceof MoneyTxError) return rpcFail("INTERNAL", "Something went wrong. Nothing was changed.");
  if (error instanceof ProviderUnavailable) {
    logWarn({ label, provider: error.provider, reason: error.reason }, "payment provider unavailable");
    return rpcFail("PROVIDER_UNAVAILABLE", "The payment provider is not responding. Please try again.", { retryable: true });
  }
  if (error instanceof PaymentsConfigError) {
    logError({ alert: "PAYMENTS_CONFIG", label, problems: error.problems.join("; ").slice(0, 500) }, "payments configuration refused");
    return rpcFail("INTERNAL", "Payments are misconfigured.");
  }
  logError({ alert: "PAYMENTS_UNEXPECTED", label, ...errBrief(error) }, "payments call failed unexpectedly");
  return rpcFail("INTERNAL", "Something went wrong. Nothing was changed.");
}

/** Run one RPC method body and answer RpcResult (never throws). */
export async function answer<T>(label: string, run: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return rpcOk(await run());
  } catch (error) {
    return toRpcFailure(error, label);
  }
}
