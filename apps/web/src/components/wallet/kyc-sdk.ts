"use client";

import { documentNonce } from "@/components/turnstile-widget";
import { KYC_SDK_PATH, KYC_SDK_SCRIPT_ORIGIN } from "@/lib/routes";

/**
 * The Sumsub WebSDK (docs.sumsub.com "Get started with WebSDK integration",
 * checked 2026-10-29): the builder script from static.sumsub.com puts the
 * verification flow in an iframe (in.sumsub.com, or the base URL inside the
 * access token) and talks to the page by postMessage. The script is loaded
 * here, on demand, only on /wallet/verify, only after the player pressed
 * "Start verification" and the API answered a Sumsub token; it carries the
 * page's nonce. It is Sumsub's live builder (no versioned URL), so it cannot
 * carry Subresource Integrity: the route-scoped policy is the boundary.
 */
export const SUMSUB_SCRIPT_SRC = `${KYC_SDK_SCRIPT_ORIGIN}/idensic/static/sns-websdk-builder.js`;
const SCRIPT_ID = "sumsub-websdk";

/** The part of the builder API this page uses. */
export interface SnsBuilder {
  withConf(conf: Record<string, unknown>): SnsBuilder;
  withOptions(options: Record<string, unknown>): SnsBuilder;
  on(event: string, handler: (payload: unknown) => void): SnsBuilder;
  onMessage(handler: (type: string, payload: unknown) => void): SnsBuilder;
  build(): { launch(selector: string): void; destroy?: () => void };
}

export interface SnsWebSdk {
  init(accessToken: string, refreshToken: () => Promise<string>): SnsBuilder;
}

declare global {
  interface Window {
    snsWebSdk?: SnsWebSdk;
  }
}

let loading: Promise<SnsWebSdk> | null = null;

export function loadSumsubSdk(): Promise<SnsWebSdk> {
  if (window.snsWebSdk) return Promise.resolve(window.snsWebSdk);
  if (loading) return loading;
  loading = new Promise<SnsWebSdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    const nonce = documentNonce();
    if (nonce) script.nonce = nonce;
    script.src = SUMSUB_SCRIPT_SRC;
    let timer = 0;
    const fail = () => {
      window.clearTimeout(timer);
      loading = null;
      script.remove();
      reject(new Error("The verification service failed to load"));
    };
    timer = window.setTimeout(fail, 20_000);
    script.addEventListener("load", () => {
      window.clearTimeout(timer);
      if (window.snsWebSdk) resolve(window.snsWebSdk); else fail();
    }, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * A document's Content-Security-Policy is fixed when it loads. Only a
 * document loaded at /wallet/verify allows the provider's frame, so a
 * client-side navigation here is turned into a real page load first.
 * True when the page is (about to be) reloaded.
 */
export function reloadUnlessLoadedHere(): boolean {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  let loadedAt: string | null = null;
  try { loadedAt = entry ? new URL(entry.name).pathname.replace(/\/$/, "") : null; } catch { loadedAt = null; }
  if (loadedAt === KYC_SDK_PATH) return false;
  window.location.replace(window.location.href);
  return true;
}

/**
 * SECURITY: while this page is open, a click on any same-origin link leaves
 * with a full page load instead of a client-side navigation, so neither the
 * provider's script nor this page's wider policy carries over to the rest of
 * the app. Returns the cleanup.
 */
export function leaveWithFullPageLoads(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.origin !== window.location.origin) return;
    // An in-page link (the skip link) stays in the page.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    event.preventDefault();
    window.location.assign(url.href);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
