/**
 * readPaymentsConfig (src/payments/config.ts): "off" needs nothing and never
 * fails; the mode safety rules throw; provider secrets are optional and a
 * provider without usable ones keeps only its own rail closed; the
 * settlement asset follows the mode; USDT is never offered to EEA residents.
 */
import { describe, expect, it } from "vitest";
import { PaymentsConfigError, readPaymentsConfig, usdtAllowedFor, type PaymentsActiveConfig, type PaymentsVars } from "../../src/payments/config";
import type { PaymentsEnv } from "../../src/payments/env";
import { buildProviders } from "../../src/payments/providers/registry";

/** A fresh random hex secret per call: nothing here is a value anyone could copy. */
function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SANDBOX: PaymentsVars = {
  ENVIRONMENT: "preview",
  PAYMENTS_MODE: "sandbox",
  PUBLIC_SITE_ORIGIN: "https://poker-web-preview.example.workers.dev",
  PAYMENTS_PUBLIC_ORIGIN: "https://poker-payments-preview.example.workers.dev",
  SANDBOX_WEBHOOK_SECRET: "test-only-sandbox-webhook-secret-32ch",
};

function live(overrides: PaymentsVars = {}): PaymentsVars {
  return {
    ENVIRONMENT: "production",
    PAYMENTS_MODE: "live",
    PUBLIC_SITE_ORIGIN: "https://poker.example.com",
    PAYMENTS_PUBLIC_ORIGIN: "https://poker-payments.example.workers.dev",
    REAL_MONEY_COUNTRIES: "MT",
    ADMIN_REQUIRE_CF_ACCESS: "true",
    CF_ACCESS_AUD: "aud-tag",
    CF_ACCESS_TEAM_DOMAIN: "pokerteam",
    CARD_PROVIDER_KEY: "nuvei",
    CRYPTO_PROVIDER_KEY: "bvnk",
    KYC_PROVIDER_KEY: "sumsub",
    NUVEI_MERCHANT_ID: "1234567890",
    NUVEI_MERCHANT_SITE_ID: "123456",
    NUVEI_SECRET_KEY: secret(),
    BVNK_WALLET_ID_EUR: "a1b2c3d4-0000-4000-8000-000000000001",
    BVNK_ASSET_MAP: JSON.stringify({ BTC: { payCurrency: "BTC", network: "BITCOIN" }, USDC_ERC20: { payCurrency: "USDC", network: "ETHEREUM" } }),
    BVNK_HAWK_AUTH_ID: "hawk-id-1",
    BVNK_HAWK_AUTH_KEY: secret(),
    BVNK_WEBHOOK_SECRET: secret(),
    SUMSUB_APP_TOKEN: `prd:${secret()}`,
    SUMSUB_SECRET_KEY: secret(),
    SUMSUB_WEBHOOK_SECRET: secret(),
    SUMSUB_LEVEL_NAME: "basic-kyc-level",
    SUMSUB_SCREENING_INCLUDED: "true",
    ...overrides,
  };
}

const active = (vars: PaymentsVars): PaymentsActiveConfig => {
  const config = readPaymentsConfig(vars);
  if (config.mode === "off") throw new Error("expected an active config");
  return config;
};

const refusal = (vars: PaymentsVars): string => {
  try {
    readPaymentsConfig(vars);
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsConfigError);
    return (error as PaymentsConfigError).message;
  }
  throw new Error("expected PaymentsConfigError");
};

