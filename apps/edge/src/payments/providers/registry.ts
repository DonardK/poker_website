/**
 * Builds the provider adapters of the active mode (docs/money/WALLET.md
 * section 9): one per rail, chosen by CARD_PROVIDER_KEY, CRYPTO_PROVIDER_KEY
 * and KYC_PROVIDER_KEY through the validated config slots (config.ts). A
 * rail whose slot is unavailable, or whose adapter refuses its config or is
 * not written yet, stays closed (METHOD_DISABLED) with the reason logged by
 * setting name; the other rails keep working.
 */
import { randomBytes } from "../../auth/bytes";
import { errBrief, logError, logInfo, logWarn } from "../../http/log";
import type { PaymentsActiveConfig } from "../config";
import type { Providers, Rail } from "../context";
import type { PaymentsEnv } from "../env";
import { createBvnkAdapter } from "./bvnk";
import { createNuveiAdapter } from "./nuvei";
import { createSandboxCardAdapter, createSandboxCryptoAdapter, createSandboxKycAdapter, memorySandboxStore, type SandboxStore } from "./sandbox";
import { createSumsubAdapter } from "./sumsub";
import { ProviderConfigError, ProviderNotImplementedError, type ProviderDeps, type ProviderFetch, type ProviderLog } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Outbound provider HTTP: a timeout, no redirects followed (a redirect is an answer, not a hop). */
export const providerFetch: ProviderFetch = async (request, options) => {
  const signal = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return fetch(new Request(request, { redirect: "manual", signal }));
};

const providerLog: ProviderLog = (level, fields, message) => {
  const tagged = { ...fields, source: "provider" };
  if (level === "error") logError(tagged, message);
  else if (level === "warn") logWarn(tagged, message);
  else logInfo(tagged, message);
};

/** The SandboxPsp object as a SandboxStore (one instance, "sandbox"); memory when the binding is absent (tests). */
let fallbackStore: SandboxStore | null = null;
export function sandboxStoreFor(env: PaymentsEnv): SandboxStore {
  const namespace = env.SANDBOX_PSP;
  if (!namespace) {
    fallbackStore ??= memorySandboxStore();
    return fallbackStore;
  }
  const stub = namespace.getByName("sandbox");
  return {
    get: async <T>(key: string) => (await stub.read(key)) as T | null,
    put: async <T>(key: string, value: T) => { await stub.write(key, value as unknown as string); },
    putIfAbsent: async <T>(key: string, value: T) => (await stub.writeIfAbsent(key, value as unknown as string)) as unknown as T,
    increment: async (key: string) => stub.increment(key),
  };
}

export interface RegistryOptions {
  now: () => Date;
  /** Tests: a sandbox store of their own. */
  sandboxStore?: SandboxStore;
  fetch?: ProviderFetch;
}

export function buildProviders(env: PaymentsEnv, config: PaymentsActiveConfig, options: RegistryOptions): Providers {
  const providers: Providers = { card: null, crypto: null, kyc: null, closed: {} };
  const deps: ProviderDeps = { fetch: options.fetch ?? providerFetch, log: providerLog, now: options.now, randomBytes };
  const sandbox = (secret: string) => ({ store: options.sandboxStore ?? sandboxStoreFor(env), webhookSecret: secret, publicOrigin: config.paymentsPublicOrigin, now: options.now });

  const build = <T>(rail: Rail, make: () => T): T | null => {
    try {
      return make();
    } catch (error) {
      const reason = error instanceof ProviderConfigError ? `${error.setting}: ${error.message}`
        : error instanceof ProviderNotImplementedError ? `${error.operation} not implemented`
        : `adapter failed (${errBrief(error).errName})`;
      providers.closed[rail] = reason.slice(0, 200);
      logError({ alert: "PAYMENTS_PROVIDER_CLOSED", rail, reason: reason.slice(0, 200) }, "payment rail closed: its adapter could not be built");
      return null;
    }
  };

  const card = config.providers.card;
  if (card.status !== "ready") providers.closed.card = card.reason;
  else providers.card = build("card", () => card.kind === "sandbox" ? createSandboxCardAdapter(sandbox(card.config.webhookSecret)) : createNuveiAdapter(card.config, deps));

  const crypto = config.providers.crypto;
  if (crypto.status !== "ready") providers.closed.crypto = crypto.reason;
  else providers.crypto = build("crypto", () => crypto.kind === "sandbox" ? createSandboxCryptoAdapter(sandbox(crypto.config.webhookSecret)) : createBvnkAdapter(crypto.config, deps));

  const kyc = config.providers.kyc;
  if (kyc.status !== "ready") providers.closed.kyc = kyc.reason;
  else providers.kyc = build("kyc", () => kyc.kind === "sandbox" ? createSandboxKycAdapter(sandbox(kyc.config.webhookSecret)) : createSumsubAdapter(kyc.config, deps));

  // The adapter books under the key the config validated (sandbox keys in sandbox mode).
  for (const rail of ["card", "crypto", "kyc"] as const) {
    const adapter = providers[rail];
    const slot = config.providers[rail];
    if (adapter && adapter.key !== slot.key) {
      providers[rail] = null;
      providers.closed[rail] = `adapter key ${adapter.key} is not the configured ${slot.key}`;
      logError({ alert: "PAYMENTS_PROVIDER_CLOSED", rail, adapterKey: adapter.key, configuredKey: slot.key }, "payment rail closed: adapter key mismatch");
    }
  }
  return providers;
}
