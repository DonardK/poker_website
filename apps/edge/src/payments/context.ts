/**
 * What every payments flow receives: the database client of this event, the
 * validated active configuration, the provider adapters of this mode, a
 * clock, and two hooks (wake the dispatcher, run work after the response).
 * Built by worker.ts for RPC calls, webhooks and alarms; tests build it with
 * fake providers and a fake clock.
 */
import type { PrismaClient } from "../generated/prisma/client";
import type { PaymentsActiveConfig } from "./config";
import type { CardProvider, CryptoProvider, KycProvider, PaymentProvider } from "./providers/types";

export type Rail = "card" | "crypto" | "kyc";

export interface Providers {
  card: CardProvider | null;
  crypto: CryptoProvider | null;
  kyc: KycProvider | null;
  /** Why a rail is closed (setting names only, never values). */
  closed: Partial<Record<Rail, string>>;
}

export interface PaymentsContext {
  db: PrismaClient;
  config: PaymentsActiveConfig;
  providers: Providers;
  now(): Date;
  /** Wake the PayoutDispatcher after a commit that queued work (best effort; the cron is the backstop). */
  kick(): Promise<void>;
  /** Run after the response or RPC answer (ctx.waitUntil). */
  defer(work: Promise<unknown>): void;
}

export type MoneyProvider = CardProvider | CryptoProvider;

/** The configured provider that books under this ledger providerKey, if any. */
export function providerByKey(providers: Providers, key: string): PaymentProvider | null {
  for (const provider of [providers.card, providers.crypto, providers.kyc]) {
    if (provider && provider.key === key) return provider;
  }
  return null;
}

/**
 * The ledger providerKeys this Worker serves. Work queues (payout dispatch,
 * event sweeps, credit retries) take only rows of these keys, so a sandbox
 * Worker that ever shared a database with the live one never touches a live
 * payout or event, and the reverse (INTEGRATION.md override 14).
 */
export function configuredKeys(providers: Providers, kinds: readonly Rail[] = ["card", "crypto", "kyc"]): string[] {
  return kinds.map((kind) => providers[kind]?.key).filter((key): key is string => typeof key === "string");
}

export function moneyProviderByKey(providers: Providers, key: string | null): MoneyProvider | null {
  if (!key) return null;
  if (providers.card?.key === key) return providers.card;
  if (providers.crypto?.key === key) return providers.crypto;
  return null;
}

/** May the player's browser be sent here? https (http only for a loopback sandbox), no credentials, a declared host. */
export function redirectAllowed(provider: MoneyProvider, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = provider.sandbox && (host === "localhost" || host === "127.0.0.1");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
  if (parsed.username || parsed.password) return false;
  return provider.redirectHosts.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

export function isMoneyProvider(provider: PaymentProvider): provider is MoneyProvider {
  return provider.method === "CARD" || provider.method === "CRYPTO";
}
