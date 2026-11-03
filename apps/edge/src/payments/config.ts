/**
 * poker-payments configuration (docs/money/WALLET.md sections 3.1 and 12;
 * design-payments section 14). Read once per request from the Worker's vars
 * and secrets (wrangler.payments.jsonc, `wrangler secret put`).
 *
 * Three layers, so a missing provider secret never takes the Worker down:
 * - PAYMENTS_MODE (off | sandbox | live). "off" (the default and production
 *   today) needs nothing and never fails: a bad setting is only reported.
 * - Mode safety, which throws PaymentsConfigError (the Worker answers 500 and
 *   logs it): sandbox in ENVIRONMENT=production; live outside production,
 *   without ADMIN_REQUIRE_CF_ACCESS=true and both CF_ACCESS_* values, with
 *   the built-in sandbox as a provider, with an empty REAL_MONEY_COUNTRIES,
 *   or a plain-http site origin; a SETTLEMENT_ASSET that contradicts the mode;
 *   an unparsable limit or duration.
 * - Providers. Every provider secret is optional. Each rail (card, crypto,
 *   KYC) gets a slot that is "ready" with the adapter's config, or
 *   "unavailable" with the reason (variable names only): a rail whose
 *   provider lacks a secret, has a short, placeholder or reused one, or points
 *   at the wrong provider environment for the mode stays closed (METHOD_DISABLED)
 *   while the other rails work.
 *
 * SETTLEMENT_ASSET is derived: TEST_EUR in sandbox mode, EUR in live mode
 * (INTEGRATION.md override 14); the variable may only repeat that value.
 * USDT is never offered to EEA residents (design-payments section 2.3): it is
 * dropped from CRYPTO_PAY_ASSETS unless CRYPTO_ALLOW_USDT_NON_EEA=true, and
 * then only for players outside the EEA (usdtAllowedFor).
 */
import { z } from "zod";
import type { PaymentsMode, SettlementAsset } from "@poker/shared";
import { PLACEHOLDER_SECRET } from "../game/key-ring";
import {
  providerLedgerKey,
  type BvnkConfig,
  type CardProviderKind,
  type CryptoProviderKind,
  type KycProviderKind,
  type NuveiConfig,
  type SandboxConfig,
  type SumsubConfig,
} from "./providers/types";

/** The vars and secrets this module reads (PaymentsEnv in the Worker extends it with bindings). */
export interface PaymentsVars {
  ENVIRONMENT?: string;
  PAYMENTS_MODE?: string;
  SETTLEMENT_ASSET?: string;
  PUBLIC_SITE_ORIGIN?: string;
  /** This Worker's public origin, for provider notification URLs (https://poker-payments.<account>.workers.dev). */
  PAYMENTS_PUBLIC_ORIGIN?: string;
  REAL_MONEY_COUNTRIES?: string;
  KYC_BEFORE_DEPOSIT?: string;
  KYC_CDD_THRESHOLD_MINOR?: string;
  SOF_THRESHOLD_MINOR?: string;
  DEPOSIT_MIN_MINOR?: string;
  DEPOSIT_MAX_MINOR?: string;
  WITHDRAWAL_MIN_MINOR?: string;
  WITHDRAWAL_MAX_MINOR?: string;
  AUTO_APPROVE_MAX_MINOR?: string;
  AUTO_APPROVE_DAILY_MAX_MINOR?: string;
  DUAL_APPROVAL_MIN_MINOR?: string;
  NEW_DESTINATION_COOLDOWN?: string;
  DEPOSIT_SESSION_TTL?: string;
  WITHDRAWAL_QUOTE_TTL?: string;
  ALLOW_WITHDRAWAL_CANCEL?: string;
  CARD_FUNDING_ALLOWED?: string;
  CRYPTO_PAY_ASSETS?: string;
  CRYPTO_ALLOW_USDT_NON_EEA?: string;
  CARD_PROVIDER_KEY?: string;
  CRYPTO_PROVIDER_KEY?: string;
  KYC_PROVIDER_KEY?: string;
  PAYMENTS_EGRESS_MODE?: string;
  PAYMENTS_EGRESS_RELAY_URL?: string;
  ADMIN_REQUIRE_CF_ACCESS?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** JSON {"<providerKey>": ["<cidr>", ...]}; a provider without an entry is not IP-filtered. */
  WEBHOOK_IP_ALLOWLIST?: string;
  /** Signs the short-lived links in payment emails ("This wasn't me"). */
  NOTIFY_LINK_SECRET?: string;
  // Nuvei (card)
  NUVEI_ENV?: string;
  NUVEI_MERCHANT_ID?: string;
  NUVEI_MERCHANT_SITE_ID?: string;
  NUVEI_DEPOSIT_UI?: string;
  NUVEI_IDEMPOTENCY_CONFIRMED?: string;
  NUVEI_SECRET_KEY?: string;
  NUVEI_SECRET_KEY_PREVIOUS?: string;
  // BVNK (crypto)
  BVNK_ENV?: string;
  BVNK_WALLET_ID_EUR?: string;
  BVNK_ASSET_MAP?: string;
  BVNK_WEBHOOK_SCHEME?: string;
  BVNK_HAWK_AUTH_ID?: string;
  BVNK_HAWK_AUTH_KEY?: string;
  BVNK_WEBHOOK_SECRET?: string;
  BVNK_WEBHOOK_SECRET_PREVIOUS?: string;
  // Sumsub (KYC)
  SUMSUB_BASE_URL?: string;
  SUMSUB_APP_TOKEN?: string;
  SUMSUB_SECRET_KEY?: string;
  SUMSUB_WEBHOOK_SECRET?: string;
  SUMSUB_LEVEL_NAME?: string;
  SUMSUB_TOKEN_TTL?: string;
  SUMSUB_SCREENING_INCLUDED?: string;
  // Built-in sandbox
  SANDBOX_WEBHOOK_SECRET?: string;
  SANDBOX_CONTROLS_ENABLED?: string;
}

