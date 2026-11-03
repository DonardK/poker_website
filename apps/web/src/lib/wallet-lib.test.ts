import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { DepositStatus, QuoteView, WithdrawalDisplayStatus } from "@poker/shared";
import { payoutDestinationAction, stepUpBind, WALLET_ERROR_STATUS, WITHDRAWAL_DISPLAY_STATUS } from "@poker/shared";
import { ApiError } from "./api";
import { compareAmounts, formatMoney, fromMinor, parseAmountInput, toMinor } from "./money";
import { cleanObjectId, depositReturnPath } from "./wallet-ids";
import { safeProviderUrl } from "./wallet-api";
import { BindMismatch, canonicalAddress, checkRequirement, payoutDestinationBind, stepUpRequirementOf, withdrawalBind } from "./wallet-bind";
import { addressFormatProblem, depositStatus, groupedAddress, shortAddress, walletErrorMessage, withdrawalStatus } from "./wallet-copy";

const apiError = (status: number, code?: string, details: Record<string, unknown> = {}, retryAfterMs?: number) =>
  new ApiError("server text", status, retryAfterMs, false, code, undefined, details);

describe("money: decimal strings, never floats", () => {
  it("formats amounts with the euro sign for EUR and the code for anything else", () => {
    assert.equal(formatMoney("1234.50", "EUR"), "€1,234.50");
    assert.equal(formatMoney("12.34", "TEST_EUR"), "12.34 TEST_EUR");
    assert.equal(formatMoney("5", "EUR"), "€5.00");
    assert.equal(formatMoney("0.10", "EUR", { signed: true }), "+€0.10");
    assert.equal(formatMoney("-0.05", "TEST_EUR", { signed: true }), "−0.05 TEST_EUR");
    assert.equal(formatMoney("-0.00", "EUR"), "€0.00");
    // Beyond Number.MAX_SAFE_INTEGER cents: still exact.
    assert.equal(formatMoney("12345678901234567.89", "TEST_EUR"), "12,345,678,901,234,567.89 TEST_EUR");
  });

  it("shows a dash for anything that is not a decimal string", () => {
    for (const bad of ["abc", "1e5", "12.3.4", "", " ", null, undefined, 12.5 as unknown as string]) {
      assert.equal(formatMoney(bad, "EUR"), "—", String(bad));
    }
  });

  it("converts to and from minor units exactly", () => {
    assert.equal(toMinor("0.1")! + toMinor("0.2")!, 30n);
    assert.equal(toMinor("-20.05"), -2005n);
    assert.equal(toMinor("1.234"), null);
    assert.equal(toMinor("x"), null);
    assert.equal(fromMinor(5n), "0.05");
    assert.equal(fromMinor(-123456n), "-1234.56");
    assert.equal(fromMinor(toMinor("99999999999999999.99")!), "99999999999999999.99");
    assert.equal(compareAmounts("10.00", "9.99"), 1);
    assert.equal(compareAmounts("0", "0.00"), 0);
    assert.equal(compareAmounts("1", "nope"), null);
  });

  it("reads what a player types as the request amount, or says what is wrong", () => {
    const ok = (raw: string) => { const r = parseAmountInput(raw); assert.ok(r.ok, raw); return r.amount; };
    assert.equal(ok("20"), "20.00");
    assert.equal(ok(" 20.5 "), "20.50");
    assert.equal(ok("20,5"), "20.50");
    assert.equal(ok("007.10"), "7.10");
    for (const [raw, error] of [
      ["", "Enter an amount."],
      ["12.345", "Use at most 2 decimal places."],
      ["0", "Enter an amount above zero."],
      ["0.00", "Enter an amount above zero."],
      ["99999999999999999", "That amount is too large."],
    ] as const) {
      assert.deepEqual(parseAmountInput(raw), { ok: false, error }, raw);
    }
    // No grouping, signs, currency symbols or exponents.
    for (const raw of ["1,000", "1.000,50", "-5", "+5", "€20", "20 EUR", "1e3", "0x10", "Infinity", "NaN"]) {
      assert.equal(parseAmountInput(raw).ok, false, raw);
    }
  });
});

