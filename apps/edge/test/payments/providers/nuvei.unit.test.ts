/**
 * Nuvei adapter (src/payments/providers/nuvei): the signed Payment Page
 * redirect, REST checksums and timestamps, the authoritative
 * getTransactionDetails re-read, payouts and refunds with their status
 * reads, payment DMNs (advanceResponseChecksum) and Control Panel
 * chargeback events. Checksums are recomputed here from the documented
 * formulas (docs.nuvei.com API reference, Payment Page quick start, payment
 * DMN page) with a random secret; nothing touches the network.
 */
import { describe, expect, it } from "vitest";
import { createNuveiAdapter } from "../../../src/payments/providers/nuvei";
import type { CustomerRef, NuveiConfig, PayoutInput } from "../../../src/payments/providers/types";
import { bytes, fakeDeps, json, logText, NOW, queue, randomSecret, sha256Hex } from "./fakes";

const MERCHANT = "1234567890";
const SITE = "123456";
const DEPOSIT = "5f0c2a8e-8b8f-4c3e-9d0a-2b7c1e4f6a90";
const SALE = "7110000000001908486";
const REST_TS = "20261029123456"; // NOW in UTC, YYYYMMDDHHmmss

function config(overrides: Partial<NuveiConfig> = {}): NuveiConfig {
  return {
    env: "int",
    merchantId: MERCHANT,
    merchantSiteId: SITE,
    secretKey: randomSecret(),
    secretKeyPrevious: null,
    depositUi: "payment_page",
    idempotencyConfirmed: false,
    notifyUrl: "https://poker-payments-preview.example.workers.dev/webhooks/sandbox-nuvei",
    returnUrlBase: "https://poker-web-preview.example.workers.dev",
    ...overrides,
  };
}

const customer: CustomerRef = { userId: "u1", providerCustomerRef: "pc_7f3a9c", email: "jane@example.com", country: "MT", legalName: { first: "Jane", last: "Doe" }, ip: "203.0.113.7" };