describe("SUMSUB_SCREENING_INCLUDED", () => {
  const slot = (overrides: PaymentsVars) => {
    const config = readPaymentsConfig(live(overrides));
    if (config.mode === "off") throw new Error("off");
    return config.providers.kyc;
  };

  it("live mode needs it true: unset or false closes the KYC rail (deposits could never be withdrawn), anything else too", () => {
    expect(slot({ SUMSUB_SCREENING_INCLUDED: "true" })).toMatchObject({ status: "ready", config: { screeningIncluded: true } });
    for (const value of [undefined, "false", "0"]) {
      expect(slot({ SUMSUB_SCREENING_INCLUDED: value })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("SUMSUB_SCREENING_INCLUDED must be true in live mode") });
    }
    expect(slot({ SUMSUB_SCREENING_INCLUDED: "yes" })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("must be true or false") });
  });

  it("sandbox mode may leave it false (the default)", () => {
    const sandbox = (value: string | undefined) => {
      const config = readPaymentsConfig(live({ ENVIRONMENT: "preview", PAYMENTS_MODE: "sandbox", ADMIN_REQUIRE_CF_ACCESS: "false", CF_ACCESS_AUD: "", CF_ACCESS_TEAM_DOMAIN: "", SUMSUB_SCREENING_INCLUDED: value }));
      if (config.mode === "off") throw new Error("off");
      return config.providers.kyc;
    };
    expect(sandbox(undefined)).toMatchObject({ status: "ready", config: { screeningIncluded: false } });
    expect(sandbox("true")).toMatchObject({ status: "ready", config: { screeningIncluded: true } });
  });
});

describe("PAYMENTS_MODE=off", () => {
  it("is the default, needs no secret and never throws, whatever else is set", () => {
    expect(readPaymentsConfig({})).toEqual({ mode: "off", environment: "production", settlementAsset: null, problems: [] });
    const messy = readPaymentsConfig({ PAYMENTS_MODE: "off", SETTLEMENT_ASSET: "BTC", WITHDRAWAL_QUOTE_TTL: "1y", CARD_PROVIDER_KEY: "stripe", WEBHOOK_IP_ALLOWLIST: "{" });
    expect(messy).toMatchObject({ mode: "off", settlementAsset: null });
  });

  it("an unknown mode is off, reported by name", () => {
    const config = readPaymentsConfig({ PAYMENTS_MODE: "on" });
    expect(config.mode).toBe("off");
    expect(config.problems.join()).toContain("PAYMENTS_MODE");
  });
});

