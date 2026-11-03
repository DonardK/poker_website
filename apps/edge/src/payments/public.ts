/**
 * poker-payments' public HTTP surface (docs/money/WALLET.md section 11.3),
 * on its own workers.dev host. Nothing here acts for a player:
 * - POST /webhooks/:providerKey: provider notifications (inbox.ts);
 * - GET /health: liveness, mode and role isolation (no secrets);
 * - GET|POST /sandbox/pay/:paymentId and /sandbox/kyc/:token: the built-in
 *   sandbox provider's pages, only with PAYMENTS_MODE=sandbox outside
 *   production. Their buttons change the sandbox provider's own state, then
 *   deliver a signed webhook through the same ingest path a real provider
 *   uses (verification, inbox, dedupe, re-read, processing).
 * Everything else is 404.
 */
import { errBrief, logError, logWarn } from "../http/log";
import { PaymentsConfigError, type PaymentsActiveConfig, type PaymentsConfig } from "./config";
import { readRoleIsolation, withPaymentsDb } from "./db";
import type { PaymentsEnv } from "./env";
import { ingestWebhook } from "./inbox";
import {
  applySandboxKyc,
  applySandboxOutcome,
  CARD_OUTCOMES,
  CRYPTO_OUTCOMES,
  SANDBOX_SIGNATURE_HEADER,
  sandboxKycToken,
  sandboxLinkValid,
  signSandboxBody,
  type CardOutcome,
  type CryptoOutcome,
  type SandboxEnvelope,
  type SandboxOptions,
  type SandboxPaymentRecord,
} from "./providers/sandbox";
import { sandboxStoreFor } from "./providers/registry";
import { openRuntime, paymentsConfig } from "./runtime";

const PROVIDER_KEY = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
});

const notFound = () => json(404, { error: "Not found" });

function sourceIp(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  return value && value.length <= 64 ? value : null;
}

export interface PublicDeps {
  waitUntil(work: Promise<unknown>): void;
}

export async function handlePublic(request: Request, env: PaymentsEnv, deps: PublicDeps): Promise<Response> {
  const url = new URL(request.url);
  let config: PaymentsConfig;
  try {
    config = paymentsConfig(env);
  } catch (error) {
    if (error instanceof PaymentsConfigError) logError({ alert: "PAYMENTS_CONFIG", problems: error.problems.join("; ").slice(0, 500) }, "payments configuration refused");
    else logError({ ...errBrief(error) }, "payments configuration unreadable");
    return url.pathname === "/health" ? json(500, { ok: false, mode: "invalid", roleIsolation: false }) : json(503, { error: "Unavailable" }, { "retry-after": "60" });
  }
  if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) return health(env, config);
  const webhook = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
  if (webhook) {
    const key = decodeURIComponent(webhook[1]!);
    if (config.mode === "off" || !PROVIDER_KEY.test(key)) return notFound();
    return webhookRoute(env, config, deps, key, request);
  }
  if (url.pathname.startsWith("/sandbox/")) {
    if (config.mode !== "sandbox" || config.environment === "production") return notFound();
    return sandboxRoute(env, config, deps, request, url);
  }
  return notFound();
}

async function health(env: PaymentsEnv, config: PaymentsConfig): Promise<Response> {
  let roleIsolation = false;
  if (env.HYPERDRIVE_PAYMENTS) {
    try {
      roleIsolation = (await withPaymentsDb(env, (db) => readRoleIsolation(db))).ok;
    } catch (error) {
      logWarn({ ...errBrief(error) }, "payments health could not reach the database");
    }
  }
  const ok = config.mode === "off" || roleIsolation;
  return json(ok ? 200 : 503, { ok, mode: config.mode, settlementAsset: config.settlementAsset, roleIsolation });
}

async function webhookRoute(env: PaymentsEnv, config: PaymentsActiveConfig, deps: PublicDeps, key: string, request: Request): Promise<Response> {
  let runtime;
  try {
    runtime = await openRuntime(env, config);
  } catch (error) {
    logWarn({ provider: key, ...errBrief(error) }, "webhook could not open the payments database; answered 503");
    return json(503, { error: "Unavailable" }, { "retry-after": "30" });
  }
  try {
    return await ingestWebhook(runtime.ctx, { ...(env.RL_WEBHOOK ? { rateLimit: env.RL_WEBHOOK } : {}), sourceIp: sourceIp(request) }, key, request);
  } finally {
    deps.waitUntil(runtime.close());
  }
}