function payout(overrides: Partial<PayoutInput> = {}): PayoutInput {
  return {
    withdrawalId: "0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f",
    idempotencyKey: "wd_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f",
    operation: "PAYOUT",
    amountMinor: 12000n,
    feeMinor: 0n,
    destination: { kind: "CARD_TOKEN", token: "2154941", holderName: "Jane Doe" },
    customer,
    beneficiary: { type: "BENEFICIARY", firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-04-02", countryCode: "MT", relationship: "SELF_OWNED" },
    ...overrides,
  };
}

/** A getTransactionDetails answer shaped like the API reference example. */
function details(overrides: { transactionDetails?: Record<string, unknown>; partialApproval?: Record<string, unknown> | null; top?: Record<string, unknown> } = {}) {
  return {
    transactionDetails: {
      transactionStatus: "APPROVED", transactionType: "Sale", clientUniqueId: DEPOSIT, transactionId: SALE, relatedTransactionId: "",
      isVoided: "false", credited: "false", gwErrorCode: 0, gwErrorReason: "", date: "2026-10-29 12:30:00",
      ...overrides.transactionDetails,
    },
    userDetails: { userTokenId: "pc_7f3a9c" },
    paymentOption: {
      userPaymentOptionId: "2154941",
      card: { bin: "401200", ccCardNumber: "4****1390", cardHolderName: "John Smith", ccExpMonth: "12", ccExpYear: "28", issuerCountry: "GB", isPrepaid: "false", cardType: "Debit", cardBrand: "VISA" },
    },
    ...(overrides.partialApproval === null ? {} : { partialApproval: { requestedAmount: "100.0000", requestedCurrency: "EUR", processedAmount: "100.0000", processedCurrency: "EUR", ...overrides.partialApproval } }),
    merchantId: MERCHANT, merchantSiteId: SITE, status: "SUCCESS", errCode: 0, reason: "", version: "1.0",
    ...overrides.top,
  };
}

const REDIRECT_RETURN = "https://poker-web-preview.example.workers.dev/wallet?deposit=x";

/** A player's own Payment Page: a real checksum over values anyone can read in their redirect URL. */
async function pageValues() {
  const cfg = config();
  const adapter = createNuveiAdapter(cfg, fakeDeps(queue()).deps);
  const session = await adapter.createDepositSession({
    depositId: DEPOSIT, idempotencyKey: `dep_${DEPOSIT}`, amountMinor: 5000n, customer, expiresAt: new Date(NOW.getTime() + 900_000), saveCard: true,
    returnUrl: REDIRECT_RETURN, notificationUrl: cfg.notifyUrl,
  });
  if (session.kind !== "ok" || session.value.type !== "REDIRECT") throw new Error("no session");
  const pairs = [...new URL(session.value.url).searchParams.entries()];
  const checksum = pairs.find(([k]) => k === "checksum")![1];
  const values = pairs.filter(([k]) => k !== "checksum").map(([, v]) => v).join("");
  expect(await sha256Hex(cfg.secretKey + values)).toBe(checksum);
  return { cfg, adapter, checksum, values };
}

function dmnRequest(fields: Record<string, string>) {
  return {
    method: "POST", url: new URL("https://poker-payments-preview.example.workers.dev/webhooks/sandbox-nuvei"),
    headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    rawBody: bytes(new URLSearchParams(fields).toString()), receivedAt: NOW, sourceIp: "203.0.113.9",
  };
}

describe("a player's own Payment Page checksum", () => {
  it("never verifies as a payment DMN, however the values are split", async () => {
    const { adapter, checksum, values } = await pageValues();
    let accepted = 0;
    for (const cut of [10, 11, 12, 13, 14, 15, 16, 17]) {
      const result = await adapter.verifyWebhook(dmnRequest({
        totalAmount: values.slice(0, cut), currency: values.slice(cut, cut + 3), responseTimeStamp: values.slice(cut + 3, cut + 20), PPP_TransactionID: values.slice(cut + 20, cut + 40),
        Status: values.slice(cut + 40), advanceResponseChecksum: checksum, TransactionID: "7110000000001908486", merchant_unique_id: DEPOSIT,
      }));
      if (result.ok) accepted += 1;
    }
    expect(accepted).toBe(0);
  });

  it("never verifies with a split built to look like the fields", async () => {
    const { adapter, checksum, values } = await pageValues();
    const at = values.search(/[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{2}:[0-9]{2}:[0-9]{2}/);
    expect(at).toBeGreaterThan(3);
    const stamp = values.slice(at, at + 19);
    const result = await adapter.verifyWebhook(dmnRequest({
      totalAmount: values.slice(0, at - 3), currency: values.slice(at - 3, at), responseTimeStamp: stamp, PPP_TransactionID: "1", Status: "APPROVED",
      productId: values.slice(at + 19), advanceResponseChecksum: checksum, merchant_unique_id: DEPOSIT,
    }));
    expect(result.ok).toBe(false);
  });

  it("never verifies as a Control Panel chargeback", async () => {
    const { adapter, checksum, values } = await pageValues();
    const body = JSON.stringify({ a: values, EventType: "chargeback", Chargeback: { Amount: "50.00", Currency: "EUR" }, TransactionDetails: { TransactionId: "7110000000001908486" } });
    const result = await adapter.verifyWebhook({ ...dmnRequest({}), headers: new Headers({ "content-type": "application/json", checksum }), rawBody: bytes(body) });
    expect(result.ok).toBe(false);
  });
});

describe("Nuvei adapter identity", () => {
  it("books the int environment under sandbox-nuvei in TEST_EUR and prod under nuvei in EUR", () => {
    const sandbox = createNuveiAdapter(config(), fakeDeps(queue()).deps);
    expect([sandbox.key, sandbox.sandbox, sandbox.settlementAsset, sandbox.method, sandbox.authoritativeWebhooks, sandbox.dedupesOnOurKey]).toEqual(["sandbox-nuvei", true, "TEST_EUR", "CARD", false, false]);
    const live = createNuveiAdapter(config({ env: "prod", idempotencyConfirmed: true }), fakeDeps(queue()).deps);
    expect([live.key, live.sandbox, live.settlementAsset, live.dedupesOnOurKey]).toEqual(["nuvei", false, "EUR", true]);
  });

  it("refuses unsafe configurations", () => {
    expect(() => createNuveiAdapter(config({ notifyUrl: "http://insecure.example/x" }), fakeDeps(queue()).deps)).toThrow(/https/);
    expect(() => createNuveiAdapter(config({ merchantId: "abc" }), fakeDeps(queue()).deps)).toThrow(/numeric/);
  });
});

describe("Nuvei Payment Page deposit", () => {
  it("builds the signed redirect locally: values in order, secret first, GMT time stamp", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue());
    const result = await createNuveiAdapter(cfg, deps).createDepositSession({
      depositId: DEPOSIT, idempotencyKey: `dep_${DEPOSIT}`, amountMinor: 5000n, saveCard: true, customer,
      returnUrl: "https://poker-web-preview.example.workers.dev/wallet/return?d=1", notificationUrl: cfg.notifyUrl, expiresAt: new Date(NOW.getTime() + 900_000),
    });
    expect(requests).toHaveLength(0);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value.type).toBe("REDIRECT");
    expect(result.value.providerPaymentId).toBeNull();
    const url = new URL(result.value.url);
    expect(url.origin + url.pathname).toBe("https://ppp-test.safecharge.com/ppp/purchase.do");
    const params = [...url.searchParams];
    const names = params.map(([k]) => k);
    expect(names.slice(0, 13)).toEqual([
      "merchant_id", "merchant_site_id", "total_amount", "currency", "user_token_id", "item_name_1", "item_amount_1", "item_quantity_1",
      "time_stamp", "version", "encoding", "notify_url", "merchant_unique_id",
    ]);
    expect(names.at(-1)).toBe("checksum");
    const get = (name: string) => url.searchParams.get(name);
    expect([get("merchant_id"), get("total_amount"), get("currency"), get("item_amount_1"), get("time_stamp"), get("version"), get("merchant_unique_id"), get("user_token"), get("payment_method")])
      .toEqual([MERCHANT, "50.00", "EUR", "50.00", "2026-10-29.12:34:56", "4.0.0", DEPOSIT, "auto", "cc_card"]);
    expect(get("notify_url")).toBe(cfg.notifyUrl);
    const values = params.slice(0, -1).map(([, v]) => v).join("");
    expect(get("checksum")).toBe(await sha256Hex(cfg.secretKey + values));
  });

  it("pre-selects a saved card with readonlyupo", async () => {
    const result = await createNuveiAdapter(config(), fakeDeps(queue()).deps).createDepositSession({
      depositId: DEPOSIT, idempotencyKey: "dep_x", amountMinor: 1999n, instrumentToken: "2154941", saveCard: false, customer,
      returnUrl: "https://poker-web-preview.example.workers.dev/wallet/return", notificationUrl: "https://x.example/", expiresAt: NOW,
    });
    const url = new URL(result.kind === "ok" ? result.value.url : "https://none/");
    expect([url.searchParams.get("user_token"), url.searchParams.get("userPaymentOptionId"), url.searchParams.get("total_amount")]).toEqual(["readonlyupo", "2154941", "19.99"]);
  });

  it("refuses bad references and amounts without building anything", async () => {
    const adapter = createNuveiAdapter(config(), fakeDeps(queue()).deps);
    const base = { idempotencyKey: "dep_x", saveCard: false, customer, returnUrl: "https://x.example/r", notificationUrl: "https://x.example/n", expiresAt: NOW };
    expect(await adapter.createDepositSession({ ...base, depositId: DEPOSIT, amountMinor: 0n })).toMatchObject({ kind: "rejected", code: "BAD_AMOUNT" });
    expect(await adapter.createDepositSession({ ...base, depositId: "a&b=c", amountMinor: 100n })).toMatchObject({ kind: "rejected", code: "BAD_REFERENCE" });
  });
});