export type PaymentsEnvironment = "production" | "preview" | "development";

/** A rail's provider: ready with its adapter config, or closed with the reason (setting names only). */
export type ProviderSlot<K extends string, C> =
  | { kind: K; key: string; status: "ready"; config: C }
  | { kind: K; key: string; status: "unavailable"; reason: string };

export type CardSlot = ProviderSlot<"nuvei", NuveiConfig> | ProviderSlot<"sandbox", SandboxConfig>;
export type CryptoSlot = ProviderSlot<"bvnk", BvnkConfig> | ProviderSlot<"sandbox", SandboxConfig>;
export type KycSlot = ProviderSlot<"sumsub", SumsubConfig> | ProviderSlot<"sandbox", SandboxConfig>;

export interface PaymentsLimits {
  depositMinMinor: bigint;
  depositMaxMinor: bigint;
  withdrawalMinMinor: bigint;
  withdrawalMaxMinor: bigint;
  autoApproveMaxMinor: bigint;
  autoApproveDailyMaxMinor: bigint;
  dualApprovalMinMinor: bigint;
  /** FIAU mode only: CDD required at this cumulative deposit total (KYC_BEFORE_DEPOSIT=false). */
  kycCddThresholdMinor: bigint;
  /** Source of funds required at this cumulative deposit total. */
  sofThresholdMinor: bigint;
}

interface CommonConfig {
  environment: PaymentsEnvironment;
  /** Problems with optional settings that were ignored (names only, never values). */
  problems: string[];
}

export interface PaymentsOffConfig extends CommonConfig {
  mode: "off";
  settlementAsset: null;
}

export interface PaymentsActiveConfig extends CommonConfig {
  mode: "sandbox" | "live";
  settlementAsset: SettlementAsset;
  publicSiteOrigin: string;
  paymentsPublicOrigin: string | null;
  /** ISO alpha-2 codes where real-money play is offered (empty in sandbox = any). */
  realMoneyCountries: string[];
  kycBeforeDeposit: boolean;
  limits: PaymentsLimits;
  newDestinationCooldownMs: number;
  depositSessionTtlMs: number;
  withdrawalQuoteTtlMs: number;
  allowWithdrawalCancel: boolean;
  /** Prepaid cards are never allowed. */
  cardFundingAllowed: ("debit" | "credit")[];
  /** Asset codes players may pay with and be paid in (USDT already removed unless allowed outside the EEA). */
  cryptoPayAssets: string[];
  allowUsdtOutsideEea: boolean;
  admin: { requireCfAccess: boolean; accessAud: string | null; accessTeamDomain: string | null };
  webhookIpAllowlist: Record<string, string[]>;
  egress: { mode: "direct" } | { mode: "relay"; relayUrl: string };
  notifyLinkSecret: string | null;
  providers: { card: CardSlot; crypto: CryptoSlot; kyc: KycSlot };
}

export type PaymentsConfig = PaymentsOffConfig | PaymentsActiveConfig;

/** A configuration that must not run (mode safety). Names settings, never values. */
export class PaymentsConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`payments configuration refused: ${problems.join("; ")}`);
    this.name = "PaymentsConfigError";
  }
}