// ---------------------------------------------------------------------------
// Sandbox pages
// ---------------------------------------------------------------------------

/** form-action also names the site: Chromium applies it to the 303 that takes the player back after the form post. */
const pageHeaders = (siteOrigin: string) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(siteOrigin).origin}; frame-ancestors 'none'; base-uri 'none'`,
});

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function renderPage(siteOrigin: string, title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
.banner{background:#fde68a;border:1px solid #d97706;padding:.5rem .75rem;border-radius:.5rem;font-weight:600}
button{display:block;width:100%;margin:.4rem 0;padding:.6rem;font-size:1rem;border-radius:.5rem;border:1px solid #888;background:#f3f4f6;cursor:pointer}
label{display:block;margin:.4rem 0}input{width:100%;padding:.4rem;font-size:1rem}</style></head>
<body><p class="banner">SANDBOX: test payments only, no real money</p>${body}</body></html>`, { status, headers: pageHeaders(siteOrigin) });
}

const OUTCOME_LABEL: Readonly<Record<CardOutcome | CryptoOutcome, string>> = {
  approve: "Approve (debit card)", approve_credit: "Approve (credit card)", approve_prepaid: "Approve (prepaid card: refused and refunded)",
  decline: "Decline", abandon: "Abandon", chargeback: "Chargeback (after approval)", refund: "Provider refund (after approval)",
  confirm: "Confirm the payment", underpay: "Underpay by half", overpay: "Overpay by half", expire: "Let it expire", reorg: "Chain reorganisation (after confirmation)",
};

/** Same-origin form posts only (the page has no session; the signed link is the authority). */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function formField(request: Request, name: string): Promise<string | null> {
  const text = (await request.text()).slice(0, 4096);
  const value = new URLSearchParams(text).get(name);
  return value && value.length <= 200 ? value : null;
}

async function deliver(env: PaymentsEnv, config: PaymentsActiveConfig, deps: PublicDeps, providerKey: string, secret: string, envelope: SandboxEnvelope, origin: string): Promise<boolean> {
  const body = JSON.stringify(envelope);
  const request = new Request(`${origin}/webhooks/${providerKey}`, {
    method: "POST", body, headers: { "content-type": "application/json", [SANDBOX_SIGNATURE_HEADER]: await signSandboxBody(secret, body, new Date()) },
  });
  const response = await webhookRoute(env, config, deps, providerKey, request);
  if (response.status !== 200) logWarn({ provider: providerKey, status: response.status }, "sandbox webhook was not accepted");
  return response.status === 200;
}

