import type { EdgeConfig, Env, MailConfig } from "../env";
import { logError, logInfo, logWarn } from "../http/log";

/**
 * Outgoing mail. One transport for every sender: account security sends
 * through it with waitUntil, and the payments Worker later drains its durable
 * EmailOutbox through deliverMail() too.
 *
 * - "resend": the Resend REST API, with an Idempotency-Key per message so a
 *   retry never sends twice (Resend keeps keys for 24 h).
 * - "sink" (no RESEND_API_KEY): nothing is delivered. On an http origin the
 *   link or code is logged for local development; on https only the kind.
 * - tests: attachTestMailbox(env, array) collects the messages instead.
 *
 * Logs carry the kind, the user id and the recipient's domain, never the
 * address, a link, a token or a code (except the http sink).
 */

export type MailKind =
  | "VERIFY_EMAIL" | "PASSWORD_RESET" | "EMAIL_CHANGE_CONFIRM" | "EMAIL_CHANGE_NOTICE" | "EMAIL_IN_USE"
  | "NEW_SIGN_IN" | "PASSWORD_CHANGED" | "TOTP_ENABLED" | "TOTP_DISABLED" | "BACKUP_CODES_REGENERATED"
  | "BACKUP_CODE_USED" | "PASSKEY_ADDED" | "PASSKEY_REMOVED" | "STEP_UP_CODE";

export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** "<kind>:<row id>": the same message is never delivered twice. 1-256 characters. */
  idempotencyKey: string;
  userId: string | null;
  /** The link or code, logged only by the sink on an http origin (local development). */
  devSecret?: string;
}

export interface MailResult {
  ok: boolean;
  id?: string;
}

const RESEND_URL = "https://api.resend.com/emails";
const ATTEMPT_TIMEOUT_MS = 5_000;
/** Waits between Resend attempts; tests set them to 0. */
export const resendRetry = { conflictMs: 1_000, rateLimitMs: 1_000, serverMs: [500, 1_500] };

const TEST_MAILBOX = Symbol.for("poker.edge.testMailbox");

/** Tests: collect messages in `mails` instead of sending them. */
export function attachTestMailbox(env: object, mails: MailMessage[]): void {
  Object.defineProperty(env, TEST_MAILBOX, { value: mails, enumerable: false, configurable: true });
}

function testMailbox(env: object): MailMessage[] | null {
  return (env as Record<symbol, MailMessage[] | undefined>)[TEST_MAILBOX] ?? null;
}

function toDomain(address: string): string {
  return (address.split("@")[1] ?? "").slice(0, 253).toLowerCase();
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

async function sendWithResend(mail: Extract<MailConfig, { transport: "resend" }>, msg: MailMessage): Promise<MailResult> {
  const body = JSON.stringify({
    from: mail.from,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    tags: [{ name: "category", value: msg.kind.toLowerCase() }],
  });
  let conflictRetried = false;
  let rateRetried = false;
  let serverRetries = 0;
  for (;;) {
    let status = 0;
    let name = "";
    try {
      const response = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mail.apiKey}`,
          "Content-Type": "application/json",
          // Resend answers 403 without a User-Agent.
          "User-Agent": "poker-edge/1.0",
          "Idempotency-Key": msg.idempotencyKey.slice(0, 256),
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      status = response.status;
      const json = await response.json().catch(() => ({})) as { id?: unknown; name?: unknown };
      if (status === 200) return { ok: true, ...(typeof json.id === "string" ? { id: json.id } : {}) };
      name = typeof json.name === "string" ? json.name.slice(0, 64) : "";
    } catch {
      status = 0; // timeout or network failure: the idempotency key makes a retry safe
    }
    let wait: number | null = null;
    if (status === 409 && name === "concurrent_idempotent_requests" && !conflictRetried) {
      conflictRetried = true;
      wait = resendRetry.conflictMs;
    } else if (status === 429 && name !== "daily_quota_exceeded" && name !== "monthly_quota_exceeded" && !rateRetried) {
      rateRetried = true;
      wait = resendRetry.rateLimitMs;
    } else if ((status === 0 || status >= 500) && serverRetries < resendRetry.serverMs.length) {
      wait = resendRetry.serverMs[serverRetries++] ?? 0;
    }
    if (wait === null) {
      logError({ mail: "FAILED", kind: msg.kind, userId: msg.userId, status, reason: name || null, toDomain: toDomain(msg.to) },
        status === 0 ? "email could not reach Resend" : "Resend refused the email");
      return { ok: false };
    }
    await sleep(wait);
  }
}

/** Deliver one message through the configured transport (no test mailbox: callers outside a request). */
export async function deliverMail(mail: MailConfig, msg: MailMessage): Promise<MailResult> {
  if (mail.transport === "resend") return sendWithResend(mail, msg);
  if (mail.exposeLinks) {
    logInfo({ mail: "SINK", kind: msg.kind, userId: msg.userId, toDomain: toDomain(msg.to), link: msg.devSecret ?? null }, "email not sent (no RESEND_API_KEY); local development link");
  } else {
    logWarn({ mail: "DISABLED", kind: msg.kind, userId: msg.userId, toDomain: toDomain(msg.to) }, "email not sent: RESEND_API_KEY is not set");
  }
  return { ok: false };
}

async function send(env: Env, config: EdgeConfig, msg: MailMessage): Promise<MailResult> {
  const mailbox = testMailbox(env);
  if (mailbox) {
    mailbox.push(msg);
    return { ok: true, id: `test-${mailbox.length}` };
  }
  return deliverMail(config.mail, msg);
}

/** Object so tests can spy without patching the ESM namespace. */
export const mailer = { send };

/**
 * True when a link sent now can never arrive: the sink on an https origin
 * (production without RESEND_API_KEY). The http sink logs links for local
 * development, so it counts as available.
 */
export function mailUnavailable(env: object, config: EdgeConfig): boolean {
  return config.mail.transport === "sink" && !config.mail.exposeLinks && testMailbox(env) === null;
}