/** EEA member states (EU 27 + Iceland, Liechtenstein, Norway), ISO alpha-2. */
export const EEA_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
]);
const USDT_ASSETS = /^USDT_/;

/** Whether a player residing in `country` may use `asset` (USDT never for EEA residents or an unknown country). */
export function usdtAllowedFor(config: PaymentsActiveConfig, asset: string, country: string | null): boolean {
  if (!USDT_ASSETS.test(asset)) return true;
  return config.allowUsdtOutsideEea && country !== null && !EEA_COUNTRIES.has(country);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const blank = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "");
const trimmed = (value: string | undefined): string | undefined => (blank(value) ? undefined : value!.trim());
const flag = (value: string | undefined, fallback: boolean): boolean | null => {
  const raw = trimmed(value)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
};

const minor = z.string().trim().regex(/^(0|[1-9][0-9]{0,17})$/).transform((value) => BigInt(value));

const DURATION = /^(\d{1,7})(ms|s|m|h|d)?$/;
const DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** "120s", "30m", "24h", "7d" or bare seconds, in milliseconds, within [minMs, maxMs]. */
function duration(minMs: number, maxMs: number) {
  return z.string().trim().transform((value, ctx) => {
    const match = DURATION.exec(value);
    const ms = match ? Number(match[1]) * DURATION_UNIT_MS[(match[2] ?? "s") as keyof typeof DURATION_UNIT_MS] : NaN;
    if (!Number.isSafeInteger(ms) || ms < minMs || ms > maxMs) {
      ctx.addIssue({ code: "custom", message: `a duration between ${minMs / 1000}s and ${maxMs / 1000}s` });
      return z.NEVER;
    }
    return ms;
  });
}

const COUNTRY = /^[A-Z]{2}$/;
const ASSET_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

function list(value: string | undefined): string[] {
  return (trimmed(value) ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function httpsOrigin(value: string | undefined, allowHttp: boolean): string | null {
  const raw = trimmed(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Defaults are the design's (docs/money/WALLET.md section 3.1). */
const settingsSchema = z.object({
  KYC_CDD_THRESHOLD_MINOR: minor.prefault("200000"),
  SOF_THRESHOLD_MINOR: minor.prefault("1000000"),
  DEPOSIT_MIN_MINOR: minor.prefault("1000"),
  DEPOSIT_MAX_MINOR: minor.prefault("500000"),
  WITHDRAWAL_MIN_MINOR: minor.prefault("2000"),
  WITHDRAWAL_MAX_MINOR: minor.prefault("1000000"),
  AUTO_APPROVE_MAX_MINOR: minor.prefault("50000"),
  AUTO_APPROVE_DAILY_MAX_MINOR: minor.prefault("100000"),
  DUAL_APPROVAL_MIN_MINOR: minor.prefault("500000"),
  // The database floors the destination cooling-off at 24 h whatever this says.
  NEW_DESTINATION_COOLDOWN: duration(60_000, 30 * 86_400_000).prefault("24h"),
  DEPOSIT_SESSION_TTL: duration(5 * 60_000, 24 * 3_600_000).prefault("30m"),
  // WithdrawalQuote_valid caps a quote at 10 minutes.
  WITHDRAWAL_QUOTE_TTL: duration(30_000, 10 * 60_000).prefault("120s"),
});

function parseSettings(vars: PaymentsVars): { ok: true; value: z.infer<typeof settingsSchema> } | { ok: false; names: string[] } {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(settingsSchema.shape) as (keyof typeof settingsSchema.shape)[]) input[key] = trimmed(vars[key]);
  const parsed = settingsSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, names: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "settings")))] };
}

/**
 * A provider secret: present, at least 32 characters, and in live mode not a
 * placeholder. The reason names the variable only.
 */
function secretProblem(name: string, value: string | undefined, live: boolean, required = true): string | null {
  const raw = trimmed(value);
  if (raw === undefined) return required ? `${name} is not set` : null;
  if (raw.length < 32) return `${name} must be at least 32 characters`;
  if (live && PLACEHOLDER_SECRET.test(raw)) return `${name} looks like a placeholder`;
  return null;
}