describe("step-up binding: what the player sees is what the grant authorises", () => {
  const quote: QuoteView = {
    id: "q1", asset: "TEST_EUR", amount: "50.00", fee: "0.00", youReceive: "50.00", receiveAsset: "TEST_EUR",
    receiveEstimate: null, rate: null, expiresAt: "2026-10-29T12:00:00.000Z",
  };

  it("binds a withdrawal to the canonical action the payments Worker hashes", async () => {
    const bind = await withdrawalBind({ userId: "u1", instrumentId: "i1", quote });
    // The edge suite's vector (apps/edge/test/payments/state.unit.test.ts).
    const text = '{"amountMinor":"5000","asset":"TEST_EUR","feeMinor":"0","instrumentId":"i1","purpose":"withdrawal","quoteId":"q1","userId":"u1","v":1}';
    assert.equal(bind, createHash("sha256").update(text).digest("hex"));
    assert.notEqual(await withdrawalBind({ userId: "u1", instrumentId: "i1", quote: { ...quote, amount: "50.01" } }), bind);
    assert.notEqual(await withdrawalBind({ userId: "u1", instrumentId: "i2", quote }), bind);
    await assert.rejects(withdrawalBind({ userId: "u1", instrumentId: "i1", quote: { ...quote, fee: "0.001" } }), BindMismatch);
  });

  it("binds a payout address in the form the Worker stores (EVM and bech32 in lower case)", async () => {
    assert.equal(canonicalAddress("ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    assert.equal(canonicalAddress("bitcoin", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.equal(canonicalAddress("bitcoin", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    assert.equal(canonicalAddress("tron", "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"), "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7");
    const shown = await payoutDestinationBind({ userId: "u1", asset: "ETH", network: "ethereum", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", memo: null });
    const stored = await stepUpBind(payoutDestinationAction({ userId: "u1", asset: "ETH", addressNormalized: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", memo: null }));
    assert.equal(shown, stored);
  });

  it("refuses a requirement for another purpose or another action", () => {
    const requirement = { purpose: "withdrawal" as const, bind: "a".repeat(64), methods: ["TOTP" as const] };
    assert.equal(checkRequirement(requirement, { purpose: "withdrawal", bind: "a".repeat(64) }), requirement);
    assert.throws(() => checkRequirement(requirement, { purpose: "withdrawal", bind: "b".repeat(64) }), BindMismatch);
    assert.throws(() => checkRequirement(requirement, { purpose: "payout_destination", bind: "a".repeat(64) }), BindMismatch);
  });

  it("reads a 403 STEP_UP_REQUIRED body and nothing else", () => {
    const bind = "c".repeat(64);
    assert.deepEqual(stepUpRequirementOf(apiError(403, "STEP_UP_REQUIRED", { purpose: "withdrawal", bind, methods: ["PASSKEY", "SMS", "TOTP"] })),
      { purpose: "withdrawal", bind, methods: ["PASSKEY", "TOTP"] });
    assert.equal(stepUpRequirementOf(apiError(401, "STEP_UP_REQUIRED", { purpose: "withdrawal", bind })), null);
    assert.equal(stepUpRequirementOf(apiError(403, "REAUTH_REQUIRED", { purpose: "withdrawal", bind })), null);
    assert.equal(stepUpRequirementOf(apiError(403, "STEP_UP_REQUIRED", { purpose: "login", bind })), null);
    assert.equal(stepUpRequirementOf(apiError(403, "STEP_UP_REQUIRED", { purpose: "withdrawal", bind: "C".repeat(64) })), null);
    assert.equal(stepUpRequirementOf(new Error("x")), null);
  });
});

describe("wallet copy", () => {
  const GENERIC = "That didn't work. Try again.";
  // Admin-only codes have their own screens; TOKEN_INVALID is the "This wasn't me" page's.
  const NOT_PLAYER = new Set(["ADMIN_ACCESS_REQUIRED", "SELF_APPROVAL", "ALREADY_APPROVED", "TOKEN_INVALID"]);

  it("every player-facing wallet error code reads as its own plain message", () => {
    for (const [code, status] of Object.entries(WALLET_ERROR_STATUS)) {
      if (NOT_PLAYER.has(code)) continue;
      const message = walletErrorMessage(apiError(status, code));
      assert.notEqual(message, GENERIC, code);
      assert.ok(!message.includes("server text"), code);
    }
  });

  it("fills in the amounts and times an error carries", () => {
    assert.equal(walletErrorMessage(apiError(422, "DEPOSIT_LIMIT_EXCEEDED", { details: { remaining: "15.00" } }), { asset: "TEST_EUR" }),
      "That's over your deposit limit. You can deposit up to 15.00 TEST_EUR more right now.");
    assert.equal(walletErrorMessage(apiError(422, "AMOUNT_BELOW_MIN", { details: { min: "10.00" } })), "The minimum is €10.00.");
    assert.equal(walletErrorMessage(apiError(422, "AMOUNT_ABOVE_MAX", { details: { max: "5000.00" } })), "The maximum is €5,000.00.");
    assert.match(walletErrorMessage(apiError(403, "SECURITY_HOLD", { until: "2026-11-01T10:00:00.000Z" })), /paused until .+ after a recent change/);
    assert.match(walletErrorMessage(apiError(409, "DESTINATION_COOLING_OFF", { details: { usableAfter: "2026-11-01T10:00:00.000Z" } })), /can be used from /);
    assert.match(walletErrorMessage(apiError(422, "CARD_PAYOUT_LIMIT", { details: { max: "30.00" } }), { asset: "EUR" }), /This card can receive up to €30\.00: what it deposited, less what it has already received\. Withdraw the rest to a payout address\./);
    assert.match(walletErrorMessage(apiError(422, "CARD_PAYOUT_LIMIT")), /Withdraw the rest to a payout address\./);
    assert.equal(walletErrorMessage(apiError(422, "ADDRESS_INVALID"), { network: "bitcoin" }), "That doesn't look like a valid Bitcoin address. Check it and try again.");
    assert.equal(walletErrorMessage(apiError(429, "RATE_LIMITED", {}, 4_200)), "Too many requests. Try again in 5 s.");
    assert.equal(walletErrorMessage(apiError(502)), "Payments are unavailable right now. Try again in a few minutes.");
    assert.equal(walletErrorMessage(new ApiError("You're offline.", 0)), "You're offline.");
    assert.equal(walletErrorMessage(new Error("boom")), "Something went wrong. Try again.");
    // An over-long detail is not echoed.
    assert.equal(walletErrorMessage(apiError(422, "DEPOSIT_LIMIT_EXCEEDED", { details: { remaining: "1".repeat(300) } })), "That's over your deposit limit.");
  });

  it("names every deposit and withdrawal status", () => {
    const deposits: DepositStatus[] = ["CREATED", "PENDING", "CONFIRMED", "CREDITED", "NEEDS_REVIEW", "FAILED", "EXPIRED", "CANCELLED", "PARTIALLY_REVERSED", "REVERSED"];
    for (const status of deposits) assert.notEqual(depositStatus(status).label, "In progress", status);
    for (const display of new Set(Object.values(WITHDRAWAL_DISPLAY_STATUS)) as Set<WithdrawalDisplayStatus>) {
      assert.notEqual(withdrawalStatus(display).label, "In progress", display);
    }
    assert.equal(withdrawalStatus(WITHDRAWAL_DISPLAY_STATUS.UNDER_REVIEW).label, "Pending review");
  });

  it("helps the player compare an address", () => {
    assert.equal(groupedAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "bc1q w508 d6qe jxtd g4y5 r3za rvar y0c5 xw7k v8f3 t4");
    assert.equal(shortAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), "0x5aAeb6…1BeAed");
    assert.equal(addressFormatProblem("ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), null);
    assert.match(addressFormatProblem("ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Be") ?? "", /doesn't look like a Ethereum/);
    assert.match(addressFormatProblem("bitcoin", "bc1q w508") ?? "", /no spaces/);
    assert.equal(addressFormatProblem("bitcoin", "  "), "Enter the address.");
  });
});

describe("untrusted URLs and ids", () => {
  it("only sends the browser to an https provider page (no window: no http either)", () => {
    assert.equal(safeProviderUrl("https://pay.example/checkout?id=1"), "https://pay.example/checkout?id=1");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/wallet", "//evil.example", "http://pay.example", "ftp://x", 42, null, `https://x.example/${"a".repeat(4100)}`]) {
      assert.equal(safeProviderUrl(bad), null, String(bad).slice(0, 40));
    }
  });

  it("takes a deposit id from a query string only when it is short and URL-safe", () => {
    assert.equal(cleanObjectId("dep_1-AbC"), "dep_1-AbC");
    for (const bad of ["", "../x", "a b", "a".repeat(65), "<script>", null, undefined]) assert.equal(cleanObjectId(bad), null, String(bad));
    assert.equal(depositReturnPath("dep-1"), "/wallet/deposit/return?deposit=dep-1");
  });
});
