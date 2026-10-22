"use client";

import { useEffect, useState } from "react";
import type { AuthClientConfig } from "@poker/shared";
import { fetchAuthConfig } from "@/lib/auth-api";

/**
 * GET /api/auth/config, once per page load: which account features this
 * deployment offers (passkeys, TOTP, email). Null while loading or when the
 * API does not answer; features then fail closed (the passkey button is
 * hidden, for example), and every route is still enforced by the API.
 */
let cached: AuthClientConfig | null = null;
let pending: Promise<AuthClientConfig | null> | null = null;

function loadConfig(): Promise<AuthClientConfig | null> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetchAuthConfig()
      .then((config) => { cached = config; return config; })
      .catch(() => null)
      .finally(() => { pending = null; });
  }
  return pending;
}

export function useAuthConfig(): AuthClientConfig | null {
  const [config, setConfig] = useState<AuthClientConfig | null>(cached);
  useEffect(() => {
    if (cached) { setConfig(cached); return; }
    let live = true;
    void loadConfig().then((value) => { if (live) setConfig(value); });
    return () => { live = false; };
  }, []);
  return config;
}
