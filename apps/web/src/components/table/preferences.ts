"use client";

/**
 * Per-device table preferences. Storage is best-effort: reading or writing
 * localStorage throws in some private modes and when site data is blocked,
 * and a preference must never break the table. The value chosen in this tab
 * is kept in memory so a toggle still works where it cannot be remembered.
 */
const memory = new Map<string, boolean>();

export const FOCUS_ACTIONS_KEY = "poker-focus-actions-on-turn";

export function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Storage blocked: use this tab's choice.
  }
  return memory.get(key) ?? fallback;
}

export function writeBooleanPreference(key: string, value: boolean): void {
  memory.set(key, value);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Kept for this tab only.
  }
}
