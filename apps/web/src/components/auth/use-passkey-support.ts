"use client";

import { useEffect, useState } from "react";
import { useAuthConfig } from "@/lib/auth-config";
import { passkeySupport, type PasskeySupport } from "@/lib/webauthn";

/**
 * Whether passkeys can be offered here: the deployment has them on
 * (GET /api/auth/config) and the browser supports WebAuthn. Null while unknown.
 */
export function usePasskeySupport(): (PasskeySupport & { enabled: boolean }) | null {
  const config = useAuthConfig();
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    let live = true;
    void passkeySupport().then((value) => { if (live) setSupport(value); });
    return () => { live = false; };
  }, []);
  if (!support || !config) return null;
  return { ...support, enabled: config.passkeysEnabled && support.supported };
}