function unavailable<K extends string>(kind: K, key: string, reasons: string[]): ProviderSlot<K, never> {
  return { kind, key, status: "unavailable", reason: reasons.join("; ") };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

type ActiveMode = "sandbox" | "live";

function sandboxSlot(rail: "card" | "crypto" | "kyc", vars: PaymentsVars, environment: PaymentsEnvironment): ProviderSlot<"sandbox", SandboxConfig> {
  const key = providerLedgerKey(rail, "sandbox", "sandbox");
  const problems = [secretProblem("SANDBOX_WEBHOOK_SECRET", vars.SANDBOX_WEBHOOK_SECRET, false)].filter((p): p is string => p !== null);
  const controls = flag(vars.SANDBOX_CONTROLS_ENABLED, false);
  if (controls === null) problems.push("SANDBOX_CONTROLS_ENABLED must be true or false");
  if (controls && environment === "production") problems.push("SANDBOX_CONTROLS_ENABLED is refused in production");
  if (problems.length > 0) return unavailable("sandbox", key, problems);
  return { kind: "sandbox", key, status: "ready", config: { webhookSecret: trimmed(vars.SANDBOX_WEBHOOK_SECRET)!, controlsEnabled: controls === true } };
}

function nuveiSlot(vars: PaymentsVars, mode: ActiveMode, origins: { site: string; payments: string | null }): ProviderSlot<"nuvei", NuveiConfig> {
  const key = providerLedgerKey("card", "nuvei", mode);
  const live = mode === "live";
  const problems: string[] = [];
  const env = trimmed(vars.NUVEI_ENV) ?? (live ? "prod" : "int");
  if (env !== "int" && env !== "prod") problems.push("NUVEI_ENV must be int or prod");
  else if ((env === "prod") !== live) problems.push(`NUVEI_ENV=${env} does not match PAYMENTS_MODE=${mode} (sandbox uses int, live uses prod)`);
  const merchantId = trimmed(vars.NUVEI_MERCHANT_ID);
  const merchantSiteId = trimmed(vars.NUVEI_MERCHANT_SITE_ID);
  if (!merchantId || !/^[0-9]{1,32}$/.test(merchantId)) problems.push("NUVEI_MERCHANT_ID must be the numeric merchant id");
  if (!merchantSiteId || !/^[0-9]{1,32}$/.test(merchantSiteId)) problems.push("NUVEI_MERCHANT_SITE_ID must be the numeric merchant site id");
  const depositUi = trimmed(vars.NUVEI_DEPOSIT_UI) ?? "payment_page";
  if (depositUi !== "payment_page") problems.push("NUVEI_DEPOSIT_UI must be payment_page (hosted page, PCI SAQ-A)");
  const idempotency = flag(vars.NUVEI_IDEMPOTENCY_CONFIRMED, false);
  if (idempotency === null) problems.push("NUVEI_IDEMPOTENCY_CONFIRMED must be true or false");
  for (const problem of [
    secretProblem("NUVEI_SECRET_KEY", vars.NUVEI_SECRET_KEY, live),
    secretProblem("NUVEI_SECRET_KEY_PREVIOUS", vars.NUVEI_SECRET_KEY_PREVIOUS, live, false),
  ]) if (problem) problems.push(problem);
  if (!origins.payments) problems.push("PAYMENTS_PUBLIC_ORIGIN is not set (needed for the DMN notify URL)");
  if (problems.length > 0) return unavailable("nuvei", key, problems);
  return {
    kind: "nuvei",
    key,
    status: "ready",
    config: {
      env: env as "int" | "prod",
      merchantId: merchantId!,
      merchantSiteId: merchantSiteId!,
      secretKey: trimmed(vars.NUVEI_SECRET_KEY)!,
      secretKeyPrevious: trimmed(vars.NUVEI_SECRET_KEY_PREVIOUS) ?? null,
      depositUi: "payment_page",
      idempotencyConfirmed: idempotency === true,
      notifyUrl: `${origins.payments}/webhooks/${key}`,
      returnUrlBase: origins.site,
    },
  };
}

function bvnkSlot(vars: PaymentsVars, mode: ActiveMode, egress: PaymentsActiveConfig["egress"] | null): ProviderSlot<"bvnk", BvnkConfig> {
  const key = providerLedgerKey("crypto", "bvnk", mode);
  const live = mode === "live";
  const problems: string[] = [];
  const env = trimmed(vars.BVNK_ENV) ?? (live ? "production" : "sandbox");
  if (env !== "sandbox" && env !== "production") problems.push("BVNK_ENV must be sandbox or production");
  else if ((env === "production") !== live) problems.push(`BVNK_ENV=${env} does not match PAYMENTS_MODE=${mode}`);
  const walletIdEur = trimmed(vars.BVNK_WALLET_ID_EUR);
  // BVNK's documented wallet ids look like a:24092328494070:G5i4XZ9:1.
  if (!walletIdEur || !/^[A-Za-z0-9:-]{1,64}$/.test(walletIdEur)) problems.push("BVNK_WALLET_ID_EUR is not set");
  const scheme = trimmed(vars.BVNK_WEBHOOK_SCHEME) ?? "v2_base64";
  if (scheme !== "v2_base64") problems.push("BVNK_WEBHOOK_SCHEME must be v2_base64 (the legacy scheme is refused)");
  let assetMap: BvnkConfig["assetMap"] = {};
  try {
    const parsed = z.record(z.string().regex(ASSET_CODE), z.object({ payCurrency: z.string().min(1).max(32), network: z.string().min(1).max(64) }))
      .safeParse(JSON.parse(trimmed(vars.BVNK_ASSET_MAP) ?? "{}"));
    if (parsed.success && Object.keys(parsed.data).length > 0) assetMap = parsed.data;
    else problems.push("BVNK_ASSET_MAP must map at least one asset code to {payCurrency, network}");
  } catch {
    problems.push("BVNK_ASSET_MAP is not valid JSON");
  }
  const hawkAuthId = trimmed(vars.BVNK_HAWK_AUTH_ID);
  if (!hawkAuthId || hawkAuthId.length > 256) problems.push("BVNK_HAWK_AUTH_ID is not set");
  for (const problem of [
    secretProblem("BVNK_HAWK_AUTH_KEY", vars.BVNK_HAWK_AUTH_KEY, live),
    secretProblem("BVNK_WEBHOOK_SECRET", vars.BVNK_WEBHOOK_SECRET, live),
    secretProblem("BVNK_WEBHOOK_SECRET_PREVIOUS", vars.BVNK_WEBHOOK_SECRET_PREVIOUS, live, false),
  ]) if (problem) problems.push(problem);
  if (!egress) problems.push("PAYMENTS_EGRESS_MODE / PAYMENTS_EGRESS_RELAY_URL are invalid");
  if (problems.length > 0) return unavailable("bvnk", key, problems);
  return {
    kind: "bvnk",
    key,
    status: "ready",
    config: {
      env: env as "sandbox" | "production",
      walletIdEur: walletIdEur!,
      assetMap,
      webhookScheme: "v2_base64",
      hawkAuthId: hawkAuthId!,
      hawkAuthKey: trimmed(vars.BVNK_HAWK_AUTH_KEY)!,
      webhookSecret: trimmed(vars.BVNK_WEBHOOK_SECRET)!,
      webhookSecretPrevious: trimmed(vars.BVNK_WEBHOOK_SECRET_PREVIOUS) ?? null,
      egress: egress!,
    },
  };
}

function sumsubSlot(vars: PaymentsVars, mode: ActiveMode): ProviderSlot<"sumsub", SumsubConfig> {
  const key = providerLedgerKey("kyc", "sumsub", mode);
  const live = mode === "live";
  const problems: string[] = [];
  const baseUrl = httpsOrigin(vars.SUMSUB_BASE_URL ?? "https://api.sumsub.com", false);
  if (!baseUrl) problems.push("SUMSUB_BASE_URL must be an https origin");
  const levelName = trimmed(vars.SUMSUB_LEVEL_NAME);
  if (!levelName || !/^[A-Za-z0-9 _.-]{1,64}$/.test(levelName)) problems.push("SUMSUB_LEVEL_NAME is not set");
  const ttl = duration(60_000, 3_600_000).safeParse(trimmed(vars.SUMSUB_TOKEN_TTL) ?? "10m");
  if (!ttl.success) problems.push("SUMSUB_TOKEN_TTL must be between 1 minute and 1 hour");
  const screeningIncluded = flag(vars.SUMSUB_SCREENING_INCLUDED, false);
  if (screeningIncluded === null) problems.push("SUMSUB_SCREENING_INCLUDED must be true or false");
  // Live without screening would let verified players deposit and never withdraw
  // (nothing would set CLEAR): the rail stays closed instead.
  else if (live && screeningIncluded !== true) problems.push("SUMSUB_SCREENING_INCLUDED must be true in live mode (a verification level that includes AML screening)");
  const appToken = trimmed(vars.SUMSUB_APP_TOKEN);
  if (!appToken || appToken.length < 16) problems.push("SUMSUB_APP_TOKEN is not set");
  for (const problem of [
    secretProblem("SUMSUB_SECRET_KEY", vars.SUMSUB_SECRET_KEY, live),
    secretProblem("SUMSUB_WEBHOOK_SECRET", vars.SUMSUB_WEBHOOK_SECRET, live),
  ]) if (problem) problems.push(problem);
  if (problems.length > 0) return unavailable("sumsub", key, problems);
  return {
    kind: "sumsub",
    key,
    status: "ready",
    config: {
      mode,
      baseUrl: baseUrl!,
      appToken: appToken!,
      secretKey: trimmed(vars.SUMSUB_SECRET_KEY)!,
      webhookSecret: trimmed(vars.SUMSUB_WEBHOOK_SECRET)!,
      levelName: levelName!,
      tokenTtlSeconds: Math.floor((ttl.success ? ttl.data : 600_000) / 1000),
      screeningIncluded: screeningIncluded === true,
    },
  };
}

/** The secret each ready slot uses, for the "every secret distinct" rule. */
function slotSecrets(slot: CardSlot | CryptoSlot | KycSlot): [name: string, value: string][] {
  if (slot.status !== "ready") return [];
  switch (slot.kind) {
    case "sandbox": return [["SANDBOX_WEBHOOK_SECRET", slot.config.webhookSecret]];
    case "nuvei": return [["NUVEI_SECRET_KEY", slot.config.secretKey]];
    case "bvnk": return [["BVNK_HAWK_AUTH_KEY", slot.config.hawkAuthKey], ["BVNK_WEBHOOK_SECRET", slot.config.webhookSecret]];
    case "sumsub": return [["SUMSUB_SECRET_KEY", slot.config.secretKey], ["SUMSUB_WEBHOOK_SECRET", slot.config.webhookSecret]];
  }
}

// ---------------------------------------------------------------------------
// readPaymentsConfig
// ---------------------------------------------------------------------------

const PROVIDER_KEYS = {
  CARD_PROVIDER_KEY: ["sandbox", "nuvei"],
  CRYPTO_PROVIDER_KEY: ["sandbox", "bvnk"],
  KYC_PROVIDER_KEY: ["sandbox", "sumsub"],
} as const;

export function readPaymentsConfig(vars: PaymentsVars): PaymentsConfig {
  const problems: string[] = [];
  const refusals: string[] = [];
  const rawEnvironment = trimmed(vars.ENVIRONMENT) ?? "production";
  // An unknown environment is treated as production: the stricter rules apply.
  const environment: PaymentsEnvironment = rawEnvironment === "preview" || rawEnvironment === "development" ? rawEnvironment : "production";
  if (!["production", "preview", "development"].includes(rawEnvironment)) problems.push("ENVIRONMENT must be production, preview or development (treated as production)");

  const rawMode = trimmed(vars.PAYMENTS_MODE) ?? "off";
  if (rawMode !== "off" && rawMode !== "sandbox" && rawMode !== "live") {
    // An unknown mode never moves money.
    return { mode: "off", environment, settlementAsset: null, problems: [...problems, "PAYMENTS_MODE must be off, sandbox or live (treated as off)"] };
  }
  const mode: PaymentsMode = rawMode;
  if (mode === "off") return { mode, environment, settlementAsset: null, problems };
  const live = mode === "live";

  // Mode safety.
  if (mode === "sandbox" && environment === "production") refusals.push("PAYMENTS_MODE=sandbox is refused with ENVIRONMENT=production");
  if (live && environment !== "production") refusals.push("PAYMENTS_MODE=live needs ENVIRONMENT=production");
  const settlementAsset: SettlementAsset = live ? "EUR" : "TEST_EUR";
  const declared = trimmed(vars.SETTLEMENT_ASSET);
  if (declared !== undefined && declared !== settlementAsset) refusals.push(`SETTLEMENT_ASSET must be ${settlementAsset} with PAYMENTS_MODE=${mode} (or unset)`);

  const requireCfAccess = flag(vars.ADMIN_REQUIRE_CF_ACCESS, false);
  if (requireCfAccess === null) refusals.push("ADMIN_REQUIRE_CF_ACCESS must be true or false");
  const accessAud = trimmed(vars.CF_ACCESS_AUD) ?? null;
  const accessTeamDomain = trimmed(vars.CF_ACCESS_TEAM_DOMAIN) ?? null;
  if (accessTeamDomain !== null && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(accessTeamDomain)) refusals.push("CF_ACCESS_TEAM_DOMAIN must be the team subdomain only");
  if (live && (requireCfAccess !== true || !accessAud || !accessTeamDomain)) {
    refusals.push("PAYMENTS_MODE=live needs ADMIN_REQUIRE_CF_ACCESS=true, CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN");
  }

  const kinds = {} as { CARD_PROVIDER_KEY: CardProviderKind; CRYPTO_PROVIDER_KEY: CryptoProviderKind; KYC_PROVIDER_KEY: KycProviderKind };
  for (const [name, allowed] of Object.entries(PROVIDER_KEYS) as [keyof typeof PROVIDER_KEYS, readonly string[]][]) {
    const value = trimmed(vars[name]) ?? "sandbox";
    if (!allowed.includes(value)) {
      refusals.push(`${name} must be one of ${allowed.join(", ")}`);
      continue;
    }
    if (live && value === "sandbox") refusals.push(`${name}=sandbox is refused with PAYMENTS_MODE=live`);
    (kinds as Record<string, string>)[name] = value;
  }

  const realMoneyCountries = list(vars.REAL_MONEY_COUNTRIES);
  if (realMoneyCountries.some((code) => !COUNTRY.test(code))) refusals.push("REAL_MONEY_COUNTRIES must be comma-separated ISO alpha-2 codes");
  if (live && realMoneyCountries.length === 0) refusals.push("PAYMENTS_MODE=live needs REAL_MONEY_COUNTRIES");

  const publicSiteOrigin = httpsOrigin(vars.PUBLIC_SITE_ORIGIN, !live && environment === "development");
  if (!publicSiteOrigin) refusals.push(live ? "PUBLIC_SITE_ORIGIN must be an https origin" : "PUBLIC_SITE_ORIGIN must be an origin (https outside development)");
  const paymentsPublicOrigin = httpsOrigin(vars.PAYMENTS_PUBLIC_ORIGIN, !live && environment === "development");
  if (trimmed(vars.PAYMENTS_PUBLIC_ORIGIN) && !paymentsPublicOrigin) problems.push("PAYMENTS_PUBLIC_ORIGIN is not a usable origin (ignored)");

  const settings = parseSettings(vars);
  if (!settings.ok) refusals.push(`invalid ${settings.names.join(", ")}`);

  const kycBeforeDeposit = flag(vars.KYC_BEFORE_DEPOSIT, true);
  if (kycBeforeDeposit === null) problems.push("KYC_BEFORE_DEPOSIT must be true or false (treated as true)");
  const allowWithdrawalCancel = flag(vars.ALLOW_WITHDRAWAL_CANCEL, false);
  if (allowWithdrawalCancel === null) problems.push("ALLOW_WITHDRAWAL_CANCEL must be true or false (treated as false)");
  const allowUsdt = flag(vars.CRYPTO_ALLOW_USDT_NON_EEA, false);
  if (allowUsdt === null) problems.push("CRYPTO_ALLOW_USDT_NON_EEA must be true or false (treated as false)");

  const funding = list(vars.CARD_FUNDING_ALLOWED ?? "debit,credit");
  const cardFundingAllowed = funding.filter((value): value is "debit" | "credit" => value === "debit" || value === "credit");
  if (cardFundingAllowed.length !== funding.length) problems.push("CARD_FUNDING_ALLOWED takes only debit and credit (prepaid is never allowed); other values ignored");

  const payAssets = list(vars.CRYPTO_PAY_ASSETS ?? "USDC_ERC20,BTC,ETH");
  const validAssets = payAssets.filter((code) => ASSET_CODE.test(code));
  if (validAssets.length !== payAssets.length) problems.push("CRYPTO_PAY_ASSETS has invalid asset codes (ignored)");
  const cryptoPayAssets = allowUsdt === true ? validAssets : validAssets.filter((code) => !USDT_ASSETS.test(code));
  if (cryptoPayAssets.length !== validAssets.length) problems.push("CRYPTO_PAY_ASSETS: USDT removed (never for EEA residents; CRYPTO_ALLOW_USDT_NON_EEA is off)");

  let webhookIpAllowlist: Record<string, string[]> = {};
  try {
    const parsed = z.record(z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/), z.array(z.string().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/)).max(64))
      .safeParse(JSON.parse(trimmed(vars.WEBHOOK_IP_ALLOWLIST) ?? "{}"));
    if (parsed.success) webhookIpAllowlist = parsed.data;
    else refusals.push("WEBHOOK_IP_ALLOWLIST must be {\"<providerKey>\": [\"<cidr>\", ...]}");
  } catch {
    refusals.push("WEBHOOK_IP_ALLOWLIST is not valid JSON");
  }

  let egress: PaymentsActiveConfig["egress"] | null = null;
  const egressMode = trimmed(vars.PAYMENTS_EGRESS_MODE) ?? "direct";
  if (egressMode === "direct") egress = { mode: "direct" };
  else if (egressMode === "relay") {
    const relayUrl = httpsOrigin(vars.PAYMENTS_EGRESS_RELAY_URL, false);
    if (relayUrl) egress = { mode: "relay", relayUrl };
    else problems.push("PAYMENTS_EGRESS_RELAY_URL must be an https origin with PAYMENTS_EGRESS_MODE=relay (providers that need egress stay off)");
  } else problems.push("PAYMENTS_EGRESS_MODE must be direct or relay (providers that need egress stay off)");

  const notifyProblem = secretProblem("NOTIFY_LINK_SECRET", vars.NOTIFY_LINK_SECRET, live, false);
  if (notifyProblem) problems.push(`${notifyProblem} (ignored: payment emails carry no lockdown link)`);

  if (refusals.length > 0 || !settings.ok || !publicSiteOrigin) throw new PaymentsConfigError(refusals);

  const origins = { site: publicSiteOrigin, payments: paymentsPublicOrigin };
  const activeMode = mode;
  let card: CardSlot = kinds.CARD_PROVIDER_KEY === "nuvei" ? nuveiSlot(vars, activeMode, origins) : sandboxSlot("card", vars, environment);
  let crypto: CryptoSlot = kinds.CRYPTO_PROVIDER_KEY === "bvnk" ? bvnkSlot(vars, activeMode, egress) : sandboxSlot("crypto", vars, environment);
  let kyc: KycSlot = kinds.KYC_PROVIDER_KEY === "sumsub" ? sumsubSlot(vars, activeMode) : sandboxSlot("kyc", vars, environment);

  // Every secret distinct (a reused secret closes the later rails that use it).
  const seen = new Map<string, string>();
  if (!notifyProblem && trimmed(vars.NOTIFY_LINK_SECRET)) seen.set(trimmed(vars.NOTIFY_LINK_SECRET)!, "NOTIFY_LINK_SECRET");
  const dedupe = <S extends CardSlot | CryptoSlot | KycSlot>(slot: S): S => {
    for (const [name, value] of slotSecrets(slot)) {
      const other = seen.get(value);
      // The sandbox slots share SANDBOX_WEBHOOK_SECRET by design.
      if (other && other !== name) return unavailable(slot.kind, slot.key, [`${name} must differ from ${other}`]) as S;
    }
    for (const [name, value] of slotSecrets(slot)) seen.set(value, name);
    return slot;
  };
  card = dedupe(card);
  crypto = dedupe(crypto);
  kyc = dedupe(kyc);

  const limits = settings.value;
  return {
    mode: activeMode,
    environment,
    settlementAsset,
    publicSiteOrigin,
    paymentsPublicOrigin,
    realMoneyCountries,
    kycBeforeDeposit: kycBeforeDeposit !== false,
    limits: {
      depositMinMinor: limits.DEPOSIT_MIN_MINOR,
      depositMaxMinor: limits.DEPOSIT_MAX_MINOR,
      withdrawalMinMinor: limits.WITHDRAWAL_MIN_MINOR,
      withdrawalMaxMinor: limits.WITHDRAWAL_MAX_MINOR,
      autoApproveMaxMinor: limits.AUTO_APPROVE_MAX_MINOR,
      autoApproveDailyMaxMinor: limits.AUTO_APPROVE_DAILY_MAX_MINOR,
      dualApprovalMinMinor: limits.DUAL_APPROVAL_MIN_MINOR,
      kycCddThresholdMinor: limits.KYC_CDD_THRESHOLD_MINOR,
      sofThresholdMinor: limits.SOF_THRESHOLD_MINOR,
    },
    newDestinationCooldownMs: limits.NEW_DESTINATION_COOLDOWN,
    depositSessionTtlMs: limits.DEPOSIT_SESSION_TTL,
    withdrawalQuoteTtlMs: limits.WITHDRAWAL_QUOTE_TTL,
    allowWithdrawalCancel: allowWithdrawalCancel === true,
    cardFundingAllowed,
    cryptoPayAssets,
    allowUsdtOutsideEea: allowUsdt === true,
    admin: { requireCfAccess: requireCfAccess === true, accessAud, accessTeamDomain },
    webhookIpAllowlist,
    egress: egress ?? { mode: "direct" },
    notifyLinkSecret: notifyProblem ? null : trimmed(vars.NOTIFY_LINK_SECRET) ?? null,
    providers: { card, crypto, kyc },
    problems,
  };
}
