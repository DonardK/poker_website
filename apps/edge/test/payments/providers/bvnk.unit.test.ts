/**
 * BVNK adapter (src/payments/providers/bvnk): Hawk-signed calls, per-player
 * channels, channel payments, two-step payouts with resumption, x-signature
 * webhooks, lossless amounts and the relay egress. Webhook bodies are BVNK's
 * documented examples (docs.bvnk.com webhook reference) signed locally;
 * nothing touches the network.
 */
import { describe, expect, it } from "vitest";
import { createBvnkAdapter } from "../../../src/payments/providers/bvnk";
import type { BvnkConfig, CustomerRef, PayoutInput, TravelRuleParty } from "../../../src/payments/providers/types";
import { base64, bytes, fakeDeps, hmacBytes, json, logText, NOW, queue, randomSecret, type Recorded } from "./fakes";

const WALLET = "a1b2c3d4-0000-4000-8000-000000000001";

function config(overrides: Partial<BvnkConfig> = {}): BvnkConfig {
  return {
    env: "sandbox",
    walletIdEur: WALLET,
    assetMap: { BTC: { payCurrency: "BTC", network: "BITCOIN" }, USDC_ERC20: { payCurrency: "USDC", network: "ETHEREUM" } },
    webhookScheme: "v2_base64",
    hawkAuthId: "test-hawk-id",
    hawkAuthKey: randomSecret(),
    webhookSecret: randomSecret(),
    webhookSecretPrevious: null,
    egress: { mode: "direct" },
    ...overrides,
  };
}

const customer: CustomerRef = { userId: "u1", providerCustomerRef: "pc_7f3a9c", email: null, country: "MT", legalName: { first: "Jane", last: "Doe" }, ip: "203.0.113.7" };
const originator: TravelRuleParty = { type: "ORIGINATOR", firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-04-02", countryCode: "MT", relationship: "SELF_OWNED" };
const beneficiary: TravelRuleParty = { ...originator, type: "BENEFICIARY" };

/** Recomputes the Hawk MAC from the header's own fields, for BVNK's host (never the relay's). */
async function expectHawk(request: Recorded, key: string, host: string): Promise<void> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Hawk id="([^"]+)", ts="([0-9]+)", nonce="([A-Za-z0-9]+)", mac="([A-Za-z0-9+/=]+)"$/.exec(header);
  expect(match, header).not.toBeNull();
  const [, id, ts, nonce, mac] = match!;
  expect(id).toBe("test-hawk-id");
  expect(ts).toBe(String(Math.floor(NOW.getTime() / 1000)));
  expect(nonce!.length).toBeGreaterThanOrEqual(6);
  const normalized = `hawk.1.header\n${ts}\n${nonce}\n${request.method}\n${request.url.pathname}${request.url.search}\n${host}\n443\n\n\n`;
  expect(mac).toBe(base64(await hmacBytes("SHA-256", key, normalized)));
}

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: 59157,
    uuid: "9d1f67f2-a647-404b-9b02-247c77be81d0",
    walletId: WALLET,
    walletCurrency: "EUR",
    displayCurrency: "EUR",
    payCurrency: "BTC",
    address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    tag: null,
    network: "BITCOIN",
    status: "OPEN",
    redirectUrl: "https://pay.sandbox.bvnk.com/channel?uuid=9d1f67f2-a647-404b-9b02-247c77be81d0",
    dateCreated: 1755116308000,
    ...overrides,
  };
}

function payout(overrides: Partial<PayoutInput> = {}): PayoutInput {
  return {
    withdrawalId: "0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f",
    idempotencyKey: "wd_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f",
    operation: "PAYOUT",
    amountMinor: 12000n,
    feeMinor: 0n,
    destination: { kind: "CRYPTO_ADDRESS", asset: "USDC_ERC20", network: "ETHEREUM", address: "0xa59d9f28537a3A9EE18E76A9fCe8261B0CA33723", memo: null },
    customer,
    beneficiary,
    ...overrides,
  };
}

/** A SummaryPaymentDto as the payout endpoints answer (shape of BVNK's crypto status-change example). */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "96491bf1-5af6-4a42-9d35-6e623a9e3426",
    type: "OUT",
    reference: payout().idempotencyKey,
    status: "PENDING",
    quoteStatus: "ACCEPTED",
    walletId: WALLET,
    walletCurrency: { actual: 120, amount: 120.0, currency: "EUR" },
    paidCurrency: { actual: 0, amount: 119.731, currency: "USDC" },
    exchangeRate: { base: "EUR", rate: 0.99775833, counter: "USDC" },
    transactions: [],
    dateCreated: NOW.getTime() - 1000,
    quoteExpiryDate: NOW.getTime() + 3_600_000,
    acceptanceExpiryDate: NOW.getTime() + 900_000,
    ...overrides,
  };
}

