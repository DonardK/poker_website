import { RECENT_ACCOUNTS_MAX } from "@poker/shared";

/**
 * Accounts this device remembers for quick re-login ("Switch account").
 *
 * PRIVACY / SECURITY: only the username, avatar colour and last-use time are
 * stored, and only after a sign-in with "Stay signed in" ticked. Never an
 * email address, user id, password or token: a remembered entry lets someone
 * prefill a username, nothing more. Every read and write is wrapped because
 * storage throws in some private modes and when site data is blocked.
 */
export interface RememberedAccount {
  username: string;
  avatarHue: number;
  lastUsedAt: number;
}

export const REMEMBERED_ACCOUNTS_KEY = "poker-remembered-accounts";
export const MAX_REMEMBERED = RECENT_ACCOUNTS_MAX;

const DAY_MS = 86_400_000;
const USERNAME = /^[A-Za-z0-9_.-]{1,32}$/;
const listeners = new Set<() => void>();

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The storage to use, or null where there is none (server render, blocked site data). Replaceable in unit tests. */
let storageProvider = (): StorageLike | null => (typeof window === "undefined" ? null : window.localStorage);

export function setRememberedAccountsStorage(provider: () => StorageLike | null): void {
  storageProvider = provider;
}

function valid(row: unknown, now: number): row is RememberedAccount {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.username === "string" && USERNAME.test(r.username) &&
    typeof r.avatarHue === "number" && Number.isInteger(r.avatarHue) && r.avatarHue >= 0 && r.avatarHue <= 359 &&
    typeof r.lastUsedAt === "number" && Number.isFinite(r.lastUsedAt) && r.lastUsedAt >= 0 && r.lastUsedAt <= now + DAY_MS;
}

/** Newest first; invalid rows are dropped; at most MAX_REMEMBERED. Never throws. */
export function readRememberedAccounts(now = Date.now()): RememberedAccount[] {
  let raw: string | null = null;
  try {
    raw = storageProvider()?.getItem(REMEMBERED_ACCOUNTS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; accounts?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.accounts)) return [];
    const seen = new Set<string>();
    const rows: RememberedAccount[] = [];
    for (const row of parsed.accounts) {
      if (!valid(row, now)) continue;
      const key = row.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Copy the three fields only: nothing else stored there is ever used.
      rows.push({ username: row.username, avatarHue: row.avatarHue, lastUsedAt: row.lastUsedAt });
    }
    return rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_REMEMBERED);
  } catch {
    return [];
  }
}

function write(accounts: RememberedAccount[]): void {
  try {
    const storage = storageProvider();
    if (!storage) return;
    if (accounts.length === 0) storage.removeItem(REMEMBERED_ACCOUNTS_KEY);
    else storage.setItem(REMEMBERED_ACCOUNTS_KEY, JSON.stringify({ v: 1, accounts }));
  } catch {
    /* not remembered on this device */
  }
  for (const listener of listeners) listener();
}

function clampHue(hue: number): number {
  return Number.isInteger(hue) && hue >= 0 && hue <= 359 ? hue : 0;
}

/** Remember (or move to the front) an account after a sign-in with "Stay signed in". */
export function rememberAccount(user: { username: string; avatarHue: number }, now = Date.now()): void {
  if (!USERNAME.test(user.username)) return;
  const key = user.username.toLowerCase();
  const rest = readRememberedAccounts(now).filter((row) => row.username.toLowerCase() !== key);
  write([{ username: user.username, avatarHue: clampHue(user.avatarHue), lastUsedAt: now }, ...rest].slice(0, MAX_REMEMBERED));
}

/** Update lastUsedAt only if the account is already remembered (a refresh never adds one). */
export function touchRememberedAccount(user: { username: string; avatarHue: number }, now = Date.now()): void {
  const rows = readRememberedAccounts(now);
  const key = user.username.toLowerCase();
  const index = rows.findIndex((row) => row.username.toLowerCase() === key);
  if (index < 0) return;
  rows[index] = { username: rows[index]!.username, avatarHue: clampHue(user.avatarHue), lastUsedAt: now };
  write(rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt));
}

export function forgetAccount(username: string): void {
  const key = username.toLowerCase();
  write(readRememberedAccounts().filter((row) => row.username.toLowerCase() !== key));
}

export function forgetAllAccounts(): void {
  write([]);
}

/** Changes from this tab (listeners) and from other tabs (the storage event). Returns the unsubscribe function. */
export function subscribeRememberedAccounts(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === REMEMBERED_ACCOUNTS_KEY) callback();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
