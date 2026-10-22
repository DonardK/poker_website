"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Explicit Turnstile render. The API script is not the implicit `.cf-turnstile`
 * mode. Pre-clearance is off: no `cf_clearance` flow and no `/cdn-cgi/` fetch.
 *
 * CSP is nonce + strict-dynamic. The root layout renders the API script with
 * the request nonce on /login and /signup only (routes.ts). Elsewhere (the
 * /reset-password request form, or arriving by a client-side navigation),
 * the loader below adds the script itself (a script created by an already
 * trusted script is allowed by 'strict-dynamic'). `https://challenges.cloudflare.com`
 * stays in script-src, frame-src and connect-src for every page, because a
 * document's CSP does not change on client-side navigation.
 *
 * A token is single use. `resetKey` (bumped by the form after every submit
 * that did not navigate away) resets the widget, so a retry never resends a
 * spent token (finding G1); until a fresh token arrives `onToken(null)` keeps
 * the form's submit disabled (G2).
 */
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SCRIPT_ID = "cf-turnstile-api";

/** The siteverify action names the API checks (one per form). */
export type TurnstileAction = "login" | "signup" | "forgot";

type TurnstileRenderParams = {
  sitekey: string;
  action?: string;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
  appearance?: "always" | "execute" | "interaction-only";
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

/** True while a configured widget has not produced a token yet: the form waits ("Checking your browser…"). */
export function needsTurnstileToken(token: string | null): boolean {
  return Boolean(turnstileSiteKey()) && !token;
}

/** True when this document holds the Turnstile script (rendered by the layout or loaded by a widget). */
export function turnstileScriptLoaded(): boolean {
  return typeof document !== "undefined" && (document.getElementById(TURNSTILE_SCRIPT_ID) !== null || window.turnstile !== undefined);
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

export function TurnstileWidget({ onToken, action, resetKey = 0 }: {
  onToken: (token: string | null) => void;
  action: TurnstileAction;
  /** Change it to discard the current token and get a fresh one. */
  resetKey?: number;
}) {
  const siteKey = turnstileSiteKey();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef("");
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    const container = containerRef.current;
    if (!container) return;
    let removed = false;

    const reset = () => {
      onTokenRef.current(null);
      if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
    };

    loadTurnstileScript()
      .then(() => {
        if (removed || !container.isConnected || !window.turnstile) return;
        setFailed(false);
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          action,
          theme: "dark",
          size: "flexible",
          appearance: "interaction-only",
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => reset(),
          "expired-callback": () => reset(),
        });
      })
      .catch(() => {
        if (removed) return;
        onTokenRef.current(null);
        setFailed(true);
      });

    return () => {
      removed = true;
      if (widgetIdRef.current) window.turnstile?.remove(widgetIdRef.current);
      widgetIdRef.current = "";
    };
  }, [siteKey, action]);

  // A spent token is never resent: drop it and ask the widget for a new one.
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    onTokenRef.current(null);
    if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return (
    <div>
      <div ref={containerRef} />
      {failed ? (
        <p className="mt-2 text-sm text-red-100">The browser check didn&apos;t load. Reload the page to try again.</p>
      ) : null}
    </div>
  );
}