describe("Nuvei getPayment (the authoritative re-read)", () => {
  it("signs getTransactionDetails and credits an approved sale from Nuvei's own fields", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(200, details())));
    const result = await createNuveiAdapter(cfg, deps).getPayment({ providerPaymentId: SALE, merchantRef: DEPOSIT });
    const request = requests[0]!;
    expect(request.url.toString()).toBe("https://ppp-test.nuvei.com/ppp/api/v1/getTransactionDetails.do");
    expect(request.method).toBe("POST");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ merchantId: MERCHANT, merchantSiteId: SITE, transactionId: SALE, timeStamp: REST_TS });
    expect(body.clientUniqueId).toBeUndefined();
    expect(body.checksum).toBe(await sha256Hex(MERCHANT + SITE + SALE + REST_TS + cfg.secretKey));
    expect(result).toEqual({
      kind: "ok",
      value: {
        providerPaymentId: SALE, merchantRef: DEPOSIT, channelRef: "pc_7f3a9c", state: "SUCCEEDED", rawState: "sale:APPROVED", creditMinor: 10000n, feeMinor: null,
        card: { token: "2154941", fingerprint: null, brand: "VISA", last4: "1390", expMonth: 12, expYear: 2028, issuerCountry: "GB", funding: "debit", payoutEligible: true, holderName: "John Smith" },
        occurredAt: new Date("2026-10-29T12:30:00Z"),
      },
    });
  });

  it("fills the card's fingerprint from a signed getUserUPOs call, and a failed read costs the deposit nothing", async () => {
    const cfg = config();
    const upos = { status: "SUCCESS", merchantId: MERCHANT, merchantSiteId: SITE, paymentMethods: [{ userPaymentOptionId: 999, upoData: { uniqueCC: "someone-elses-card" } }, { userPaymentOptionId: 2154941, upoData: { uniqueCC: "aBcD1234eFgH5678iJkL9012mNoP" } }] };
    const { deps, requests } = fakeDeps(queue(json(200, details()), json(200, upos)));
    const result = await createNuveiAdapter(cfg, deps).getPayment({ providerPaymentId: SALE });
    expect(result).toMatchObject({ kind: "ok", value: { card: { fingerprint: "aBcD1234eFgH5678iJkL9012mNoP" } } });
    expect(requests[1]!.url.toString()).toBe("https://ppp-test.nuvei.com/ppp/api/v1/getUserUPOs.do");
    const body = JSON.parse(requests[1]!.body);
    expect(body).toMatchObject({ merchantId: MERCHANT, merchantSiteId: SITE, userTokenId: "pc_7f3a9c", timeStamp: REST_TS });
    expect(body.checksum).toBe(await sha256Hex(MERCHANT + SITE + "pc_7f3a9c" + body.clientRequestId + REST_TS + cfg.secretKey));
    for (const answer of [json(500, {}), json(200, { status: "ERROR", merchantId: MERCHANT, merchantSiteId: SITE }), json(200, { status: "SUCCESS", merchantId: "someone-else", paymentMethods: upos.paymentMethods }), json(200, { status: "SUCCESS", paymentMethods: [{ userPaymentOptionId: 2154941, upoData: { uniqueCC: "<script>" } }] })]) {
      const failed = fakeDeps(queue(json(200, details()), answer));
      expect(await createNuveiAdapter(config(), failed.deps).getPayment({ providerPaymentId: SALE })).toMatchObject({ kind: "ok", value: { state: "SUCCEEDED", card: { fingerprint: null } } });
    }
  });

  it("looks up by our deposit id (clientUniqueId) when there is no transaction id", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(200, details())));
    await createNuveiAdapter(cfg, deps).getPayment({ merchantRef: DEPOSIT });
    const body = JSON.parse(requests[0]!.body);
    expect(body.transactionId).toBeUndefined();
    expect(body.clientUniqueId).toBe(DEPOSIT);
    expect(body.checksum).toBe(await sha256Hex(MERCHANT + SITE + DEPOSIT + REST_TS + cfg.secretKey));
  });

  it("never credits a decline, a void, an auth, another currency or an unread amount", async () => {
    const cases: [Parameters<typeof details>[0], Record<string, unknown>][] = [
      [{ transactionDetails: { transactionStatus: "DECLINED" } }, { state: "FAILED", creditMinor: null }],
      [{ transactionDetails: { isVoided: "true" } }, { state: "CANCELLED", creditMinor: null }],
      [{ transactionDetails: { transactionType: "Auth" } }, { state: "NEEDS_REVIEW", creditMinor: null }],
      [{ partialApproval: { requestedCurrency: "USD", processedCurrency: "USD" } }, { state: "NEEDS_REVIEW", reviewReason: "WRONG_ASSET" }],
      [{ partialApproval: null }, { state: "NEEDS_REVIEW", reviewReason: "AMOUNT_MISMATCH" }],
      [{ partialApproval: { processedAmount: "60.0000" } }, { state: "NEEDS_REVIEW", reviewReason: "AMOUNT_MISMATCH" }],
      [{ partialApproval: { requestedAmount: "100.0050", processedAmount: "100.0050" } }, { state: "NEEDS_REVIEW", reviewReason: "AMOUNT_MISMATCH" }],
    ];
    for (const [shape, expected] of cases) {
      const { deps } = fakeDeps(queue(json(200, details(shape))));
      expect(await createNuveiAdapter(config(), deps).getPayment({ providerPaymentId: SALE }), JSON.stringify(shape)).toMatchObject({ kind: "ok", value: expected });
    }
  });

  it("answers null for an unknown transaction and uncertain for anything unreadable or foreign", async () => {
    const notFound = fakeDeps(queue(json(200, { status: "ERROR", errCode: 1069, reason: "Transaction not found", merchantId: MERCHANT, merchantSiteId: SITE })));
    expect(await createNuveiAdapter(config(), notFound.deps).getPayment({ providerPaymentId: SALE })).toEqual({ kind: "ok", value: null });
    const refused = fakeDeps(queue(json(200, { status: "ERROR", errCode: 1001, reason: "Invalid checksum" })));
    expect(await createNuveiAdapter(config(), refused.deps).getPayment({ providerPaymentId: SALE })).toEqual({ kind: "uncertain", reason: "malformed" });
    const foreign = fakeDeps(queue(json(200, details({ top: { merchantId: "999" } }))));
    expect(await createNuveiAdapter(config(), foreign.deps).getPayment({ providerPaymentId: SALE })).toEqual({ kind: "uncertain", reason: "malformed" });
    const down = fakeDeps(queue(json(502, "bad gateway")));
    expect(await createNuveiAdapter(config(), down.deps).getPayment({ providerPaymentId: SALE })).toEqual({ kind: "uncertain", reason: "5xx" });
    const none = fakeDeps(queue());
    expect(await createNuveiAdapter(config(), none.deps).getPayment({ providerPaymentId: "not-a-number" })).toEqual({ kind: "ok", value: null });
    expect(none.requests).toHaveLength(0);
  });
});

