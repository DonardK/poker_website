/**
 * Pure parts of the payments core (docs/money/WALLET.md section 14.2): the
 * withdrawal review rules, crypto address checks, deposit-limit capacity,
 * and the sandbox provider's signatures, payout scenarios and links.
 */
import { describe, expect, it } from "vitest";
import { keccak256Hex, normalizeCryptoAddress, toChecksumAddress } from "../../src/payments/crypto-address";
import type { PaymentsActiveConfig } from "../../src/payments/config";
import { redirectAllowed, type MoneyProvider, type PaymentsContext } from "../../src/payments/context";
import { renderPaymentEmail } from "../../src/payments/emails";
import { WalletRefusal } from "../../src/payments/errors";
import { regionAllowed, requireFlowOpen } from "../../src/payments/gate";
import { remainingCapacity } from "../../src/payments/limits";
import {
  createSandboxCardAdapter,
  memorySandboxStore,
  payoutScenario,
  SANDBOX_SIGNATURE_HEADER,
  sandboxKycToken,
  sandboxLinkSig,
  sandboxLinkValid,
  signSandboxBody,
  createSandboxKycAdapter,
} from "../../src/payments/providers/sandbox";
import { evaluateWithdrawal, RULES_VERSION, type WithdrawalReason, type WithdrawalRuleInput } from "../../src/payments/rules";

const NOW = new Date("2026-10-29T12:00:00Z");
const OLD = new Date("2026-09-01T12:00:00Z");

/** Everything clean: auto-approve. Each case below breaks exactly one rule. */
function clean(): WithdrawalRuleInput {
  return {
    kind: "PLAYER", method: "CARD", amountMinor: 10_000n, liveMode: false, autoApproveEnabled: true,
    limits: { autoApproveMaxMinor: 50_000n, autoApproveDailyMaxMinor: 100_000n, dualApprovalMinMinor: 500_000n },
    settledWithdrawals: 3, autoApprovedLast24hMinor: 0n,
    compliance: { riskLevel: "LOW", screeningStatus: "CLEAR", sourceOfFundsStatus: "NOT_REQUIRED", restriction: "NONE", chargebackCount: 0 },
    destination: { successfulPayouts: 2, createdAt: OLD, sharedWithOtherUser: false, ownershipVerified: true, cumulativeMinor: 10_000n, isRecentDepositCard: true },
    closedLoopOutstandingMinor: 0n, buyInSinceLastDepositMinor: 50_000n, depositsSinceLastWithdrawalMinor: 20_000n,
    recentSecurityChange: false, notMeReported: false, now: NOW,
  };
}

const CASES: [WithdrawalReason, (input: WithdrawalRuleInput) => void][] = [
  ["AUTO_APPROVE_DISABLED", (i) => { i.autoApproveEnabled = false; }],
  ["FIRST_WITHDRAWAL", (i) => { i.settledWithdrawals = 0; }],
  ["AMOUNT_OVER_AUTO_LIMIT", (i) => { i.amountMinor = 50_001n; i.limits.autoApproveDailyMaxMinor = 10_000_000n; }],
  ["DAILY_AUTO_LIMIT", (i) => { i.autoApprovedLast24hMinor = 95_000n; }],
  ["RISK_NOT_LOW", (i) => { i.compliance.riskLevel = "MEDIUM"; }],
  ["SCREENING_NOT_CLEAR", (i) => { i.compliance.screeningStatus = "POTENTIAL_MATCH"; }],
  ["SOURCE_OF_FUNDS_PENDING", (i) => { i.compliance.sourceOfFundsStatus = "REQUESTED"; }],
  ["RESTRICTED_MANUAL", (i) => { i.compliance.restriction = "WITHDRAWALS_MANUAL"; }],
  ["CHARGEBACK_HISTORY", (i) => { i.compliance.chargebackCount = 1; }],
  ["NEW_DESTINATION", (i) => { i.destination.successfulPayouts = 0; }],
  ["DESTINATION_YOUNG", (i) => { i.destination.createdAt = new Date(NOW.getTime() - 86_400_000); }],
  ["DESTINATION_SHARED", (i) => { i.destination.sharedWithOtherUser = true; }],
  ["OWNERSHIP_PROOF_REQUIRED", (i) => { i.method = "CRYPTO"; i.destination.isRecentDepositCard = false; i.destination.ownershipVerified = false; i.destination.cumulativeMinor = 100_001n; }],
  ["CLOSED_LOOP", (i) => { i.closedLoopOutstandingMinor = 1n; i.destination.isRecentDepositCard = false; }],
  ["LOW_PLAY", (i) => { i.buyInSinceLastDepositMinor = 0n; }],
  ["RECENT_SECURITY_CHANGE", (i) => { i.recentSecurityChange = true; }],
  ["NOT_ME_REPORTED", (i) => { i.notMeReported = true; }],
  ["REFUND_TO_SOURCE", (i) => { i.kind = "REFUND"; i.method = "CRYPTO"; i.destination.isRecentDepositCard = false; }],
];