describe("PAYMENTS_MODE=sandbox", () => {
  it("books TEST_EUR through the built-in sandbox on every rail", () => {
    const config = active(SANDBOX);
    expect(config).toMatchObject({ mode: "sandbox", environment: "preview", settlementAsset: "TEST_EUR", kycBeforeDeposit: true, allowWithdrawalCancel: false });
    expect(config.providers.card).toMatchObject({ kind: "sandbox", key: "sandbox-card", status: "ready" });
    expect(config.providers.crypto).toMatchObject({ kind: "sandbox", key: "sandbox-crypto", status: "ready" });
    expect(config.providers.kyc).toMatchObject({ kind: "sandbox", key: "sandbox-kyc", status: "ready" });
    expect(config.limits).toMatchObject({ depositMinMinor: 1_000n, depositMaxMinor: 500_000n, withdrawalMinMinor: 2_000n, dualApprovalMinMinor: 500_000n });
    expect(config.newDestinationCooldownMs).toBe(86_400_000);
    expect(config.withdrawalQuoteTtlMs).toBe(120_000);
  });

  it("is refused in production (also when ENVIRONMENT is absent or unknown)", () => {
    expect(refusal({ ...SANDBOX, ENVIRONMENT: "production" })).toContain("PAYMENTS_MODE=sandbox");
    expect(refusal({ ...SANDBOX, ENVIRONMENT: undefined })).toContain("PAYMENTS_MODE=sandbox");
    expect(refusal({ ...SANDBOX, ENVIRONMENT: "staging" })).toContain("PAYMENTS_MODE=sandbox");
  });

  it("a missing sandbox secret closes the rails, it does not throw", () => {
    const config = active({ ...SANDBOX, SANDBOX_WEBHOOK_SECRET: undefined });
    for (const slot of Object.values(config.providers)) expect(slot).toMatchObject({ status: "unavailable", reason: expect.stringContaining("SANDBOX_WEBHOOK_SECRET") });
    expect(active({ ...SANDBOX, SANDBOX_WEBHOOK_SECRET: "short" }).providers.card).toMatchObject({ status: "unavailable" });
  });

  it("a real provider in sandbox mode uses its test environment and a sandbox ledger key (TEST_EUR only)", () => {
    const vars = { ...live({ ENVIRONMENT: "preview", PAYMENTS_MODE: "sandbox", ADMIN_REQUIRE_CF_ACCESS: "false", CF_ACCESS_AUD: "", CF_ACCESS_TEAM_DOMAIN: "" }) };
    const config = active(vars);
    expect(config.settlementAsset).toBe("TEST_EUR");
    expect(config.providers.card).toMatchObject({ kind: "nuvei", key: "sandbox-nuvei", status: "ready", config: { env: "int", notifyUrl: "https://poker-payments.example.workers.dev/webhooks/sandbox-nuvei" } });
    expect(config.providers.crypto).toMatchObject({ kind: "bvnk", key: "sandbox-bvnk", status: "ready", config: { env: "sandbox" } });
    expect(config.providers.kyc).toMatchObject({ kind: "sumsub", key: "sandbox-sumsub", status: "ready" });
    // A production provider environment is refused in sandbox mode (that rail only).
    const wrong = active({ ...vars, NUVEI_ENV: "prod" });
    expect(wrong.providers.card).toMatchObject({ status: "unavailable", reason: expect.stringContaining("NUVEI_ENV") });
    expect(wrong.providers.crypto.status).toBe("ready");
  });

  it("SETTLEMENT_ASSET may only repeat the derived asset", () => {
    expect(active({ ...SANDBOX, SETTLEMENT_ASSET: "TEST_EUR" }).settlementAsset).toBe("TEST_EUR");
    expect(refusal({ ...SANDBOX, SETTLEMENT_ASSET: "EUR" })).toContain("SETTLEMENT_ASSET must be TEST_EUR");
  });
});

