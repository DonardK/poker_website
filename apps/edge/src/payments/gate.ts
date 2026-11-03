/**
 * The gate in front of every money movement (docs/money/WALLET.md section
 * 12.1): (1) PAYMENTS_MODE is sandbox or live and the configuration is
 * valid; (2) the settlement asset is enabled (the emergency stop is
 * UPDATE "Asset" SET enabled = false); (3) the PaymentSwitch of the flow is
 * on; (4) the player gates of each flow. Also the wallet summary of
 * section 12.2 (what the UI may offer).
 */
import {
  PAYMENT_SWITCH_KEYS,
  WALLET_DECIMALS,
  type CryptoAssetOption,
  type PaymentMethod,
  type PaymentSwitchKey,
  type RealMoneyReason,
  type RealMoneySummary,
} from "@poker/shared";
import type { PrismaClient } from "../generated/prisma/client";
import { formatMinor } from "../money/amounts";
import type { MoneyTx } from "../money/tx";
import { readCompliance, screeningMatched, type ComplianceRow } from "./compliance";
import { usdtAllowedFor, type PaymentsActiveConfig } from "./config";
import type { PaymentsContext } from "./context";
import { refuse } from "./errors";
import { activeDepositLimits, activeSelfExclusion } from "./limits";
import { securityHeld, type CallerUser } from "./session";

type Db = PrismaClient | MoneyTx;

export type Switches = Record<PaymentSwitchKey, boolean>;

export async function readSwitches(db: Db): Promise<Switches> {
  const rows = await db.paymentSwitch.findMany({ select: { key: true, enabled: true } });
  const out = Object.fromEntries(PAYMENT_SWITCH_KEYS.map((key) => [key, false])) as Switches;
  for (const row of rows) if ((PAYMENT_SWITCH_KEYS as readonly string[]).includes(row.key)) out[row.key as PaymentSwitchKey] = row.enabled;
  return out;
}

export async function assetEnabled(db: Db, code: string): Promise<boolean> {
  const asset = await db.asset.findUnique({ where: { code }, select: { enabled: true } });
  return asset?.enabled === true;
}

export const DEPOSIT_SWITCH: Readonly<Record<PaymentMethod, PaymentSwitchKey>> = { CARD: "DEPOSIT_CARD", CRYPTO: "DEPOSIT_CRYPTO" };
export const WITHDRAW_SWITCH: Readonly<Record<PaymentMethod, PaymentSwitchKey>> = { CARD: "WITHDRAW_CARD", CRYPTO: "WITHDRAW_CRYPTO" };

/** Country of the request: real money only where REAL_MONEY_COUNTRIES allows (sandbox with an empty list: anywhere); Tor (T1) or unknown never. */
export function regionAllowed(config: PaymentsActiveConfig, country: string | null): boolean {
  if (config.realMoneyCountries.length === 0) return config.mode === "sandbox";
  if (!country || country === "T1" || country === "XX") return false;
  return config.realMoneyCountries.includes(country);
}

export function railReady(ctx: PaymentsContext, method: PaymentMethod): boolean {
  return method === "CARD" ? ctx.providers.card !== null : ctx.providers.crypto !== null;
}

/** Steps 2 and 3 for a method (before any transaction): PAYMENTS_PAUSED, METHOD_DISABLED. */
export async function requireFlowOpen(ctx: PaymentsContext, key: PaymentSwitchKey, method: PaymentMethod | null): Promise<void> {
  if (!await assetEnabled(ctx.db, ctx.config.settlementAsset)) refuse("PAYMENTS_PAUSED", "Payments are paused. Please try again later.", { retryable: true });
  const switches = await readSwitches(ctx.db);
  if (!switches[key] || (method !== null && !railReady(ctx, method))) refuse("METHOD_DISABLED", "This payment method is not available right now.");
}

/** KYC needed before this deposit (strict mode, or the FIAU cumulative threshold), and not VERIFIED yet. */
export function kycBlocksDeposit(config: PaymentsActiveConfig, row: ComplianceRow, amountMinor: bigint): boolean {
  if (row.kycStatus === "VERIFIED") return false;
  if (config.kycBeforeDeposit) return true;
  return row.lifetimeDepositedMinor + amountMinor >= config.limits.kycCddThresholdMinor;
}

export function sourceOfFundsBlocks(config: PaymentsActiveConfig, row: ComplianceRow, amountMinor: bigint): boolean {
  return row.lifetimeDepositedMinor + amountMinor >= config.limits.sofThresholdMinor && row.sourceOfFundsStatus !== "APPROVED";
}

const ASSET_LABELS: Readonly<Record<string, string>> = {
  BTC: "Bitcoin", ETH: "Ether", USDC_ERC20: "USDC (Ethereum)", USDT_ERC20: "USDT (Ethereum)", USDT_TRC20: "USDT (Tron)",
};