describe("Nuvei payouts and refunds", () => {
  it("pays out to the deposit card's userPaymentOptionId with the documented checksum", async () => {
    const cfg = config();
    const { deps, requests, logs } = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "APPROVED", transactionId: "7110000000001908999", userPaymentOptionId: "2154941", merchantId: MERCHANT, merchantSiteId: SITE, errCode: 0, reason: "" })));
    const result = await createNuveiAdapter(cfg, deps).createPayout(payout());
    expect(result).toMatchObject({ kind: "ok", value: { providerPayoutId: "7110000000001908999", merchantRef: payout().idempotencyKey, state: "SUCCEEDED", final: true } });
    expect(requests[0]!.url.pathname).toBe("/ppp/api/v1/payout.do");
    const body = JSON.parse(requests[0]!.body);
    const key = payout().idempotencyKey;
    expect(body).toMatchObject({
      merchantId: MERCHANT, merchantSiteId: SITE, clientRequestId: key, clientUniqueId: key, amount: "120.00", currency: "EUR", timeStamp: REST_TS,
      userTokenId: "pc_7f3a9c", userPaymentOption: { userPaymentOptionId: "2154941" }, deviceDetails: { ipAddress: "203.0.113.7" },
    });
    expect(body.checksum).toBe(await sha256Hex(MERCHANT + SITE + key + "120.00" + "EUR" + REST_TS + cfg.secretKey));
    expect(logText(logs)).not.toContain(cfg.secretKey);
  });

  it("marks scheme and credit-filter declines as method-ineligible", async () => {
    const { deps } = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "DECLINED", transactionId: "1", gwErrorCode: 1124, gwErrorReason: "Credit amount exceed total charges" })));
    expect(await createNuveiAdapter(config(), deps).createPayout(payout())).toMatchObject({ kind: "ok", value: { state: "FAILED", final: true, failureCode: "NUVEI_1124", methodIneligible: true } });
  });

  it("treats an ERROR or a refused dispatch as unknown (query before any retry)", async () => {
    for (const answer of [
      { status: "SUCCESS", transactionStatus: "ERROR", transactionId: "1" },
      { status: "ERROR", errCode: 1140, reason: "A transaction with this clientRequestId already exists" },
      { status: "SUCCESS", transactionStatus: "APPROVED", clientRequestId: "wd_someone_else" },
    ]) {
      const { deps } = fakeDeps(queue(json(200, answer)));
      expect(await createNuveiAdapter(config(), deps).createPayout(payout()), JSON.stringify(answer)).toEqual({ kind: "uncertain", reason: "malformed" });
    }
    const timeout = fakeDeps(queue(new DOMException("t", "TimeoutError") as unknown as Error));
    expect(await createNuveiAdapter(config(), timeout.deps).createPayout(payout())).toEqual({ kind: "uncertain", reason: "timeout" });
  });

  it("needs the player's IP (IPv4-mapped IPv6 is sent as IPv4) and a short key", async () => {
    const none = fakeDeps(queue());
    expect(await createNuveiAdapter(config(), none.deps).createPayout(payout({ customer: { ...customer, ip: null } }))).toMatchObject({ kind: "rejected", final: false, code: "CUSTOMER_IP_REQUIRED" });
    expect(await createNuveiAdapter(config(), none.deps).createPayout(payout({ idempotencyKey: "wd_" + "x".repeat(43) }))).toMatchObject({ kind: "rejected", code: "BAD_REFERENCE" });
    expect(none.requests).toHaveLength(0);
    const mapped = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "PENDING", transactionId: "2" })));
    expect(await createNuveiAdapter(config(), mapped.deps).createPayout(payout({ customer: { ...customer, ip: "::ffff:198.51.100.4" } }))).toMatchObject({ kind: "ok", value: { state: "PROCESSING", final: false } });
    expect(JSON.parse(mapped.requests[0]!.body).deviceDetails.ipAddress).toBe("198.51.100.4");
  });

  it("refunds against the sale with the refund checksum order", async () => {
    const cfg = config();
    const key = "rf_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f";
    const { deps, requests } = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "APPROVED", transactionId: "3", merchantId: MERCHANT, merchantSiteId: SITE })));
    const result = await createNuveiAdapter(cfg, deps).createPayout(payout({ idempotencyKey: key, operation: "REFUND", refundOf: { providerPaymentId: SALE } }));
    expect(result).toMatchObject({ kind: "ok", value: { state: "SUCCEEDED", merchantRef: key } });
    expect(requests[0]!.url.pathname).toBe("/ppp/api/v1/refundTransaction.do");
    const body = JSON.parse(requests[0]!.body);
    expect(body).toMatchObject({ clientRequestId: key, clientUniqueId: key, amount: "120.00", currency: "EUR", relatedTransactionId: SALE });
    expect(body.checksum).toBe(await sha256Hex(MERCHANT + SITE + key + key + "120.00" + "EUR" + SALE + REST_TS + cfg.secretKey));
    expect(body.authCode).toBeUndefined();
    expect(body.comment).toBeUndefined();
  });

  it("reads payout status by clientRequestId; a gateway ERROR on a read is final", async () => {
    const cfg = config();
    const key = payout().idempotencyKey;
    const ok = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "APPROVED", transactionId: "4", amount: "120", currency: "EUR", merchantId: MERCHANT, merchantSiteId: SITE })));
    expect(await createNuveiAdapter(cfg, ok.deps).getPayout({ idempotencyKey: key })).toMatchObject({ kind: "ok", value: { state: "SUCCEEDED", final: true, providerPayoutId: "4" } });
    expect(ok.requests[0]!.url.pathname).toBe("/ppp/api/v1/getPayoutStatus.do");
    expect(JSON.parse(ok.requests[0]!.body).checksum).toBe(await sha256Hex(MERCHANT + SITE + key + REST_TS + cfg.secretKey));
    const failed = fakeDeps(queue(json(200, { status: "SUCCESS", transactionStatus: "ERROR", transactionId: "4", gwErrorCode: -1100, gwErrorReason: "Do not honor" })));
    expect(await createNuveiAdapter(cfg, failed.deps).getPayout({ idempotencyKey: key })).toMatchObject({ kind: "ok", value: { state: "FAILED", final: true } });
    const missing = fakeDeps(queue(json(200, { status: "ERROR", errCode: 9, reason: "Payout not found" })));
    expect(await createNuveiAdapter(cfg, missing.deps).getPayout({ idempotencyKey: key })).toEqual({ kind: "ok", value: null });
  });

  it("reads a refund through getTransactionDetails and checks it is ours", async () => {
    const key = "rf_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f";
    const refund = fakeDeps(queue(json(200, details({ transactionDetails: { transactionType: "Refund", clientUniqueId: key, transactionId: "5" } }))));
    expect(await createNuveiAdapter(config(), refund.deps).getPayout({ idempotencyKey: key })).toMatchObject({ kind: "ok", value: { state: "SUCCEEDED", providerPayoutId: "5", merchantRef: key } });
    expect(JSON.parse(refund.requests[0]!.body).clientUniqueId).toBe(key);
    const other = fakeDeps(queue(json(200, details())));
    expect(await createNuveiAdapter(config(), other.deps).getPayout({ idempotencyKey: key })).toEqual({ kind: "uncertain", reason: "malformed" });
  });
});