describe("PAYMENTS_MODE=live", () => {
  it("books EUR through the real providers under their own ledger keys", () => {
    const config = active(live());
    expect(config).toMatchObject({ mode: "live", settlementAsset: "EUR", realMoneyCountries: ["MT"], admin: { requireCfAccess: true, accessAud: "aud-tag", accessTeamDomain: "pokerteam" } });
    expect(config.providers.card).toMatchObject({ kind: "nuvei", key: "nuvei", status: "ready", config: { env: "prod", depositUi: "payment_page", idempotencyConfirmed: false } });
    expect(config.providers.crypto).toMatchObject({ kind: "bvnk", key: "bvnk", status: "ready", config: { env: "production", webhookScheme: "v2_base64", egress: { mode: "direct" } } });
    expect(config.providers.kyc).toMatchObject({ kind: "sumsub", key: "sumsub", status: "ready", config: { baseUrl: "https://api.sumsub.com", tokenTtlSeconds: 600 } });
  });

  it("refuses to start without Cloudflare Access, outside production, with the sandbox, without countries, or on http", () => {
    expect(refusal(live({ ADMIN_REQUIRE_CF_ACCESS: "false" }))).toContain("ADMIN_REQUIRE_CF_ACCESS=true");
    expect(refusal(live({ CF_ACCESS_AUD: "" }))).toContain("CF_ACCESS_AUD");
    expect(refusal(live({ CF_ACCESS_TEAM_DOMAIN: undefined }))).toContain("CF_ACCESS_TEAM_DOMAIN");
    expect(refusal(live({ ENVIRONMENT: "preview" }))).toContain("ENVIRONMENT=production");
    expect(refusal(live({ CARD_PROVIDER_KEY: "sandbox" }))).toContain("CARD_PROVIDER_KEY=sandbox");
    expect(refusal(live({ KYC_PROVIDER_KEY: undefined }))).toContain("KYC_PROVIDER_KEY=sandbox");
    expect(refusal(live({ CRYPTO_PROVIDER_KEY: "coinspaid" }))).toContain("CRYPTO_PROVIDER_KEY must be one of sandbox, bvnk");
    expect(refusal(live({ REAL_MONEY_COUNTRIES: "" }))).toContain("REAL_MONEY_COUNTRIES");
    expect(refusal(live({ REAL_MONEY_COUNTRIES: "Malta" }))).toContain("REAL_MONEY_COUNTRIES");
    expect(refusal(live({ PUBLIC_SITE_ORIGIN: "http://poker.example.com" }))).toContain("PUBLIC_SITE_ORIGIN");
    expect(refusal(live({ SETTLEMENT_ASSET: "TEST_EUR" }))).toContain("SETTLEMENT_ASSET must be EUR");
    expect(refusal(live({ WITHDRAWAL_QUOTE_TTL: "11m" }))).toContain("WITHDRAWAL_QUOTE_TTL");
    expect(refusal(live({ DEPOSIT_MIN_MINOR: "10.00" }))).toContain("DEPOSIT_MIN_MINOR");
    expect(refusal(live({ WEBHOOK_IP_ALLOWLIST: "[1,2]" }))).toContain("WEBHOOK_IP_ALLOWLIST");
  });

  it("a provider without usable secrets closes only its own rail (fail closed per provider)", () => {
    const noNuvei = active(live({ NUVEI_SECRET_KEY: undefined }));
    expect(noNuvei.providers.card).toMatchObject({ kind: "nuvei", status: "unavailable", reason: "NUVEI_SECRET_KEY is not set" });
    expect(noNuvei.providers.crypto.status).toBe("ready");
    expect(noNuvei.providers.kyc.status).toBe("ready");
    expect(active(live({ BVNK_HAWK_AUTH_KEY: "too-short" })).providers.crypto).toMatchObject({ status: "unavailable", reason: expect.stringContaining("BVNK_HAWK_AUTH_KEY must be at least 32") });
    expect(active(live({ SUMSUB_WEBHOOK_SECRET: "replace-me-with-the-real-sumsub-webhook-secret" })).providers.kyc)
      .toMatchObject({ status: "unavailable", reason: expect.stringContaining("placeholder") });
    expect(active(live({ BVNK_ASSET_MAP: "{}" })).providers.crypto).toMatchObject({ status: "unavailable", reason: expect.stringContaining("BVNK_ASSET_MAP") });
    expect(active(live({ BVNK_WEBHOOK_SCHEME: "legacy_hex" })).providers.crypto).toMatchObject({ status: "unavailable", reason: expect.stringContaining("v2_base64") });
    expect(active(live({ PAYMENTS_EGRESS_MODE: "relay" })).providers.crypto).toMatchObject({ status: "unavailable", reason: expect.stringContaining("PAYMENTS_EGRESS") });
    expect(active(live({ PAYMENTS_EGRESS_MODE: "relay", PAYMENTS_EGRESS_RELAY_URL: "https://relay.example.com" })).providers.crypto)
      .toMatchObject({ status: "ready", config: { egress: { mode: "relay", relayUrl: "https://relay.example.com" } } });
    expect(active(live({ NUVEI_DEPOSIT_UI: "simply_connect" })).providers.card).toMatchObject({ status: "unavailable" });
    expect(active(live({ PAYMENTS_PUBLIC_ORIGIN: undefined })).providers.card).toMatchObject({ status: "unavailable", reason: expect.stringContaining("PAYMENTS_PUBLIC_ORIGIN") });
  });

  it("every secret must be distinct: a reused one closes the rail that reuses it", () => {
    const shared = secret();
    const config = active(live({ NUVEI_SECRET_KEY: shared, BVNK_WEBHOOK_SECRET: shared }));
    expect(config.providers.card.status).toBe("ready");
    expect(config.providers.crypto).toMatchObject({ status: "unavailable", reason: "BVNK_WEBHOOK_SECRET must differ from NUVEI_SECRET_KEY" });
    expect(active(live({ NOTIFY_LINK_SECRET: shared, SUMSUB_SECRET_KEY: shared })).providers.kyc).toMatchObject({ status: "unavailable" });
  });

  it("USDT is never offered to EEA residents; prepaid cards are never allowed", () => {
    const vars = live({ CRYPTO_PAY_ASSETS: "USDC_ERC20,USDT_TRC20,BTC", CARD_FUNDING_ALLOWED: "debit,credit,prepaid" });
    const config = active(vars);
    expect(config.cryptoPayAssets).toEqual(["USDC_ERC20", "BTC"]);
    expect(config.cardFundingAllowed).toEqual(["debit", "credit"]);
    expect(config.problems.join(" ")).toContain("USDT");
    expect(usdtAllowedFor(config, "USDT_TRC20", "US")).toBe(false);
    const allowed = active({ ...vars, CRYPTO_ALLOW_USDT_NON_EEA: "true" });
    expect(allowed.cryptoPayAssets).toEqual(["USDC_ERC20", "USDT_TRC20", "BTC"]);
    expect(usdtAllowedFor(allowed, "USDT_TRC20", "US")).toBe(true);
    expect(usdtAllowedFor(allowed, "USDT_TRC20", "MT")).toBe(false);
    expect(usdtAllowedFor(allowed, "USDT_TRC20", null)).toBe(false);
    expect(usdtAllowedFor(allowed, "BTC", "MT")).toBe(true);
  });

  it("takes BVNK's documented wallet ids and nothing looser", () => {
    expect(active(live({ BVNK_WALLET_ID_EUR: "a:24092328494070:G5i4XZ9:1" })).providers.crypto.status).toBe("ready");
    expect(active(live({ BVNK_WALLET_ID_EUR: "a b" })).providers.crypto.status).not.toBe("ready");
    expect(active(live({ BVNK_WALLET_ID_EUR: "a/b" })).providers.crypto.status).not.toBe("ready");
  });

  it("gives Sumsub the mode, and an adapter that refuses its config closes only its own rail", () => {
    const config = active(live());
    const kyc = config.providers.kyc;
    expect(kyc.status === "ready" && kyc.kind === "sumsub" ? kyc.config.mode : null).toBe("live");
    const clean = buildProviders({} as PaymentsEnv, config, { now: () => new Date() });
    expect([clean.card?.key, clean.crypto?.key, clean.kyc?.key]).toEqual(["nuvei", "bvnk", "sumsub"]);
    const wrongToken = active(live({ SUMSUB_APP_TOKEN: `sbx:${secret()}` }));
    const closed = buildProviders({} as PaymentsEnv, wrongToken, { now: () => new Date() });
    expect(closed.kyc).toBeNull();
    expect(closed.closed.kyc).toContain("SUMSUB_APP_TOKEN");
    expect([closed.card?.key, closed.crypto?.key]).toEqual(["nuvei", "bvnk"]);
  });

  it("durations and limits parse strictly; the destination cooling-off may be shorter than the database's 24 h floor", () => {
    const config = active(live({ NEW_DESTINATION_COOLDOWN: "1m", DEPOSIT_SESSION_TTL: "45m", WITHDRAWAL_QUOTE_TTL: "90", AUTO_APPROVE_MAX_MINOR: "0" }));
    expect(config.newDestinationCooldownMs).toBe(60_000);
    expect(config.depositSessionTtlMs).toBe(2_700_000);
    expect(config.withdrawalQuoteTtlMs).toBe(90_000);
    expect(config.limits.autoApproveMaxMinor).toBe(0n);
    expect(refusal(live({ NEW_DESTINATION_COOLDOWN: "30s" }))).toContain("NEW_DESTINATION_COOLDOWN");
  });
});
