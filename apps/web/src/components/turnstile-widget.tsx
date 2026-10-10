"use client";

import { useEffect, useRef } from "react";

/**
 * Explicit Turnstile render. The API script is not the implicit `.cf-turnstile`
 * mode. Pre-clearance is off: no `cf_clearance` flow and no `/cdn-cgi/` fetch.
 *
 * CSP is nonce + strict-dynamic. The root layout renders the API script with
 * the request nonce: browsers clear a nonce from the DOM, so a client-created
 * script cannot copy it. `https://challenges.cloudflare.com` stays in
 * script-src, frame-src, and connect-src.
 */
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SCRIPT_ID = "cf-turnstile-api";

type TurnstileRenderParams = {
  sitekey: string;
  callback?: (token: string) => void;
  "error-callback"?: (errorCode?: string) => void;
  "expired-callback"?: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, params: TurnstileRenderParams) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Site key inlined at build. Blank means the widget is not configured. */
export function turnstileSiteKey(): string {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
}

/**
 * Unset site key (local `next dev` without Turnstile): omit the field so the
 * request sends no token. A configured key always sends `turnstileToken`.
 */
export function turnstileTokenField(token: string | null): { turnstileToken: string } | Record<string, never> {
  if (!turnstileSiteKey()) return {};
  return { turnstileToken: token ?? "" };
}

function documentNonce(): string | undefined {
  for (const script of document.scripts) {
    if (script.nonce) return script.nonce;
  }
  return undefined;
}

let turnstileScript: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScript) return turnstileScript;
  turnstileScript = new Promise((resolve, reject) => {
    const finish = () => {
      if (window.turnstile) resolve();
      else reject(new Error("Turnstile failed to load"));
    };
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (existing instanceof HTMLScriptElement) {
      // The layout tag may have finished loading before this listener
      // existed. Poll until the global appears; the load event covers the
      // case where it has not started yet.
      let settled = false;
      const succeed = () => {
        if (settled || !window.turnstile) return;
        settled = true;
        window.clearInterval(timer);
        resolve();
      };
      const timer = window.setInterval(succeed, 50);
      existing.addEventListener("load", succeed, { once: true });
      existing.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        turnstileScript = null;
        reject(new Error("Turnstile failed to load"));
      }, { once: true });
      window.setTimeout(() => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        turnstileScript = null;
        reject(new Error("Turnstile failed to load"));
      }, 10_000);
      succeed();
      return;
    }
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.async = true;
    script.defer = true;
    const nonce = documentNonce();
    if (nonce) script.nonce = nonce;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => {
      turnstileScript = null;
      script.remove();
      reject(new Error("Turnstile failed to load"));
    }, { once: true });
    document.head.appendChild(script);
  });
  return turnstileScript;
}

export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const siteKey = turnstileSiteKey();
  const containerRef = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey) return;
    const container = containerRef.current;
    if (!container) return;
    let removed = false;
    let widgetId = "";

    const reset = () => {
      onTokenRef.current(null);
      if (widgetId) window.turnstile?.reset(widgetId);
    };

    loadTurnstileScript()
      .then(() => {
        if (removed || !container.isConnected || !window.turnstile) return;
        widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => reset(),
          "expired-callback": () => reset(),
        });
      })
      .catch(() => {
        if (!removed) onTokenRef.current(null);
      });

    return () => {
      removed = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={containerRef} />;
}
