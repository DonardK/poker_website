import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFragmentToken } from "./fragment-token";
import {
  forgetAccount, forgetAllAccounts, MAX_REMEMBERED, readRememberedAccounts, rememberAccount, REMEMBERED_ACCOUNTS_KEY,
  setRememberedAccountsStorage, touchRememberedAccount,
} from "./remembered-accounts";
import { isProtectedPath, isPublicPath, isTurnstilePath } from "./routes";
import { safeNext, safeUsername } from "./safe-next";
import { describeUserAgent } from "./user-agent";
import { passwordRuleProblem } from "./password-strength";

describe("safeNext", () => {
  it("keeps same-origin paths with their query and fragment", () => {
    assert.equal(safeNext("/table/fixture-table"), "/table/fixture-table");
    assert.equal(safeNext("/account/security?tab=1#passkeys"), "/account/security?tab=1#passkeys");
    assert.equal(safeNext("/"), "/");
  });

  it("refuses anything that could leave the site or run script", () => {
    for (const raw of [
      "https://evil.example", "//evil.example", "/\\evil", "/%2F%2Fevil.example", "/%5Cevil", "javascript:alert(1)",
      "evil.example", "/ path", "/\u0000x", "/a\tb", "%E0%A4%A", "/" + "a".repeat(600), "", undefined, 42, null,
    ]) {
      assert.equal(safeNext(raw), "/", String(raw));
    }
  });

  it("never sends a sign-in back to a sign-in or email-link page", () => {
    for (const raw of ["/login", "/login?next=/", "/signup/", "/reset-password", "/verify-email", "/email-change", "/auth/not-me"]) {
      assert.equal(safeNext(raw), "/", raw);
    }
  });

  it("uses the given fallback", () => {
    assert.equal(safeNext("//evil.example", "/welcome"), "/welcome");
  });

  it("accepts only plain usernames for ?as=", () => {
    assert.equal(safeUsername("Player-0"), "Player-0");
    assert.equal(safeUsername("river_rat"), "river_rat");
    assert.equal(safeUsername("<script>"), null);
    assert.equal(safeUsername("a".repeat(33)), null);
    assert.equal(safeUsername(undefined), null);
  });
});

describe("route classes", () => {
  it("is default deny", () => {
    for (const path of ["/", "/table/x", "/account", "/account/security", "/welcome", "/wallet", "/unknown-page"]) {
      assert.equal(isProtectedPath(path), true, path);
    }
  });

  it("leaves the legal, sign-in and email-link pages public", () => {
    for (const path of ["/terms", "/privacy/", "/rules", "/fairness", "/responsible-gaming", "/complaints", "/login", "/signup",
      "/reset-password", "/verify-email", "/email-change", "/auth/not-me", "/robots.txt", "/sitemap.xml", "/.well-known/security.txt"]) {
      assert.equal(isPublicPath(path), true, path);
    }
  });

  it("renders Turnstile only on its three forms", () => {
    assert.equal(isTurnstilePath("/login"), true);
    assert.equal(isTurnstilePath("/signup"), true);
    assert.equal(isTurnstilePath("/reset-password"), true);
    assert.equal(isTurnstilePath("/"), false);
    assert.equal(isTurnstilePath("/table/x"), false);
    assert.equal(isTurnstilePath(null), false);
  });
});

describe("fragment tokens", () => {
  const token = "A".repeat(43);
  it("reads #t= and #token=, then a legacy query", () => {
    assert.equal(parseFragmentToken(`#t=${token}`, ""), token);
    assert.equal(parseFragmentToken(`#token=${token}`, ""), token);
    assert.equal(parseFragmentToken("", `?t=${token}`), token);
  });

  it("refuses malformed tokens", () => {
    assert.equal(parseFragmentToken("#t=short", ""), null);
    assert.equal(parseFragmentToken("#t=<script>alert(1)</script>xxxxxxxxxx", ""), null);
    assert.equal(parseFragmentToken("", ""), null);
  });
});