describe("evaluateWithdrawal", () => {
  it("auto-approves when no rule fires", () => {
    expect(evaluateWithdrawal(clean())).toEqual({ action: "AUTO_APPROVE", reasons: [], approvalsRequired: 1, rulesVersion: RULES_VERSION });
  });

  it.each(CASES)("%s alone sends it to manual review", (reason, mutate) => {
    const input = clean();
    mutate(input);
    const decision = evaluateWithdrawal(input);
    expect(decision.action).toBe("MANUAL_REVIEW");
    expect(decision.reasons).toEqual([reason]);
  });

  it("needs two approvals at the dual threshold, for high risk, a shared destination, or in live mode", () => {
    const base = () => { const i = clean(); i.settledWithdrawals = 0; return i; };
    expect(evaluateWithdrawal(base()).approvalsRequired).toBe(1);
    const big = base(); big.amountMinor = 500_000n; big.limits.autoApproveMaxMinor = 10_000_000n; big.limits.autoApproveDailyMaxMinor = 10_000_000n;
    expect(evaluateWithdrawal(big).approvalsRequired).toBe(2);
    const risky = base(); risky.compliance.riskLevel = "HIGH";
    expect(evaluateWithdrawal(risky).approvalsRequired).toBe(2);
    const shared = base(); shared.destination.sharedWithOtherUser = true;
    expect(evaluateWithdrawal(shared).approvalsRequired).toBe(2);
    const live = base(); live.liveMode = true;
    expect(evaluateWithdrawal(live).approvalsRequired).toBe(2);
  });

  it("LOW_PLAY is always present without buy-ins (Phase 1: every real withdrawal is manual)", () => {
    const input = clean();
    input.buyInSinceLastDepositMinor = 0n;
    input.depositsSinceLastWithdrawalMinor = 0n;
    expect(evaluateWithdrawal(input).reasons).toContain("LOW_PLAY");
  });
});