async function signedWebhook(secret: string, body: string, method = "POST") {
  return {
    method,
    url: new URL("https://poker-payments.example.workers.dev/webhooks/sandbox-bvnk"),
    headers: new Headers({ "content-type": "application/json", "x-signature": base64(await hmacBytes("SHA-256", secret, body)) }),
    rawBody: bytes(body),
    receivedAt: NOW,
    sourceIp: null,
  };
}

describe("BVNK adapter identity", () => {
  it("books sandbox under sandbox-bvnk in TEST_EUR and production under bvnk in EUR", () => {
    const sandbox = createBvnkAdapter(config(), fakeDeps(queue()).deps);
    expect([sandbox.key, sandbox.sandbox, sandbox.settlementAsset, sandbox.method, sandbox.authoritativeWebhooks, sandbox.dedupesOnOurKey]).toEqual(["sandbox-bvnk", true, "TEST_EUR", "CRYPTO", false, true]);
    const live = createBvnkAdapter(config({ env: "production" }), fakeDeps(queue()).deps);
    expect([live.key, live.sandbox, live.settlementAsset]).toEqual(["bvnk", false, "EUR"]);
  });

  it("refuses configurations it cannot run safely", () => {
    expect(() => createBvnkAdapter(config({ assetMap: {} }), fakeDeps(queue()).deps)).toThrow(/BVNK_ASSET_MAP/);
    expect(() => createBvnkAdapter(config({ hawkAuthId: 'bad"id' }), fakeDeps(queue()).deps)).toThrow(/BVNK_HAWK_AUTH_ID/);
    expect(() => createBvnkAdapter(config({ webhookScheme: "legacy" as "v2_base64" }), fakeDeps(queue()).deps)).toThrow(/v2_base64/);
  });
});

describe("BVNK deposit channels (one per player and asset)", () => {
  it("creates the player's channel when none exists, Hawk-signed, with travel-rule details", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(200, []), json(201, channel())));
    const adapter = createBvnkAdapter(cfg, deps);
    const result = await adapter.createDepositSession({ depositId: "d1", idempotencyKey: "dep_d1", amountMinor: 5000n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    expect(result).toEqual({
      kind: "ok",
      value: {
        type: "CRYPTO_INVOICE", providerPaymentId: "9d1f67f2-a647-404b-9b02-247c77be81d0", reusableAddress: true, asset: "BTC", network: "BITCOIN",
        address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", memo: null, payAmount: null, expiresAt: null, minConfirmations: 0,
        hostedUrl: "https://pay.sandbox.bvnk.com/channel?uuid=9d1f67f2-a647-404b-9b02-247c77be81d0",
      },
    });
    const [list, create] = requests;
    expect(list!.method).toBe("GET");
    expect(list!.url.origin + list!.url.pathname).toBe("https://api.sandbox.bvnk.com/api/v2/channel");
    expect(list!.url.searchParams.get("walletId")).toBe(WALLET);
    const reference = list!.url.searchParams.get("q")!;
    expect(reference).toMatch(/^cha_[0-9a-f]{32}$/);
    await expectHawk(list!, cfg.hawkAuthKey, "api.sandbox.bvnk.com");
    expect(create!.method).toBe("POST");
    expect(create!.url.pathname).toBe("/api/v2/channel");
    await expectHawk(create!, cfg.hawkAuthKey, "api.sandbox.bvnk.com");
    // v2 endpoints take Idempotency-Key (a UUID derived from the reference).
    expect(create!.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(create!.headers.get("x-idempotency-key")).toBeNull();
    expect(JSON.parse(create!.body)).toEqual({
      walletId: WALLET, payCurrency: "BTC", displayCurrency: "EUR", reference, customerId: "pc_7f3a9c", network: "BITCOIN",
      complianceDetails: {
        requesterIpAddress: "203.0.113.7",
        partyDetails: [{ type: "ORIGINATOR", entityType: "INDIVIDUAL", firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-04-02", relationshipType: "SELF_OWNED", countryCode: "MT" }],
      },
    });
  });

  it("reuses the player's existing channel (same reference, no create)", async () => {
    const first = fakeDeps(queue(json(200, []), json(201, channel())));
    await createBvnkAdapter(config({ hawkAuthKey: "k".repeat(32) }), first.deps).createDepositSession({ depositId: "d1", idempotencyKey: "dep_d1", amountMinor: 5000n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    const reference = first.requests[0]!.url.searchParams.get("q")!;
    const older = channel({ uuid: "11111111-1111-4111-8111-111111111111", reference, dateCreated: 1700000000000, address: "bc1qolder" });
    const second = fakeDeps(queue(json(200, [channel({ reference, dateCreated: 1755116308000 }), older, channel({ reference: "someone-else", uuid: "x" })])));
    const result = await createBvnkAdapter(config({ hawkAuthKey: "k".repeat(32) }), second.deps).createDepositSession({ depositId: "d2", idempotencyKey: "dep_d2", amountMinor: 9000n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.url.searchParams.get("q")).toBe(reference);
    // Two channels for one reference (a create race): the oldest wins, always.
    expect(result.kind === "ok" && result.value.address).toBe("bc1qolder");
  });

  it("uses a different channel per asset and per player", async () => {
    const refs: string[] = [];
    for (const [asset, ref] of [["BTC", "pc_a"], ["USDC_ERC20", "pc_a"], ["BTC", "pc_b"]] as const) {
      const { deps, requests } = fakeDeps(queue(json(500, {})));
      await createBvnkAdapter(config({ hawkAuthKey: "k".repeat(32) }), deps).createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: asset, customer: { ...customer, providerCustomerRef: ref }, originator, expiresAt: NOW });
      refs.push(requests[0]!.url.searchParams.get("q")!);
    }
    expect(new Set(refs).size).toBe(3);
  });

  it("never shows an address on another network or for another wallet currency", async () => {
    const network = await createBvnkAdapter(config(), fakeDeps(queue(json(200, []), json(201, channel({ network: "LIGHTNING" })))).deps)
      .createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    expect(network).toMatchObject({ kind: "rejected", final: true, code: "NETWORK_MISMATCH" });
    const wallet = await createBvnkAdapter(config(), fakeDeps(queue(json(200, []), json(201, channel({ walletCurrency: "USD" })))).deps)
      .createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    expect(wallet).toMatchObject({ kind: "rejected", final: true, code: "WALLET_MISMATCH" });
  });

  it("refuses unmapped assets without a call, and answers uncertain on 5xx and timeouts", async () => {
    const none = fakeDeps(queue());
    expect(await createBvnkAdapter(config(), none.deps).createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "DOGE", customer, originator, expiresAt: NOW }))
      .toMatchObject({ kind: "rejected", code: "ASSET_UNSUPPORTED" });
    expect(none.requests).toHaveLength(0);
    expect(await createBvnkAdapter(config(), fakeDeps(queue(json(503, {}))).deps).createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "BTC", customer, originator, expiresAt: NOW }))
      .toEqual({ kind: "uncertain", reason: "5xx" });
    expect(await createBvnkAdapter(config(), fakeDeps(queue(new DOMException("t", "TimeoutError") as unknown as Error)).deps).createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "BTC", customer, originator, expiresAt: NOW }))
      .toEqual({ kind: "uncertain", reason: "timeout" });
  });

  it("finds a channel created by an earlier attempt when the create is refused", async () => {
    const { deps, requests } = fakeDeps((request, index) => {
      if (index === 0) return json(200, []);
      if (index === 1) return json(400, { requestId: "r", errorList: [{ code: "idempotency", parameter: "", message: "request with this ID already exists" }] });
      return json(200, [channel({ reference: requests[0]!.url.searchParams.get("q") })]);
    });
    const result = await createBvnkAdapter(config(), deps).createDepositSession({ depositId: "d", idempotencyKey: "dep_d", amountMinor: 1n, payAsset: "BTC", customer, originator, expiresAt: NOW });
    expect(result.kind).toBe("ok");
    expect(requests).toHaveLength(3);
  });
});