describe("remembered accounts", () => {
  function memoryStorage(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get length() { return data.size; },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => { data.delete(key); },
      setItem: (key, value) => { data.set(key, String(value)); },
    };
  }

  it("stores only the username, colour and last use, newest first, at most five", () => {
    const storage = memoryStorage();
    setRememberedAccountsStorage(() => storage);
    for (let n = 0; n < 7; n++) rememberAccount({ username: `Player_${n}`, avatarHue: n * 10 }, 1_000 + n);
    const accounts = readRememberedAccounts(10_000);
    assert.equal(accounts.length, MAX_REMEMBERED);
    assert.deepEqual(accounts.map((a) => a.username), ["Player_6", "Player_5", "Player_4", "Player_3", "Player_2"]);
    const stored = JSON.parse(storage.data.get(REMEMBERED_ACCOUNTS_KEY)!) as { v: number; accounts: Record<string, unknown>[] };
    assert.equal(stored.v, 1);
    for (const row of stored.accounts) assert.deepEqual(Object.keys(row).sort(), ["avatarHue", "lastUsedAt", "username"]);
  });

  it("dedupes case-insensitively, touches only known accounts and forgets", () => {
    const storage = memoryStorage();
    setRememberedAccountsStorage(() => storage);
    rememberAccount({ username: "River_Rat", avatarHue: 5 }, 100);
    rememberAccount({ username: "river_rat", avatarHue: 6 }, 200);
    assert.equal(readRememberedAccounts(1_000).length, 1);
    touchRememberedAccount({ username: "Somebody", avatarHue: 1 }, 300);
    assert.equal(readRememberedAccounts(1_000).length, 1);
    touchRememberedAccount({ username: "RIVER_RAT", avatarHue: 7 }, 400);
    assert.equal(readRememberedAccounts(1_000)[0]!.lastUsedAt, 400);
    forgetAccount("river_rat");
    assert.deepEqual(readRememberedAccounts(1_000), []);
    rememberAccount({ username: "A_b", avatarHue: 1 }, 1);
    forgetAllAccounts();
    assert.equal(storage.data.has(REMEMBERED_ACCOUNTS_KEY), false);
  });

  it("drops invalid rows and never throws when storage does", () => {
    const storage = memoryStorage();
    setRememberedAccountsStorage(() => storage);
    storage.setItem(REMEMBERED_ACCOUNTS_KEY, JSON.stringify({ v: 1, accounts: [
      { username: "<img src=x>", avatarHue: 1, lastUsedAt: 1 }, { username: "ok_name", avatarHue: 999, lastUsedAt: 1 },
      { username: "good_name", avatarHue: 10, lastUsedAt: 5, email: "leak@example.test" },
    ] }));
    assert.deepEqual(readRememberedAccounts(1_000), [{ username: "good_name", avatarHue: 10, lastUsedAt: 5 }]);
    storage.setItem(REMEMBERED_ACCOUNTS_KEY, "not json");
    assert.deepEqual(readRememberedAccounts(), []);
    setRememberedAccountsStorage(() => { throw new Error("blocked"); });
    assert.deepEqual(readRememberedAccounts(), []);
    assert.doesNotThrow(() => rememberAccount({ username: "x_y", avatarHue: 1 }));
    setRememberedAccountsStorage(() => null);
  });
});

describe("user agents", () => {
  it("names the browser and system", () => {
    assert.equal(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome on Windows");
    assert.equal(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge on Windows");
    assert.equal(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
    assert.equal(describeUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
    assert.equal(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on macOS");
    assert.equal(describeUserAgent(null), "Unknown device");
  });
});

describe("password rules", () => {
  it("mirrors the server: 12 characters to 72 bytes, not the username", () => {
    assert.match(passwordRuleProblem("short-pass1")!, /12 characters/);
    assert.equal(passwordRuleProblem("a-long-enough-password"), null);
    assert.match(passwordRuleProblem("é".repeat(37))!, /72 bytes/);
    assert.match(passwordRuleProblem("river_rat-and-more", "River_Rat")!, /username/);
  });
});