describe("crypto addresses", () => {
  it("keccak-256 matches the known empty-input vector (not SHA3-256)", () => {
    expect(keccak256Hex(new Uint8Array())).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("EVM: EIP-55 checksums accepted, a bad mixed case refused, lower case normalised", () => {
    for (const address of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"]) {
      const check = normalizeCryptoAddress("ethereum", address, null);
      expect(check).toEqual({ ok: true, normalized: address.toLowerCase(), display: address });
      expect(toChecksumAddress(address.slice(2).toLowerCase())).toBe(address);
    }
    expect(normalizeCryptoAddress("ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", null).ok).toBe(false);
    expect(normalizeCryptoAddress("ethereum", "0x52908400098527886e0f7030069857d2e4169ee7", null)).toMatchObject({ ok: true, normalized: "0x52908400098527886e0f7030069857d2e4169ee7" });
    expect(normalizeCryptoAddress("ethereum", "0x1234", null).ok).toBe(false);
  });

  it("BTC: P2PKH, P2SH, bech32 and bech32m accepted; a broken checksum refused", () => {
    for (const address of [
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297",
    ]) expect(normalizeCryptoAddress("bitcoin", address, null).ok).toBe(true);
    expect(normalizeCryptoAddress("bitcoin", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", null).ok).toBe(false);
    expect(normalizeCryptoAddress("bitcoin", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx", null).ok).toBe(false);
  });

  it("TRON: base58check with the 0x41 prefix; a Bitcoin address is not a TRON address", () => {
    expect(normalizeCryptoAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", null).ok).toBe(true);
    expect(normalizeCryptoAddress("tron", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", null).ok).toBe(false);
  });
});

describe("remainingCapacity", () => {
  it("is the tightest period, floored at zero; null without limits", () => {
    expect(remainingCapacity({ DAY: null, WEEK: null, MONTH: null }, { DAY: 0n, WEEK: 0n, MONTH: 0n })).toBeNull();
    expect(remainingCapacity({ DAY: 10_000n, WEEK: 50_000n, MONTH: null }, { DAY: 2_500n, WEEK: 45_000n, MONTH: 99_000n })).toBe(5_000n);
    expect(remainingCapacity({ DAY: 10_000n, WEEK: null, MONTH: null }, { DAY: 12_000n, WEEK: 0n, MONTH: 0n })).toBe(0n);
  });
});

describe("sandbox provider", () => {
  const secret = "test-only-sandbox-webhook-secret-32ch";
  const opts = (now = new Date()) => ({ store: memorySandboxStore(), webhookSecret: secret, publicOrigin: "https://payments.example", now: () => now });

  async function verify(body: string, header: string, receivedAt = new Date()) {
    const adapter = createSandboxCardAdapter(opts(receivedAt));
    return adapter.verifyWebhook({ method: "POST", url: new URL("https://payments.example/webhooks/sandbox-card"), headers: new Headers({ [SANDBOX_SIGNATURE_HEADER]: header }), rawBody: new TextEncoder().encode(body), receivedAt, sourceIp: null });
  }

  it("refuses a wrong secret, a tampered body and a stale timestamp before reading anything", async () => {
    const body = JSON.stringify({ eventId: "evt_1", type: "payment.succeeded", createdAt: new Date().toISOString(), data: { objectType: "PAYMENT", id: "sbx_pay_x" } });
    expect(await verify(body, await signSandboxBody("another-secret-another-secret-12345", body, new Date()))).toEqual({ ok: false, reason: "signature" });
    expect(await verify(`${body} `, await signSandboxBody(secret, body, new Date()))).toEqual({ ok: false, reason: "signature" });
    expect(await verify(body, await signSandboxBody(secret, body, new Date(Date.now() - 301_000)))).toEqual({ ok: false, reason: "timestamp" });
    // Valid signature, unknown object: still not an event.
    expect(await verify(body, await signSandboxBody(secret, body, new Date()))).toEqual({ ok: false, reason: "format" });
  });

  it("picks payout scenarios by the cents and deduplicates on our key", async () => {
    expect(payoutScenario(4001n)).toBe("DECLINE");
    expect(payoutScenario(2002n)).toBe("TIMEOUT_EXECUTED");
    expect(payoutScenario(2003n)).toBe("TIMEOUT_LOST");
    expect(payoutScenario(4000n)).toBe("PAID");
    const o = opts();
    const card = createSandboxCardAdapter(o);
    const input = {
      withdrawalId: "w1", idempotencyKey: "wd_w1", operation: "PAYOUT" as const, amountMinor: 2003n, feeMinor: 0n,
      destination: { kind: "CARD_TOKEN" as const, token: "sbx_upo_1", holderName: "Test Player" },
      customer: { userId: "u1", providerCustomerRef: "c1", email: null, country: "MT", legalName: null, ip: null },
      beneficiary: { type: "BENEFICIARY" as const, firstName: "Test", lastName: "Player", dateOfBirth: "1990-01-01", countryCode: "MT", relationship: "SELF_OWNED" as const },
    };
    expect(await card.createPayout(input)).toEqual({ kind: "uncertain", reason: "timeout" });
    expect(await card.getPayout({ idempotencyKey: "wd_w1" })).toEqual({ kind: "ok", value: null });
    const again = await card.createPayout(input);
    expect(again.kind === "ok" && again.value.state).toBe("SUCCEEDED");
    const third = await card.createPayout(input);
    expect(third.kind === "ok" && third.value.providerPayoutId).toBe(again.kind === "ok" ? again.value.providerPayoutId : "");
    expect(await o.store.get<number>("count:dedupe:wd_w1")).toBe(1);
  });

  it("signed page links and verification tokens", async () => {
    const sig = await sandboxLinkSig(secret, "pay:sbx_pay_1");
    expect(await sandboxLinkValid(secret, "pay:sbx_pay_1", sig)).toBe(true);
    expect(await sandboxLinkValid(secret, "pay:sbx_pay_2", sig)).toBe(false);
    const kyc = createSandboxKycAdapter(opts());
    const session = await kyc.createSession({ userId: "u1", externalUserId: "u1", email: null, country: "MT", level: "sandbox-basic", ttlSeconds: 600 });
    expect(session.kind).toBe("ok");
    if (session.kind !== "ok") return;
    expect(await sandboxKycToken(secret, session.value.sdkToken, new Date())).toBe(session.value.applicantRef);
    expect(await sandboxKycToken(secret, session.value.sdkToken, new Date(Date.now() + 601_000))).toBeNull();
    expect(await sandboxKycToken("x".repeat(36), session.value.sdkToken, new Date())).toBeNull();
  });
});

describe("the gate (section 12.1)", () => {
  /** A context whose database answers the asset and the switches; the rails are present unless `noCard`. */
  function gateCtx(opts: { assetEnabled: boolean; switches: Record<string, boolean>; noCard?: boolean }): PaymentsContext {
    return {
      config: { settlementAsset: "TEST_EUR" },
      providers: { card: opts.noCard ? null : {}, crypto: {}, kyc: null },
      db: {
        asset: { findUnique: async () => ({ enabled: opts.assetEnabled }) },
        paymentSwitch: { findMany: async () => Object.entries(opts.switches).map(([key, enabled]) => ({ key, enabled })) },
      },
    } as unknown as PaymentsContext;
  }

  async function code(work: Promise<unknown>): Promise<string | null> {
    try {
      await work;
      return null;
    } catch (error) {
      if (error instanceof WalletRefusal) return error.code;
      throw error;
    }
  }

  it("the asset first (the emergency stop), then the flow's switch, then the rail; all three on opens the flow", async () => {
    expect(await code(requireFlowOpen(gateCtx({ assetEnabled: false, switches: { DEPOSIT_CARD: true } }), "DEPOSIT_CARD", "CARD"))).toBe("PAYMENTS_PAUSED");
    expect(await code(requireFlowOpen(gateCtx({ assetEnabled: true, switches: { DEPOSIT_CARD: false } }), "DEPOSIT_CARD", "CARD"))).toBe("METHOD_DISABLED");
    // A switch row that is missing is off.
    expect(await code(requireFlowOpen(gateCtx({ assetEnabled: true, switches: {} }), "DEPOSIT_CARD", "CARD"))).toBe("METHOD_DISABLED");
    expect(await code(requireFlowOpen(gateCtx({ assetEnabled: true, switches: { DEPOSIT_CARD: true }, noCard: true }), "DEPOSIT_CARD", "CARD"))).toBe("METHOD_DISABLED");
    expect(await code(requireFlowOpen(gateCtx({ assetEnabled: true, switches: { DEPOSIT_CARD: true } }), "DEPOSIT_CARD", "CARD"))).toBeNull();
  });

  it("region: live only in REAL_MONEY_COUNTRIES, never Tor or an unknown country; sandbox with an empty list anywhere", () => {
    const live = { mode: "live", realMoneyCountries: ["MT"] } as unknown as PaymentsActiveConfig;
    expect(regionAllowed(live, "MT")).toBe(true);
    for (const country of ["DE", "T1", "XX", null]) expect(regionAllowed(live, country)).toBe(false);
    const sandbox = { mode: "sandbox", realMoneyCountries: [] } as unknown as PaymentsActiveConfig;
    expect(regionAllowed(sandbox, null)).toBe(true);
    expect(regionAllowed({ mode: "live", realMoneyCountries: [] } as unknown as PaymentsActiveConfig, "MT")).toBe(false);
  });
});

describe("provider redirect hosts", () => {
  const provider = (redirectHosts: string[], sandbox = false) => ({ redirectHosts, sandbox }) as unknown as MoneyProvider;

  it("allows only https on a declared host, exact or as a subdomain of a \".suffix\"", () => {
    const exact = provider(["secure.safecharge.com"]);
    expect(redirectAllowed(exact, "https://secure.safecharge.com/ppp/purchase.do?a=1")).toBe(true);
    for (const url of [
      "https://secure.safecharge.com.evil.example/", "https://evil.example/secure.safecharge.com", "http://secure.safecharge.com/",
      "https://user:pw@secure.safecharge.com/", "javascript:alert(1)", "data:text/html,x", "/relative", "not a url",
    ]) expect(redirectAllowed(exact, url), url).toBe(false);
    const suffix = provider([".bvnk.com"]);
    expect(redirectAllowed(suffix, "https://pay.bvnk.com/x")).toBe(true);
    expect(redirectAllowed(suffix, "https://bvnk.com.evil.example/x")).toBe(false);
    expect(redirectAllowed(suffix, "https://evilbvnk.com/x")).toBe(false);
  });

  it("plain http only for a sandbox on loopback", () => {
    expect(redirectAllowed(provider(["127.0.0.1"], true), "http://127.0.0.1:8787/sandbox/pay/x")).toBe(true);
    expect(redirectAllowed(provider(["127.0.0.1"]), "http://127.0.0.1:8787/sandbox/pay/x")).toBe(false);
    expect(redirectAllowed(provider(["payments.example"], true), "http://payments.example/x")).toBe(false);
  });

  it("every provider declares its hosts: the sandbox's are its public origin", () => {
    const store = memorySandboxStore();
    const card = createSandboxCardAdapter({ store, webhookSecret: "x".repeat(32), publicOrigin: "https://poker-payments-preview.example.workers.dev", now: () => NOW });
    expect(card.redirectHosts).toEqual(["poker-payments-preview.example.workers.dev"]);
    expect(createSandboxCardAdapter({ store, webhookSecret: "x".repeat(32), publicOrigin: null, now: () => NOW }).redirectHosts).toEqual([]);
  });
});

describe("payment emails", () => {
  const site = { username: "ada", siteOrigin: "https://poker.example.com" };

  it("a withdrawal request carries the \"This wasn't me\" link, in the fragment", () => {
    const mail = renderPaymentEmail("withdrawal-requested", { amount: "50.00", asset: "EUR", destination: "Visa •••• 4242", notMe: "w1.abc.def" }, site)!;
    expect(mail.text).toContain("https://poker.example.com/auth/not-me#w=w1.abc.def");
    expect(mail.html).toContain("This wasn&#39;t me");
  });

  it("without the signing secret the email still says what to do", () => {
    const mail = renderPaymentEmail("withdrawal-requested", { amount: "50.00", asset: "EUR", destination: "Visa •••• 4242" }, site)!;
    expect(mail.text).toContain("change your password now");
    expect(mail.text).not.toContain("not-me");
  });

  it("a new card is announced as a card, with the link", () => {
    const mail = renderPaymentEmail("destination-added", { address: "Visa •••• 4242", asset: "EUR", usableAfter: "2026-11-02T12:00:00.000Z", card: "true", notMe: "w1.abc.def", sandbox: "false" }, site)!;
    expect(mail.subject).toContain("A card was saved for payouts");
    expect(mail.text).toContain("the card Visa •••• 4242");
    expect(mail.text).toContain("#w=w1.abc.def");
    const address = renderPaymentEmail("destination-added", { address: "bc1qxyz", asset: "BTC", usableAfter: "x", sandbox: "false" }, site)!;
    expect(address.subject).toContain("A payout address was added");
    expect(address.text).not.toContain("not-me");
  });
});
