/**
 * Shared provider wire helpers (src/payments/providers/wire.ts) and
 * BVNK's Hawk signer (bvnk/hawk.ts): lossless JSON, exact decimals, the one
 * outbound call (timeout, no redirects, size cap, strict UTF-8), redaction,
 * and the published Hawk test vector.
 */
import { describe, expect, it } from "vitest";
import { hawkAuthorization, hawkNormalized } from "../../../src/payments/providers/bvnk/hawk";
import {
  base64ToBytes,
  decimalToMinor,
  hexToBytes,
  JsonNumber,
  MAX_RESPONSE_BYTES,
  parseJsonLossless,
  plainDecimal,
  randomAlphanumeric,
  redactWith,
  send,
  stringifyJsonLossless,
  uuidFromKey,
} from "../../../src/payments/providers/wire";
import { fakeDeps, queue } from "./fakes";

describe("lossless JSON", () => {
  it("keeps every number as its source text", () => {
    const parsed = parseJsonLossless('{"a":115.69,"b":2110000000017245577,"c":4.5023994813E-5,"d":[1,-0.0],"e":"x"}') as Record<string, unknown>;
    expect(parsed.a).toBeInstanceOf(JsonNumber);
    expect((parsed.a as JsonNumber).text).toBe("115.69");
    expect((parsed.b as JsonNumber).text).toBe("2110000000017245577");
    expect(plainDecimal(parsed.c as JsonNumber)).toBe("0.000045023994813");
    expect((parsed.d as JsonNumber[]).map((n) => n.text)).toEqual(["1", "-0.0"]);
    expect(parsed.e).toBe("x");
  });

  it("refuses ambiguous or non-standard JSON", () => {
    for (const bad of ['{"a":1,"a":2}', '{"a":1,}', "[1,]", "{'a':1}", '{"a":01}', '{"a":1} x', '"\u0001"', "NaN", '{"a":.5}', "// c\n{}"]) {
      expect(() => parseJsonLossless(bad), bad).toThrow(SyntaxError);
    }
    expect(() => parseJsonLossless("[".repeat(70) + "]".repeat(70))).toThrow(/too deep/);
  });

  it("treats __proto__ as an ordinary key", () => {
    const parsed = parseJsonLossless('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("decodes escapes", () => {
    expect(parseJsonLossless('"a\\u00e9\\n\\"\\/"')).toBe('aé\n"/');
  });

  it("writes JsonNumbers bare and refuses floats and bigints", () => {
    expect(stringifyJsonLossless({ amount: new JsonNumber("120.00"), n: 3, skip: undefined, list: [true, null] })).toBe('{"amount":120.00,"n":3,"list":[true,null]}');
    expect(() => stringifyJsonLossless({ amount: 0.1 })).toThrow(TypeError);
    expect(() => stringifyJsonLossless({ amount: 10n })).toThrow(TypeError);
    expect(() => new JsonNumber("1e")).toThrow(SyntaxError);
  });
});

describe("exact decimals", () => {
  it("normalises without a JS number", () => {
    expect(plainDecimal("1E+3")).toBe("1000");
    expect(plainDecimal("115.690")).toBe("115.69");
    expect(plainDecimal("-0.0")).toBe("0");
    expect(plainDecimal("0.000344635113987594")).toBe("0.000344635113987594");
    expect(plainDecimal("1e999")).toBeNull();
    expect(plainDecimal("1.2.3")).toBeNull();
  });

  it("converts to minor units exactly or floored", () => {
    expect(decimalToMinor("100.0000", 2)).toEqual({ minor: 10000n, remainder: null });
    expect(decimalToMinor("115.694", 2)).toBeNull();
    expect(decimalToMinor("115.694", 2, "floor")).toEqual({ minor: 11569n, remainder: "0.004" });
    expect(decimalToMinor(new JsonNumber("12345678901234567.89"), 2)).toEqual({ minor: 1234567890123456789n, remainder: null });
    expect(decimalToMinor("0.1", 2)?.minor).toBe(10n);
    expect(decimalToMinor("-1.00", 2)).toBeNull();
    expect(decimalToMinor("99999999999999999999", 2)).toBeNull();
  });
});

describe("hex and base64", () => {
  it("is strict", () => {
    expect(hexToBytes("0aFf")).toEqual(new Uint8Array([10, 255]));
    expect(hexToBytes("0a f")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
    expect(base64ToBytes("AAE=")).toEqual(new Uint8Array([0, 1]));
    expect(base64ToBytes("AAE")).toBeNull();
    expect(base64ToBytes("AA-_")).toBeNull();
  });
});

describe("Hawk (BVNK request authentication)", () => {
  it("matches the published Hawk test vector", async () => {
    // https://github.com/mozilla/hawk README: GET /resource/1?b=1&a=2 on example.com:8000.
    const header = await hawkAuthorization(
      { id: "dh37fgj492je", key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn" },
      { method: "GET", target: new URL("http://example.com:8000/resource/1?b=1&a=2") },
      1353832234,
      "j4h3g2",
      "some-app-ext-data",
    );
    expect(header).toBe('Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');
  });

  it("builds BVNK's normalized string with empty hash and ext lines", () => {
    expect(hawkNormalized({ ts: "1", nonce: "abc123", method: "post", resource: "/api/v1/pay/summary?x=1", host: "API.SANDBOX.BVNK.COM", port: 443 }))
      .toBe("hawk.1.header\n1\nabc123\nPOST\n/api/v1/pay/summary?x=1\napi.sandbox.bvnk.com\n443\n\n\n");
  });

  it("refuses header-unsafe ids and nonces", async () => {
    await expect(hawkAuthorization({ id: 'a"b', key: "k" }, { method: "GET", target: new URL("https://api.bvnk.com/") }, 1, "abcdef")).rejects.toThrow(TypeError);
    await expect(hawkAuthorization({ id: "a", key: "k" }, { method: "GET", target: new URL("https://api.bvnk.com/") }, 1, "ab cd")).rejects.toThrow(TypeError);
  });
});

describe("keys and randomness", () => {
  it("derives a stable RFC 9562 version-8 UUID per key", async () => {
    const a = await uuidFromKey("ns", "wd_1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await uuidFromKey("ns", "wd_1")).toBe(a);
    expect(await uuidFromKey("ns", "wd_2")).not.toBe(a);
    expect(await uuidFromKey("other", "wd_1")).not.toBe(a);
  });

  it("draws alphanumerics only", () => {
    const value = randomAlphanumeric((n) => crypto.getRandomValues(new Uint8Array(n)), 40);
    expect(value).toMatch(/^[A-Za-z0-9]{40}$/);
  });
});

describe("send", () => {
  it("never follows redirects and passes the timeout", async () => {
    const { deps, requests } = fakeDeps(queue(new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })));
    const result = await send(deps.fetch, { method: "POST", url: "https://api.example/x", headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 1234 });
    expect(result).toEqual({ kind: "response", status: 302, text: "" });
    expect(requests[0]!.redirect).toBe("manual");
    expect(requests[0]!.timeoutMs).toBe(1234);
  });

  it("classifies timeouts and network failures without rethrowing", async () => {
    const timeout = fakeDeps(queue(new DOMException("The operation timed out.", "TimeoutError") as unknown as Error));
    expect(await send(timeout.deps.fetch, { method: "GET", url: "https://api.example/", headers: {} })).toEqual({ kind: "failed", reason: "timeout" });
    const network = fakeDeps(queue(new TypeError("connection reset")));
    expect(await send(network.deps.fetch, { method: "GET", url: "https://api.example/", headers: {} })).toEqual({ kind: "failed", reason: "network" });
  });

  it("refuses oversized and non-UTF-8 bodies as unreadable", async () => {
    const big = fakeDeps(queue(new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), { status: 200 })));
    expect(await send(big.deps.fetch, { method: "GET", url: "https://api.example/", headers: {} })).toEqual({ kind: "response", status: 200, text: null });
    const latin = fakeDeps(queue(new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })));
    expect(await send(latin.deps.fetch, { method: "GET", url: "https://api.example/", headers: {} })).toEqual({ kind: "response", status: 200, text: null });
  });
});

describe("redaction", () => {
  it("keeps only allow-listed keys, clips strings and drops nested strangers", () => {
    const kept = redactWith(new Set(["id", "status", "data", "amount", "list"]), {
      id: "x".repeat(300),
      status: "OK",
      email: "player@example.com",
      data: { amount: new JsonNumber("1.50"), name: "Jane Doe", list: ["a", { id: "inner", secret: "s" }] },
    });
    expect(kept).toEqual({ id: "x".repeat(200), status: "OK", data: { amount: "1.5", list: ["a", { id: "inner" }] } });
  });
});