describe("BVNK channel payments", () => {
  function channelPayment(overrides: Record<string, unknown> = {}) {
    return {
      channelId: "9d1f67f2-a647-404b-9b02-247c77be81d0", reference: "cha_x", status: "COMPLETE", uuid: "0198a515-8671-7ad8-bd58-79abec301e89",
      hash: "0x97b27d27df128f027d2a124b3757c93cd3c1a4934876c0e4a79891c414c1c0b6", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", tag: null,
      paidCurrency: "BTC", walletCurrency: "EUR", feeCurrency: "EUR", sources: ["bc1qsender"], dateCreated: 1755116308000, lastUpdated: 1755116352463,
      ...overrides,
    };
  }
  const read = async (body: string, status = 200) => {
    const { deps, requests, logs } = fakeDeps(queue(new Response(body, { status, headers: { "content-type": "application/json" } })));
    const result = await createBvnkAdapter(config(), deps).getPayment({ providerPaymentId: "0198a515-8671-7ad8-bd58-79abec301e89" });
    return { result, requests, logs };
  };

  it("credits a COMPLETE EUR payment, floored to the cent, read losslessly", async () => {
    const body = JSON.stringify(channelPayment()).replace('"walletCurrency":"EUR"', '"paidAmount":0.00151234567890123456,"walletAmount":115.694,"feeAmount":0.58,"walletCurrency":"EUR"');
    const { result, requests, logs } = await read(body);
    expect(requests[0]!.url.pathname).toBe("/api/v2/channel/payment/0198a515-8671-7ad8-bd58-79abec301e89");
    expect(result.kind).toBe("ok");
    const payment = result.kind === "ok" ? result.value! : null;
    expect(payment).toMatchObject({ providerPaymentId: "0198a515-8671-7ad8-bd58-79abec301e89", merchantRef: null, channelRef: "9d1f67f2-a647-404b-9b02-247c77be81d0", state: "SUCCEEDED", creditMinor: 11569n, feeMinor: 58n });
    expect(payment!.crypto).toEqual({ asset: "BTC", network: "BITCOIN", amount: "0.00151234567890123456", txHash: "0x97b27d27df128f027d2a124b3757c93cd3c1a4934876c0e4a79891c414c1c0b6", confirmations: null, address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", memo: null, sources: ["bc1qsender"] });
    expect(payment!.occurredAt).toEqual(new Date(1755116352463));
    expect(logs.some((l) => l.fields.alert === "CREDIT_REMAINDER" && l.fields.remainder === "0.004")).toBe(true);
  });

  it("never credits DETECTED, HELD, non-EUR or unreadable amounts", async () => {
    const detected = await read(JSON.stringify(channelPayment({ status: "DETECTED" })));
    expect(detected.result).toMatchObject({ kind: "ok", value: { state: "PROCESSING", creditMinor: null } });
    const held = await read(JSON.stringify(channelPayment({ status: "HELD" })));
    expect(held.result).toMatchObject({ kind: "ok", value: { state: "PROCESSING", reviewReason: "KYT_HOLD", creditMinor: null } });
    // BVNK's documented example settles into a USD wallet: wrong asset for us.
    const usd = await read(JSON.stringify(channelPayment({ walletCurrency: "USD", walletAmount: 9.9 })));
    expect(usd.result).toMatchObject({ kind: "ok", value: { state: "NEEDS_REVIEW", reviewReason: "WRONG_ASSET", creditMinor: null } });
    const missing = await read(JSON.stringify(channelPayment()));
    expect(missing.result).toMatchObject({ kind: "ok", value: { state: "NEEDS_REVIEW", reviewReason: "AMOUNT_MISMATCH" } });
  });

  it("answers null for an unknown payment and for a deposit id alone", async () => {
    expect((await read("", 404)).result).toEqual({ kind: "ok", value: null });
    const { deps, requests } = fakeDeps(queue());
    expect(await createBvnkAdapter(config(), deps).getPayment({ merchantRef: "d1" })).toEqual({ kind: "ok", value: null });
    expect(requests).toHaveLength(0);
  });

  it("treats a malformed 200 as uncertain, never as an answer", async () => {
    expect((await read("{not json")).result).toEqual({ kind: "uncertain", reason: "malformed" });
    expect((await read(JSON.stringify({ status: "COMPLETE" }))).result).toEqual({ kind: "uncertain", reason: "malformed" });
  });
});

describe("BVNK payouts (two-step: create, then confirm)", () => {
  it("creates with a bare JSON-number amount and our key as reference, then confirms", async () => {
    const cfg = config();
    const { deps, requests } = fakeDeps(queue(json(200, summary()), json(200, summary({ status: "PROCESSING" }))));
    const result = await createBvnkAdapter(cfg, deps).createPayout(payout());
    expect(result).toMatchObject({ kind: "ok", value: { providerPayoutId: "96491bf1-5af6-4a42-9d35-6e623a9e3426", merchantRef: payout().idempotencyKey, state: "PROCESSING", final: false, payoutAmount: "119.731", rate: "0.99775833" } });
    const [create, confirm] = requests;
    expect(create!.url.pathname).toBe("/api/v1/pay/summary");
    expect(create!.body).toContain('"amount":120.00,');
    expect(create!.headers.get("x-idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(create!.body)).toMatchObject({
      walletId: WALLET, type: "OUT", currency: "EUR", reference: payout().idempotencyKey, customerId: "pc_7f3a9c", twoStep: true,
      payOutDetails: { code: "crypto", currency: "USDC", network: "ETHEREUM", address: "0xa59d9f28537a3A9EE18E76A9fCe8261B0CA33723" },
      complianceDetails: { partyDetails: [{ type: "BENEFICIARY", entityType: "INDIVIDUAL", relationshipType: "SELF_OWNED" }] },
    });
    expect(confirm!.method).toBe("PUT");
    expect(confirm!.url.pathname).toBe("/api/v1/pay/96491bf1-5af6-4a42-9d35-6e623a9e3426/confirm/summary");
    expect(confirm!.body).toBe("");
    await expectHawk(confirm!, cfg.hawkAuthKey, "api.sandbox.bvnk.com");
  });

  it("resumes a payout an earlier attempt created (Duplicate Reference)", async () => {
    const { deps, requests } = fakeDeps(queue(
      json(400, { requestId: "r", errorList: [{ code: "unique", parameter: "reference", message: "Duplicate Reference" }] }),
      json(200, [summary()]),
      json(200, summary({ status: "PROCESSING" })),
    ));
    const result = await createBvnkAdapter(config(), deps).createPayout(payout());
    expect(result).toMatchObject({ kind: "ok", value: { state: "PROCESSING" } });
    expect(requests[1]!.url.pathname).toBe("/api/v1/pay/summary");
    expect(requests[1]!.url.searchParams.get("reference")).toBe(payout().idempotencyKey);
    expect(requests[2]!.url.pathname).toContain("/confirm/summary");
  });

  it("looks for our payout before believing any refusal", async () => {
    const found = fakeDeps(queue(json(400, { errorList: [{ code: "somethingNew", message: "?" }] }), json(200, [summary({ status: "PROCESSING" })])));
    expect(await createBvnkAdapter(config(), found.deps).createPayout(payout())).toMatchObject({ kind: "ok", value: { state: "PROCESSING" } });
    const refused = fakeDeps(queue(json(400, { errorList: [{ code: "invalidPayout", parameter: "payOutInstruction", message: "no" }] }), json(200, [])));
    expect(await createBvnkAdapter(config(), refused.deps).createPayout(payout())).toMatchObject({ kind: "rejected", final: true, code: "DESTINATION_INVALID" });
    const broke = fakeDeps(queue(json(400, [{ code: "MER-PAY-2012", message: "Insufficient funds" }]), json(200, [])));
    expect(await createBvnkAdapter(config(), broke.deps).createPayout(payout())).toMatchObject({ kind: "rejected", final: false, code: "PROVIDER_INSUFFICIENT_FUNDS" });
    expect(broke.logs.some((l) => l.fields.alert === "BVNK_INSUFFICIENT_FUNDS")).toBe(true);
    // "Duplicate" yet not visible: unknown, never refused (the hold must stay).
    const ghost = fakeDeps(queue(json(400, { errorList: [{ code: "unique", parameter: "reference", message: "Duplicate Reference" }] }), json(200, [])));
    expect(await createBvnkAdapter(config(), ghost.deps).createPayout(payout())).toEqual({ kind: "uncertain", reason: "malformed" });
  });

  it("does not confirm a payout that is not ours or not the amount we asked for", async () => {
    const other = fakeDeps(queue(json(200, summary({ walletCurrency: { amount: 1200, currency: "EUR" } }))));
    expect(await createBvnkAdapter(config(), other.deps).createPayout(payout())).toEqual({ kind: "uncertain", reason: "malformed" });
    expect(other.requests).toHaveLength(1);
    expect(other.logs.some((l) => l.fields.alert === "BVNK_PAYOUT_MISMATCH")).toBe(true);
  });

  it("refuses card destinations, unmapped assets and amounts under BVNK's 5 EUR minimum without a call", async () => {
    const { deps, requests } = fakeDeps(queue());
    const adapter = createBvnkAdapter(config(), deps);
    expect(await adapter.createPayout(payout({ destination: { kind: "CARD_TOKEN", token: "t", holderName: "J" } }))).toMatchObject({ kind: "rejected", code: "DESTINATION_UNSUPPORTED" });
    expect(await adapter.createPayout(payout({ amountMinor: 499n }))).toMatchObject({ kind: "rejected", code: "BELOW_PROVIDER_MINIMUM" });
    expect(await adapter.quotePayout({ amountMinor: 499n, destination: payout().destination })).toMatchObject({ kind: "rejected", code: "BELOW_PROVIDER_MINIMUM" });
    expect(requests).toHaveLength(0);
  });

  it("reports auth refusals as retry-later with an alert, and keeps secrets out of logs", async () => {
    const cfg = config();
    const { deps, logs } = fakeDeps(queue(json(401, { message: "Unauthorized" })));
    expect(await createBvnkAdapter(cfg, deps).createPayout(payout())).toMatchObject({ kind: "rejected", final: false, code: "PROVIDER_AUTH" });
    expect(logs.some((l) => l.fields.alert === "BVNK_AUTH_REFUSED")).toBe(true);
    expect(logText(logs)).not.toContain(cfg.hawkAuthKey);
    expect(logText(logs)).not.toContain(cfg.webhookSecret);
  });
});

describe("BVNK payout status", () => {
  const status = async (answer: unknown, ref: { idempotencyKey: string; providerPayoutId?: string | null } = { idempotencyKey: payout().idempotencyKey }) => {
    const { deps, requests } = fakeDeps(queue(json(200, answer)));
    return { result: await createBvnkAdapter(config(), deps).getPayout(ref), requests };
  };

  it("maps COMPLETE with its hash as settled", async () => {
    const { result, requests } = await status([summary({
      status: "COMPLETE",
      transactions: [{ hash: "0xd915f19f8505bc90199d88a5f04a412b12662d9ca10e14368d24d8b1e142028a", amount: 5, dateConfirmed: "1753353380000" }],
    })]);
    expect(requests[0]!.url.searchParams.get("walletId")).toBe(WALLET);
    expect(result).toMatchObject({ kind: "ok", value: { state: "SUCCEEDED", final: true, txHash: "0xd915f19f8505bc90199d88a5f04a412b12662d9ca10e14368d24d8b1e142028a", occurredAt: new Date(1753353380000) } });
  });

  it("reads by BVNK's id when it is known", async () => {
    const { requests } = await status(summary({ status: "PROCESSING" }), { idempotencyKey: payout().idempotencyKey, providerPayoutId: "96491bf1-5af6-4a42-9d35-6e623a9e3426" });
    expect(requests[0]!.url.pathname).toBe("/api/v1/pay/96491bf1-5af6-4a42-9d35-6e623a9e3426/summary");
  });

  it("reports an unconfirmed payout as not found so the dispatcher resumes it", async () => {
    expect((await status([summary()])).result).toEqual({ kind: "ok", value: null });
  });

  it("never fails a payout on our clock: only BVNK's EXPIRED or CANCELLED is final", async () => {
    const lapsed = await status([summary({ quoteExpiryDate: NOW.getTime() - 1, acceptanceExpiryDate: NOW.getTime() - 1 })]);
    expect(lapsed.result).toMatchObject({ kind: "ok", value: { state: "ACCEPTED", final: false } });
    const expiredQuote = await status([summary({ quoteStatus: "EXPIRED" })]);
    expect(expiredQuote.result).toMatchObject({ kind: "ok", value: { state: "ACCEPTED", final: false } });
    for (const s of ["EXPIRED", "CANCELLED"]) {
      expect((await status([summary({ status: s })])).result).toMatchObject({ kind: "ok", value: { state: "FAILED", final: true, failureCode: s } });
    }
  });

  it("answers null when BVNK has nothing for our key and uncertain for a foreign reference", async () => {
    expect((await status([])).result).toEqual({ kind: "ok", value: null });
    expect((await status(summary({ reference: "wd_other" }), { idempotencyKey: payout().idempotencyKey, providerPayoutId: "96491bf1-5af6-4a42-9d35-6e623a9e3426" })).result)
      .toEqual({ kind: "uncertain", reason: "malformed" });
    expect((await status([summary(), summary({ uuid: "dup" })])).result).toEqual({ kind: "uncertain", reason: "malformed" });
  });
});

describe("BVNK egress relay", () => {
  it("sends to the relay origin with the same path, signed for BVNK's own host", async () => {
    const cfg = config({ env: "production", egress: { mode: "relay", relayUrl: "https://bvnk-relay.example.net" } });
    const { deps, requests } = fakeDeps(queue(json(200, [summary({ status: "PROCESSING" })])));
    await createBvnkAdapter(cfg, deps).getPayout({ idempotencyKey: payout().idempotencyKey });
    expect(requests[0]!.url.origin).toBe("https://bvnk-relay.example.net");
    expect(requests[0]!.url.pathname).toBe("/api/v1/pay/summary");
    await expectHawk(requests[0]!, cfg.hawkAuthKey, "api.bvnk.com");
  });
});

describe("BVNK webhooks", () => {
  // docs.bvnk.com webhook reference, bvnk:payment:channel:transaction-confirmed example (verbatim).
  const CHANNEL_CONFIRMED = '{"event":"bvnk:payment:channel:transaction-confirmed","eventId":"0198a516-3442-7000-8000-000000000000","timestamp":"2025-08-13T20:19:12.578Z","data":{"channelId":"01985b37-ef43-761e-b70c-fddd2cfefffe","merchantId":"a32f9409-1750-49be-bb2a-fc62b18e0fc8","walletId":"a:24072237783989:Unkx9kW:1","merchantDisplayName":"Globex Trading","reference":"user-48213","dateCreated":1755116308000,"lastUpdated":1755116352463,"status":"COMPLETE","uuid":"0198a515-8671-7ad8-bd58-79abec301e89","hash":"0x97b27d27df128f027d2a124b3757c93cd3c1a4934876c0e4a79891c414c1c0b6","address":"0xb330872f2c956dea57b19b72e9b0fc8f26a6a969","tag":null,"paidCurrency":"USDT","displayCurrency":"USD","walletCurrency":"USD","feeCurrency":"USD","paidAmount":10,"displayAmount":9.9,"walletAmount":9.9,"feeAmount":0.05,"exchangeRate":{"base":"USDT","counter":"USD","rate":0.99033},"displayRate":{"base":"USDT","counter":"USD","rate":0.99033},"risk":{"level":"UNKNOWN","resourceName":"UNKNOWN","resourceCategory":"UNKNOWN","alerts":[]},"sources":["0xa7d78498f7010e8ffac098d0b3a208c46896e00d"],"networkFee":{"paidCurrency":"ETH","paidAmount":0.000344635113987594,"displayCurrency":"USD","displayAmount":1.59},"pegged":false,"embeddedCustomerDetails":{"reference":"76af0859-fe63-4cb8-907d-65768d4776d4"}}}';
  // bvnk:payment:crypto:status-change example (second one; dateConfirmed is a string there), reference set to ours.
  const CRYPTO_STATUS = '{"event":"bvnk:payment:crypto:status-change","eventId":"01983c01-6077-7282-a6c8-9b837847ff70","timestamp":"2025-07-24T10:36:19.959993400Z","data":{"flow":null,"type":"OUT","uuid":"3b38d6e1-51b4-4c46-9ce5-1d17ac9f7449","pegged":false,"refund":null,"status":"COMPLETE","address":{"tag":null,"address":"0xa59d9f28537a3a9ee18e76a9fce8261b0ca33723","protocol":"ERC20","alternatives":[]},"refunds":[],"subType":"merchantPayOut","twoStep":false,"metadata":{},"walletId":"a:25100635533496:YxdBv3s:1","reference":"wd_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f","returnUrl":"","customerId":"487548579","expiryDate":1761237313000,"dateCreated":1753353313000,"feeCurrency":{"actual":5.003059,"amount":5.003059,"currency":"USDC"},"quoteStatus":"ACCEPTED","exchangeRate":{"base":"USDC","rate":1,"counter":"USDC"},"paidCurrency":{"actual":5,"amount":5,"currency":"USDC"},"transactions":[{"hash":"0xd915f19f8505bc90199d88a5f04a412b12662d9ca10e14368d24d8b1e142028a","amount":5,"sources":[],"isOnHold":false,"protocol":"ERC20","dateCreated":1753353380000,"dateConfirmed":"1753353380000","networkFeeAmount":0,"networkFeeCurrency":"USDC"}],"walletCurrency":{"actual":5,"amount":5,"currency":"USDC"},"quoteExpiryDate":1761237313000,"acceptanceExpiryDate":1753353343000}}';
  // bvnk:compliance:v1:information-request example.
  const INFO_REQUEST = '{"event":"bvnk:compliance:v1:information-request","eventId":"4d9f2f80-7f4d-11ee-8c99-0242ac120002","timestamp":"2024-10-28T09:25:21.716405Z","data":{"id":"8bd26dc1-e79b-49d0-9cc7-d934c35b81c6","type":"travel-rule","relatedPayment":{"type":"payment:channel-link","id":"0198a515-8671-7ad8-bd58-79abec301e89","reference":"REF558628"},"status":"PENDING_INFO","originator":{"amount":"3500","currency":"USDT","cryptoAddresses":{"network":"ETHEREUM","addresses":["0x46b42c6a9d36b3d428c8f9ffb937682dd3c11a00"]}},"requiredAction":{"type":"PROVIDE_ORIGINATOR_INFORMATION","reason":"Originator entity information missing"}}}';

  it("verifies x-signature (base64 HMAC-SHA256 over the raw body) and maps a channel payment", async () => {
    const cfg = config();
    const adapter = createBvnkAdapter(cfg, fakeDeps(queue()).deps);
    const result = await adapter.verifyWebhook(await signedWebhook(cfg.webhookSecret, CHANNEL_CONFIRMED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme).toBe("bvnk-x-signature-v2-base64");
    const [event] = result.events;
    expect(event).toMatchObject({ providerEventId: "0198a516-3442-7000-8000-000000000000", eventType: "bvnk:payment:channel:transaction-confirmed", objectType: "PAYMENT", objectRef: "0198a515-8671-7ad8-bd58-79abec301e89", merchantRef: null });
    expect("payment" in event! && event.payment).toMatchObject({ state: "NEEDS_REVIEW", reviewReason: "WRONG_ASSET", channelRef: "01985b37-ef43-761e-b70c-fddd2cfefffe", creditMinor: null });
    // Redacted: ids, statuses and amounts only.
    const stored = JSON.stringify(event!.payload);
    for (const absent of ["0xb330872f", "0xa7d78498", "Globex", "embeddedCustomerDetails", "76af0859"]) expect(stored).not.toContain(absent);
    expect(stored).toContain('"walletAmount":"9.9"');
  });

  it("accepts the previous secret while rotating, and nothing else", async () => {
    const previous = randomSecret();
    const adapter = createBvnkAdapter(config({ webhookSecretPrevious: previous }), fakeDeps(queue()).deps);
    expect((await adapter.verifyWebhook(await signedWebhook(previous, CHANNEL_CONFIRMED))).ok).toBe(true);
    expect(await adapter.verifyWebhook(await signedWebhook(randomSecret(), CHANNEL_CONFIRMED))).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses tampered bodies, hex (legacy) signatures, missing signatures and other methods", async () => {
    const cfg = config();
    const adapter = createBvnkAdapter(cfg, fakeDeps(queue()).deps);
    const signed = await signedWebhook(cfg.webhookSecret, CHANNEL_CONFIRMED);
    expect(await adapter.verifyWebhook({ ...signed, rawBody: bytes(CHANNEL_CONFIRMED.replace('"walletAmount":9.9', '"walletAmount":99.9')) })).toEqual({ ok: false, reason: "signature" });
    const hexSig = Array.from(await hmacBytes("SHA-256", cfg.webhookSecret, CHANNEL_CONFIRMED), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await adapter.verifyWebhook({ ...signed, headers: new Headers({ "x-signature": hexSig }) })).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook({ ...signed, headers: new Headers() })).toEqual({ ok: false, reason: "signature" });
    expect(await adapter.verifyWebhook({ ...signed, method: "GET" })).toEqual({ ok: false, reason: "format" });
  });

  it("refuses signed bodies that are not unambiguous JSON envelopes", async () => {
    const cfg = config();
    const adapter = createBvnkAdapter(cfg, fakeDeps(queue()).deps);
    for (const body of ["not json", '{"event":"x","eventId":"1","eventId":"2","data":{}}', '{"event":"x","data":{}}']) {
      expect(await adapter.verifyWebhook(await signedWebhook(cfg.webhookSecret, body)), body).toEqual({ ok: false, reason: "format" });
    }
  });

  it("maps our outgoing crypto payment to a payout hint keyed by our reference", async () => {
    const cfg = config();
    const result = await createBvnkAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(await signedWebhook(cfg.webhookSecret, CRYPTO_STATUS));
    expect(result.ok && result.events[0]).toMatchObject({
      objectType: "PAYOUT", objectRef: "3b38d6e1-51b4-4c46-9ce5-1d17ac9f7449", merchantRef: "wd_0b6b6f1e-6a51-4a39-9a3e-1f2f3c4d5e6f",
      payout: { state: "SUCCEEDED", final: true, txHash: "0xd915f19f8505bc90199d88a5f04a412b12662d9ca10e14368d24d8b1e142028a" },
    });
    const incoming = CRYPTO_STATUS.replace('"type":"OUT"', '"type":"IN"');
    expect(await createBvnkAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(await signedWebhook(cfg.webhookSecret, incoming))).toEqual({ ok: true, scheme: "bvnk-x-signature-v2-base64", events: [] });
  });

  it("turns a travel-rule information request into an information request event", async () => {
    const cfg = config();
    const result = await createBvnkAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(await signedWebhook(cfg.webhookSecret, INFO_REQUEST));
    expect(result.ok && result.events[0]).toMatchObject({ informationRequest: { externalId: "8bd26dc1-e79b-49d0-9cc7-d934c35b81c6", providerPaymentId: "0198a515-8671-7ad8-bd58-79abec301e89" } });
  });

  it("ignores events it does not apply (fiat payouts, ledger reports)", async () => {
    const cfg = config();
    const body = '{"event":"bvnk:payment:payout:status-change","eventId":"e1","timestamp":"2024-10-28T12:25:21.716405000Z","data":{"status":"COMPLETED"}}';
    expect(await createBvnkAdapter(cfg, fakeDeps(queue()).deps).verifyWebhook(await signedWebhook(cfg.webhookSecret, body))).toEqual({ ok: true, scheme: "bvnk-x-signature-v2-base64", events: [] });
  });
});

describe("BVNK travel rule and address checks", () => {
  it("needs the originator's postal address before answering an information request", async () => {
    const { deps, requests } = fakeDeps(queue());
    expect(await createBvnkAdapter(config(), deps).answerInformationRequest!("8bd26dc1-e79b-49d0-9cc7-d934c35b81c6", originator))
      .toMatchObject({ kind: "rejected", final: false, code: "ADDRESS_REQUIRED" });
    expect(requests).toHaveLength(0);
  });

  it("answers with the documented dd-MM-yyyy birth date when an address is present", async () => {
    const { deps, requests } = fakeDeps(queue(json(200, {})));
    const party = { ...originator, address: { addressLine1: "1 Triq il-Kbira", city: "Valletta", postCode: "VLT 1000", country: "MT" } } as TravelRuleParty;
    expect(await createBvnkAdapter(config(), deps).answerInformationRequest!("8bd26dc1-e79b-49d0-9cc7-d934c35b81c6", party)).toEqual({ kind: "ok", value: null });
    expect(requests[0]!.url.pathname).toBe("/compliance/v1/information-requests/8bd26dc1-e79b-49d0-9cc7-d934c35b81c6/actions");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ type: "PROVIDE_INFORMATION", entity: { type: "INDIVIDUAL", firstName: "Jane", dateOfBirth: "02-04-1990", relationshipType: "SELF_OWNED", address: { city: "Valletta" } } });
  });

  it("validates payout addresses with BVNK", async () => {
    const ok = fakeDeps(queue(json(200, {})));
    expect(await createBvnkAdapter(config(), ok.deps).validateAddress!({ asset: "BTC", network: "BITCOIN", address: "bc1q", memo: null })).toEqual({ kind: "ok", value: { valid: true } });
    expect(ok.requests[0]!.method).toBe("PUT");
    expect(JSON.parse(ok.requests[0]!.body)).toEqual({ code: "crypto", currency: "BTC", network: "BITCOIN", address: "bc1q" });
    const bad = fakeDeps(queue(json(400, { errorList: [{ code: "invalidAddress", message: "no" }] })));
    expect(await createBvnkAdapter(config(), bad.deps).validateAddress!({ asset: "BTC", network: "BITCOIN", address: "x", memo: null })).toEqual({ kind: "ok", value: { valid: false, code: "invalidAddress" } });
  });
});