describe("Nuvei payment DMN", () => {
  async function dmn(secret: string, overrides: Record<string, string> = {}) {
    const fields: Record<string, string> = {
      ppp_status: "OK", Status: "APPROVED", ExErrCode: "0", ErrCode: "0", message: "APPROVED", responseTimeStamp: "2026-10-29.12:35:10", Reason: "", ReasonCode: "0",
      totalAmount: "50.00", currency: "EUR", TransactionID: SALE, PPP_TransactionID: "547418201", productId: "Account deposit", userPaymentOptionId: "2154941",
      uniqueCC: "uZx3Q0aN6p8", nameOnCard: "John Smith", cardNumber: "4****1390", bin: "401200", cardCompany: "Visa", cardType: "Debit", expMonth: "12", expYear: "28",
      user_token_id: "pc_7f3a9c", merchant_unique_id: DEPOSIT, transactionType: "Sale", type: "DEPOSIT", email: "jane@example.com", first_name: "Jane",
      ...overrides,
    };
    const signed = secret + fields.totalAmount + fields.currency + fields.responseTimeStamp + fields.PPP_TransactionID + fields.Status + fields.productId;
    fields.advanceResponseChecksum = overrides.advanceResponseChecksum ?? await sha256Hex(signed);
    return new URLSearchParams(fields).toString(); // spaces become "+", as Nuvei posts them
  }
  const request = (body: string, method = "POST", search = "") => ({
    method,
    url: new URL(`https://poker-payments-preview.example.workers.dev/webhooks/sandbox-nuvei${search}`),
    headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    rawBody: bytes(body),
    receivedAt: NOW,
    sourceIp: null,
  });

  it("verifies advanceResponseChecksum (with '+' read as a space) and gives a deposit hint", async () => {
    const cfg = config();
    const body = await dmn(cfg.secretKey);
    expect(body).toContain("productId=Account+deposit");
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(request(body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme).toBe("nuvei-dmn-sha256");
    const [event] = result.events;
    expect(event).toMatchObject({
      providerEventId: "dmn:547418201:APPROVED:2026-10-29T12:35:10.000Z", eventType: "dmn.sale.approved", objectType: "PAYMENT", objectRef: SALE, merchantRef: DEPOSIT,
      payment: { providerPaymentId: SALE, merchantRef: DEPOSIT, channelRef: "pc_7f3a9c", state: "SUCCEEDED", creditMinor: 5000n, card: { token: "2154941", last4: "1390", brand: "Visa", funding: "debit" } },
    });
    const stored = JSON.stringify(event!.payload);
    for (const absent of ["John Smith", "jane@example.com", "4****1390", "401200", "Jane", "uZx3Q0aN6p8"]) expect(stored, absent).not.toContain(absent);
    expect(event!.payload).toMatchObject({ last4: "1390", totalAmount: "50.00", Status: "APPROVED" });
  });

  it("accepts a query-string DMN and the previous secret while rotating", async () => {
    const previous = randomSecret();
    const body = await dmn(previous);
    const result = await createNuveiAdapter(config({ secretKeyPrevious: previous }), fakeDeps(queue()).deps).verifyWebhook(request("", "GET", `?${body}`));
    expect(result.ok).toBe(true);
  });

  it("refuses a wrong checksum, an MD5 site setting, a repeated signed field and a missing one", async () => {
    const cfg = config();
    const adapter = createNuveiAdapter(cfg, fakeDeps(queue()).deps);
    expect(await adapter.verifyWebhook(request(await dmn(randomSecret())))).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook(request((await dmn(cfg.secretKey)).replace("totalAmount=50.00", "totalAmount=500.00")))).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook(request(await dmn(cfg.secretKey, { advanceResponseChecksum: "0".repeat(32) })))).toEqual({ ok: false, reason: "unsupported_scheme" });
    expect(await adapter.verifyWebhook(request(`${await dmn(cfg.secretKey)}&status=DECLINED`))).toEqual({ ok: false, reason: "format" });
    const noCurrency = new URLSearchParams(await dmn(cfg.secretKey));
    noCurrency.delete("currency");
    expect(await adapter.verifyWebhook(request(noCurrency.toString()))).toEqual({ ok: false, reason: "format" });
    expect(await adapter.verifyWebhook(request(""))).toEqual({ ok: false, reason: "format" });
  });

  it("names the event by signed fields only and refuses a parameter set signed more than 7 days ago (wallet review PCD-4)", async () => {
    const cfg = config();
    const adapter = createNuveiAdapter(cfg, fakeDeps(queue()).deps);
    const first = await adapter.verifyWebhook(request(await dmn(cfg.secretKey)));
    // The same signed set with another unsigned TransactionID / transactionType is the same event (deduplicated by the inbox).
    const replay = await adapter.verifyWebhook(request(await dmn(cfg.secretKey, { TransactionID: "7110000000001909999", transactionType: "Auth" })));
    expect(first.ok && replay.ok && first.events[0]!.providerEventId === replay.events[0]!.providerEventId).toBe(true);
    expect(await adapter.verifyWebhook(request(await dmn(cfg.secretKey, { responseTimeStamp: "2026-10-21.12:00:00" })))).toEqual({ ok: false, reason: "format" });
    // The age check cannot be skipped: a stamp that does not read as one is refused, signed or not.
    for (const stamp of ["not-a-time", "20261029123510", "2026-13-45.12:00:00", "2026-10-29 12:35:10", ""]) {
      expect(await adapter.verifyWebhook(request(await dmn(cfg.secretKey, { responseTimeStamp: stamp })))).toEqual({ ok: false, reason: "format" });
    }
    // Every signed field has its exact shape, with a correct checksum over the wrong one.
    for (const wrong of ([{ totalAmount: "1234567890123456" }, { totalAmount: "50.00EUR" }, { currency: "eur" }, { currency: "EUR2" }, { PPP_TransactionID: "12a" }, { Status: "approved" }, { Status: "APPROVEDX" }] as Record<string, string>[])) {
      expect(await adapter.verifyWebhook(request(await dmn(cfg.secretKey, wrong)))).toEqual({ ok: false, reason: "format" });
    }
  });

  it("maps our own payout's credit DMN to a payout hint", async () => {
    const cfg = config();
    const key = payout().idempotencyKey;
    const body = await dmn(cfg.secretKey, { transactionType: "Credit", merchant_unique_id: key, TransactionID: "7110000000001909000", type: "WITHDRAWAL" });
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(request(body));
    expect(result.ok && result.events[0]).toMatchObject({ objectType: "PAYOUT", merchantRef: key, payout: { state: "SUCCEEDED", merchantRef: key } });
  });

  it("records a chargeback DMN as informational only (its link to the sale is unsigned)", async () => {
    const cfg = config();
    const body = await dmn(cfg.secretKey, { transactionType: "Chargeback", relatedTransactionId: SALE, TransactionID: "7110000000001909001" });
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(request(body));
    expect(result.ok && result.events[0]).toMatchObject({ objectType: "DISPUTE", objectRef: SALE, dispute: { kind: "CHARGEBACK", providerPaymentId: SALE, amountMinor: 5000n, informational: true } });
  });

  it("does not credit from a DMN whose amount is not EUR", async () => {
    const cfg = config();
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(request(await dmn(cfg.secretKey, { currency: "USD" })));
    expect(result.ok && result.events[0]).toMatchObject({ payment: { state: "NEEDS_REVIEW", reviewReason: "WRONG_ASSET", creditMinor: null } });
  });
});