async function sandboxRoute(env: PaymentsEnv, config: PaymentsActiveConfig, deps: PublicDeps, request: Request, url: URL): Promise<Response> {
  const page = (title: string, body: string, status = 200) => renderPage(config.publicSiteOrigin, title, body, status);
  const pay = /^\/sandbox\/pay\/(sbx_pay_[0-9a-f]{24})$/.exec(url.pathname);
  const kyc = /^\/sandbox\/kyc\/([A-Za-z0-9_.-]{1,200})$/.exec(url.pathname);
  if (!pay && !kyc) return notFound();
  if (request.method !== "GET" && request.method !== "POST") return json(405, { error: "Method not allowed" }, { allow: "GET, POST" });
  if (request.method === "POST" && !sameOrigin(request)) return json(403, { error: "Forbidden" });
  const slot = pay ? (config.providers.card.kind === "sandbox" ? config.providers.card : config.providers.crypto) : config.providers.kyc;
  if (slot.kind !== "sandbox" || slot.status !== "ready") return notFound();
  const secret = slot.config.webhookSecret;
  const options: SandboxOptions = { store: sandboxStoreFor(env), webhookSecret: secret, publicOrigin: config.paymentsPublicOrigin, now: () => new Date() };

  if (pay) {
    const paymentId = pay[1]!;
    const sig = url.searchParams.get("sig");
    if (!(await sandboxLinkValid(secret, `pay:${paymentId}`, sig))) return page("Sandbox payment", "<p>This payment link is not valid.</p>", 404);
    const record = await options.store.get<SandboxPaymentRecord>(`pay:${paymentId}`);
    if (!record) return page("Sandbox payment", "<p>Unknown payment.</p>", 404);
    const providerKey = record.method === "CARD" ? "sandbox-card" : "sandbox-crypto";
    if (request.method === "POST") {
      const outcome = await formField(request, "outcome");
      const allowed: readonly string[] = record.method === "CARD" ? CARD_OUTCOMES : CRYPTO_OUTCOMES;
      if (!outcome || !allowed.includes(outcome)) return page("Sandbox payment", "<p>Unknown outcome.</p>", 400);
      const envelope = await applySandboxOutcome(options, paymentId, outcome as CardOutcome | CryptoOutcome);
      if (envelope) await deliver(env, config, deps, providerKey, secret, envelope, url.origin);
      const back = (await options.store.get<string>(`ret:${paymentId}`)) ?? `${config.publicSiteOrigin}/wallet?deposit=${record.depositId}`;
      return new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } });
    }
    const amount = (BigInt(record.amountMinor) / 100n).toString() + "." + (BigInt(record.amountMinor) % 100n).toString().padStart(2, "0");
    const outcomes: readonly (CardOutcome | CryptoOutcome)[] = record.method === "CARD" ? CARD_OUTCOMES : CRYPTO_OUTCOMES;
    const action = `/sandbox/pay/${paymentId}?sig=${encodeURIComponent(sig!)}`;
    const buttons = outcomes.map((o) => `<button name="outcome" value="${o}">${escapeHtml(OUTCOME_LABEL[o])}</button>`).join("");
    const detail = record.method === "CRYPTO" && record.crypto ? `<p>Send to <code>${escapeHtml(record.crypto.address)}</code> (${escapeHtml(record.crypto.asset)}). This address is fake and works nowhere.</p>` : "<p>There is no card form: pick what the bank answers.</p>";
    return page("Sandbox payment", `<h1>Pay ${escapeHtml(amount)} TEST_EUR</h1><p>Status: ${escapeHtml(record.state)}</p>${detail}<form method="post" action="${escapeHtml(action)}">${buttons}</form>`);
  }

  const token = decodeURIComponent(kyc![1]!);
  const applicantRef = await sandboxKycToken(secret, token, new Date());
  if (!applicantRef) return page("Sandbox verification", "<p>This verification link is not valid or has expired. Start again from the wallet.</p>", 404);
  if (request.method === "POST") {
    const text = (await request.text()).slice(0, 4096);
    const form = new URLSearchParams(text);
    const decision = form.get("decision") === "reject" ? "REJECTED" : "VERIFIED";
    const field = (name: string, pattern: RegExp, fallback: string) => {
      const value = form.get(name)?.trim() ?? "";
      return pattern.test(value) ? value : fallback;
    };
    const identity = {
      firstName: field("firstName", /^[\p{L}' -]{1,60}$/u, "Test"), lastName: field("lastName", /^[\p{L}' -]{1,60}$/u, "Player"),
      birthDate: field("birthDate", /^\d{4}-\d{2}-\d{2}$/, "1990-01-01"), country: field("country", /^[A-Z]{2}$/, "MT"),
    };
    const envelope = await applySandboxKyc(options, applicantRef, { decision, identity, screening: form.get("screening") === "match" ? "POTENTIAL_MATCH" : "CLEAR" });
    if (envelope) await deliver(env, config, deps, "sandbox-kyc", secret, envelope, url.origin);
    return new Response(null, { status: 303, headers: { location: `${config.publicSiteOrigin}/wallet/verify/return`, "cache-control": "no-store" } });
  }
  const action = `/sandbox/kyc/${encodeURIComponent(token)}`;
  return page("Sandbox verification", `<h1>Identity verification (sandbox)</h1><p>No document is uploaded. The details below become the verified identity.</p>
<form method="post" action="${escapeHtml(action)}">
<label>First name <input name="firstName" value="Test" maxlength="60"></label>
<label>Last name <input name="lastName" value="Player" maxlength="60"></label>
<label>Date of birth <input name="birthDate" value="1990-01-01" maxlength="10"></label>
<label>Country of residence (2 letters) <input name="country" value="MT" maxlength="2"></label>
<label><input type="checkbox" name="screening" value="match" style="width:auto"> Sanctions or PEP list match</label>
<button name="decision" value="approve">Approve</button><button name="decision" value="reject">Reject</button></form>`);
}