/** CRYPTO_PAY_ASSETS this player may use, with their networks (Asset rows), USDT never for EEA residents. */
export async function cryptoOptions(ctx: PaymentsContext, country: string | null): Promise<CryptoAssetOption[]> {
  const codes = ctx.config.cryptoPayAssets.filter((code) => usdtAllowedFor(ctx.config, code, country));
  if (codes.length === 0) return [];
  const assets = await ctx.db.asset.findMany({ where: { code: { in: codes }, kind: "CRYPTO" }, select: { code: true, network: true } });
  const network = new Map(assets.map((asset) => [asset.code, asset.network ?? ""]));
  return codes.filter((code) => network.has(code)).map((code) => ({ code, network: network.get(code)!, label: ASSET_LABELS[code] ?? code }));
}

interface BalanceRow { type: string; balance: string }

/** USER_AVAILABLE and USER_WITHDRAWAL_HOLD of the settlement asset. */
export async function balances(db: Db, userId: string, asset: string): Promise<{ available: bigint; held: bigint }> {
  const rows = await db.$queryRaw<BalanceRow[]>`
    SELECT "type"::text AS type, "balance"::text AS balance FROM public."LedgerAccount"
     WHERE "userId" = ${userId} AND "assetCode" = ${asset} AND "type" IN ('USER_AVAILABLE', 'USER_WITHDRAWAL_HOLD')`;
  let available = 0n;
  let held = 0n;
  for (const row of rows) {
    if (row.type === "USER_AVAILABLE") available = BigInt(row.balance);
    else held = BigInt(row.balance);
  }
  return { available, held };
}

/** Section 12.2. `country` is the request's (Cloudflare) country. */
export async function realMoneySummary(ctx: PaymentsContext, user: CallerUser, country: string | null): Promise<RealMoneySummary> {
  const { config, db } = ctx;
  const now = ctx.now();
  const asset = config.settlementAsset;
  const [enabled, switches, row, money, limits, exclusion] = await Promise.all([
    assetEnabled(db, asset), readSwitches(db), readCompliance(db, user.id), balances(db, user.id, asset),
    activeDepositLimits(db, user.id, now), activeSelfExclusion(db, user.id, now),
  ]);
  const reasons: RealMoneyReason[] = [];
  if (!enabled) reasons.push("PAUSED");
  const regionOk = regionAllowed(config, country) && (row.residenceCountry === null || regionAllowed(config, row.residenceCountry));
  if (!regionOk) reasons.push("REGION");
  if (row.kycStatus === "PENDING") reasons.push("KYC_PENDING");
  else if (kycBlocksDeposit(config, row, 0n)) reasons.push("KYC_REQUIRED");
  if (row.rgLimitsPromptedAt === null) reasons.push("LIMITS_SETUP_REQUIRED");
  if (exclusion) reasons.push("SELF_EXCLUDED");
  if (row.restriction !== "NONE" || screeningMatched(row)) reasons.push("ACCOUNT_RESTRICTED");
  if (sourceOfFundsBlocks(config, row, 0n)) reasons.push("SOURCE_OF_FUNDS_REQUIRED");

  const depositMethods = (["CARD", "CRYPTO"] as const).filter((method) => switches[DEPOSIT_SWITCH[method]] && railReady(ctx, method));
  const withdrawMethods = (["CARD", "CRYPTO"] as const).filter((method) => switches[WITHDRAW_SWITCH[method]] && railReady(ctx, method));
  const depositBlocked = !enabled || !regionOk || kycBlocksDeposit(config, row, 0n) || row.rgLimitsPromptedAt === null || exclusion !== null
    || row.restriction === "DEPOSITS_BLOCKED" || row.restriction === "FROZEN" || screeningMatched(row) || sourceOfFundsBlocks(config, row, 0n);
  // Withdrawals stay open in any region and during a self-exclusion (MGA): the balance is the player's.
  const withdrawBlocked = !enabled || row.kycStatus !== "VERIFIED" || row.screeningStatus !== "CLEAR" || row.restriction === "FROZEN" || securityHeld(user, now);
  const state: RealMoneySummary["state"] = reasons.length === 0 ? "ACTIVE" : (!enabled || !regionOk ? "UNAVAILABLE" : "RESTRICTED");
  return {
    state,
    reasons,
    asset,
    decimals: WALLET_DECIMALS,
    available: formatMinor(money.available, WALLET_DECIMALS),
    pendingWithdrawals: formatMinor(money.held, WALLET_DECIMALS),
    canDeposit: !depositBlocked && depositMethods.length > 0,
    canWithdraw: !withdrawBlocked && withdrawMethods.length > 0,
    methods: { deposit: depositMethods, withdraw: withdrawMethods },
    cryptoAssets: await cryptoOptions(ctx, row.residenceCountry ?? country),
    kyc: { status: row.kycStatus, requiredForDeposit: config.kycBeforeDeposit },
    limits: {
      DAY: limits.DAY === null ? null : formatMinor(limits.DAY, WALLET_DECIMALS),
      WEEK: limits.WEEK === null ? null : formatMinor(limits.WEEK, WALLET_DECIMALS),
      MONTH: limits.MONTH === null ? null : formatMinor(limits.MONTH, WALLET_DECIMALS),
    },
  };
}