describe("Nuvei Control Panel chargeback events", () => {
  // Field names from the Control Panel events page; the 19-digit TransactionId is a JSON number there.
  const EVENT = `{"EventId":"a1b2c3","EventType":"Chargeback","EventDateUTC":"2026-10-28T10:00:00Z","Chargeback":{"Type":"Chargeback","Status":"Chargeback Opened","ChargebackStatusCategory":"Regular","Amount":50.00,"Currency":"EUR","ReportedAmount":50.00,"ReportedCurrency":"EUR","ChargebackReason":"10.4 Other Fraud","DisputeId":"98765","Date":"2026-10-28T09:00:00"},"TransactionDetails":{"TransactionId":${SALE},"ClientUniqueId":"${DEPOSIT}","MaskedCardNumber":"4****1390","Arn":"74537604221431003881865"}}`;
  const event = (body: string, checksum: string) => ({
    method: "POST",
    url: new URL("https://poker-payments.example.workers.dev/webhooks/nuvei"),
    headers: new Headers({ "content-type": "application/json", checksum }),
    rawBody: bytes(body),
    receivedAt: NOW,
    sourceIp: null,
  });

  it("verifies the raw-body checksum and turns a regular chargeback into a money-moving dispute", async () => {
    const cfg = config({ env: "prod" });
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(event(EVENT, await sha256Hex(cfg.secretKey + EVENT)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme).toBe("nuvei-event-raw-sha256");
    expect(result.events[0]).toMatchObject({
      providerEventId: "cp:a1b2c3", objectType: "DISPUTE", objectRef: SALE, merchantRef: DEPOSIT,
      dispute: { providerReversalId: "dispute:98765", providerPaymentId: SALE, kind: "CHARGEBACK", amountMinor: 5000n, reasonCode: "10.4 Other Fraud", occurredAt: new Date("2026-10-28T10:00:00Z") },
    });
    expect("dispute" in result.events[0]! && result.events[0].dispute.informational).toBeUndefined();
    expect(JSON.stringify(result.events[0]!.payload)).not.toContain("4****1390");
  });

  it("refuses the values-in-order checksum form (keys unsigned: forgeable from a Payment Page checksum)", async () => {
    const cfg = config();
    const values = ["a1b2c3", "Chargeback", "2026-10-28T10:00:00Z", "Chargeback", "Chargeback Opened", "Regular", "50.00", "EUR", "50.00", "EUR", "10.4 Other Fraud", "98765", "2026-10-28T09:00:00", SALE, DEPOSIT, "4****1390", "74537604221431003881865"];
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(event(EVENT, await sha256Hex(cfg.secretKey + values.join(""))));
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a chargeback re-split from the player's own Payment Page checksum (wallet review PCD-1)", async () => {
    const cfg = config({ env: "prod" });
    const adapter = createNuveiAdapter(cfg, fakeDeps(queue()).deps);
    // The attacker's own verified email embeds the victim's sale id and the word "chargeback".
    const session = await adapter.createDepositSession({
      depositId: "5f0c2a8e-8b8f-4c3e-9d0a-2b7c1e4f6a90", idempotencyKey: "dep_x", amountMinor: 500000n, saveCard: true,
      customer: { userId: "u_attacker", providerCustomerRef: "pc_attacker01", email: `${SALE}chargeback@example.com`, country: "MT", legalName: { first: "Mallory", last: "Doe" }, ip: "198.51.100.7" },
      returnUrl: "https://poker-web.example.workers.dev/wallet?deposit=5f0c2a8e-8b8f-4c3e-9d0a-2b7c1e4f6a90",
      notificationUrl: cfg.notifyUrl, expiresAt: new Date(NOW.getTime() + 900_000),
    });
    expect(session.kind).toBe("ok");
    if (session.kind !== "ok") return;
    // Only what the browser receives: the redirect URL and its checksum.
    const params = [...new URL(session.value.url).searchParams];
    const checksum = params.find(([name]) => name === "checksum")![1];
    const values = params.filter(([name]) => name !== "checksum").map(([, value]) => value);
    const at = (n: string) => params.findIndex(([k]) => k === n);
    const [iTotal, iCurrency, iEmail] = [at("total_amount"), at("currency"), at("email")];
    const email = values[iEmail]!;
    const body = JSON.stringify({
      a: values.slice(0, iTotal).join(""),
      Chargeback: { Amount: values[iTotal], Currency: values[iCurrency] },
      b: values.slice(iCurrency + 1, iEmail).join(""),
      TransactionDetails: { TransactionId: email.slice(0, SALE.length) },
      EventType: "chargeback",
      c: email.slice(SALE.length + "chargeback".length) + values.slice(iEmail + 1).join(""),
    });
    expect(await adapter.verifyWebhook(event(body, checksum))).toEqual({ ok: false, reason: "signature" });
  });

  it("keeps retrievals and soft chargebacks informational, and refuses a wrong checksum", async () => {
    const cfg = config();
    const retrieval = EVENT.replace('"Type":"Chargeback"', '"Type":"Retrieval"');
    const result = await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(event(retrieval, await sha256Hex(cfg.secretKey + retrieval)));
    expect(result.ok && result.events[0]).toMatchObject({ dispute: { informational: true } });
    expect(await createNuveiAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(event(EVENT, await sha256Hex(randomSecret() + EVENT)))).toEqual({ ok: false, reason: "signature" });
  });
});
