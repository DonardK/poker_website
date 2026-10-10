/**
 * Unit tests for exact money arithmetic (src/money/amounts.ts). No database.
 * Run: node test/support/run-tests.mjs --import tsx test/money-amounts.test.mjs (from apps/server)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AmountError, BIGINT_MAX, chipsToMinor, formatMinor, jsonSafe, minorToChips, parseChipUnit, parseMinor,
} from "../src/money/amounts.ts";

test("parseMinor converts decimal strings exactly per asset precision", () => {
  assert.equal(parseMinor("12.34", 2), 1234n);
  assert.equal(parseMinor("12.3", 2), 1230n);
  assert.equal(parseMinor("12", 2), 1200n);
  assert.equal(parseMinor("0", 2), 0n);
  assert.equal(parseMinor("0.00000001", 8), 1n); // 1 satoshi
  assert.equal(parseMinor("1.000000001", 9), 1_000_000_001n); // ETH in gwei
  assert.equal(parseMinor("21000000", 8), 2_100_000_000_000_000n);
  assert.equal(parseMinor("10000", 0), 10_000n); // PLAY
  // The float route would lose this (0.1 + 0.2 style errors never apply to strings).
  assert.equal(parseMinor("9007199254740993", 0), 9_007_199_254_740_993n);
  assert.equal(parseMinor("92233720368547758.07", 2), BIGINT_MAX);
});

test("parseMinor rejects excess precision, negatives and garbage", () => {
  for (const [value, decimals] of [
    ["12.345", 2], ["1.230", 2], ["0.000000001", 8], ["1.5", 0],
    ["-1", 2], ["-0.01", 2], ["+1", 2], ["1e3", 0], ["1E3", 0], ["0x10", 0], ["Infinity", 2], ["NaN", 2],
    ["", 2], [" 1", 2], ["1 ", 2], ["1,000", 2], ["1_000", 0], [".5", 2], ["5.", 2], ["01", 2], ["00.1", 2],
    ["1..2", 2], ["١٢", 0],
  ]) {
    assert.throws(() => parseMinor(value, decimals), AmountError, `${JSON.stringify(value)} @${decimals}`);
  }
  assert.throws(() => parseMinor(12, 2), AmountError);
  assert.throws(() => parseMinor("1", 19), AmountError);
  assert.throws(() => parseMinor("1", -1), AmountError);
  assert.throws(() => parseMinor("1", 1.5), AmountError);
});

test("parseMinor refuses values beyond the BIGINT range", () => {
  assert.throws(() => parseMinor("92233720368547758.08", 2), AmountError);
  assert.throws(() => parseMinor("9223372036854775808", 0), AmountError);
  assert.throws(() => parseMinor("9".repeat(70), 0), AmountError);
});

test("formatMinor renders exactly the asset's decimal places", () => {
  assert.equal(formatMinor(1234n, 2), "12.34");
  assert.equal(formatMinor(5n, 2), "0.05");
  assert.equal(formatMinor(-5n, 2), "-0.05");
  assert.equal(formatMinor(0n, 2), "0.00");
  assert.equal(formatMinor(1n, 8), "0.00000001");
  assert.equal(formatMinor(1_000_000_000n, 9), "1.000000000");
  assert.equal(formatMinor(10_000n, 0), "10000");
  assert.equal(formatMinor(-10_000n, 0), "-10000");
  assert.equal(formatMinor(BIGINT_MAX, 2), "92233720368547758.07");
  assert.throws(() => formatMinor(5, 2), AmountError);
  for (const [value, decimals] of [["12.34", 2], ["0.00000001", 8], ["7", 0], ["123456789.123456789", 9]]) {
    assert.equal(formatMinor(parseMinor(value, decimals), decimals), value);
  }
});

test("chipsToMinor multiplies exactly and refuses unsafe or negative chips", () => {
  assert.equal(chipsToMinor(250, 1n), 250n);
  assert.equal(chipsToMinor(250, 10_000n), 2_500_000n);
  assert.equal(chipsToMinor(0, 5n), 0n);
  assert.equal(chipsToMinor(Number.MAX_SAFE_INTEGER, 1000n), 9_007_199_254_740_991_000n);
  assert.throws(() => chipsToMinor(Number.MAX_SAFE_INTEGER + 1, 1n), AmountError);
  assert.throws(() => chipsToMinor(-1, 1n), AmountError);
  assert.throws(() => chipsToMinor(1.5, 1n), AmountError);
  assert.throws(() => chipsToMinor(Number.NaN, 1n), AmountError);
  assert.throws(() => chipsToMinor(1, 0n), AmountError);
  assert.throws(() => chipsToMinor(1, -1n), AmountError);
  assert.throws(() => chipsToMinor(1, 1), AmountError);
  // Product beyond the BIGINT range is refused, never wrapped.
  assert.throws(() => chipsToMinor(Number.MAX_SAFE_INTEGER, 10_000n), AmountError);
});

test("minorToChips divides exactly and refuses remainders", () => {
  assert.equal(minorToChips(2_500_000n, 10_000n), 250);
  assert.equal(minorToChips(0n, 10_000n), 0);
  assert.throws(() => minorToChips(2_500_001n, 10_000n), AmountError);
  assert.throws(() => minorToChips(-10_000n, 10_000n), AmountError);
  assert.throws(() => minorToChips(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1n), AmountError);
  assert.throws(() => minorToChips(100, 1n), AmountError);
  assert.equal(minorToChips(chipsToMinor(123_456, 37n), 37n), 123_456);
});

test("parseChipUnit accepts positive integer strings only", () => {
  assert.equal(parseChipUnit("1"), 1n);
  assert.equal(parseChipUnit("10000"), 10_000n);
  for (const bad of ["0", "-1", "1.5", "", "abc"]) assert.throws(() => parseChipUnit(bad), AmountError, bad);
});

test("jsonSafe converts every bigint so res.json never throws or loses precision", () => {
  const body = { balance: 9_007_199_254_740_993n, list: [1n, { inner: -5n }], text: "x", n: 3, nil: null, when: new Date(0) };
  assert.throws(() => JSON.stringify(body), TypeError);
  const safe = jsonSafe(body);
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), {
    balance: "9007199254740993", list: ["1", { inner: "-5" }], text: "x", n: 3, nil: null, when: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(body.balance, 9_007_199_254_740_993n, "input is not mutated");
});
