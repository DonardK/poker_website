import type { EdgeConfig } from "../env";
import { issueEmailToken, type EmailTokenPurpose, type IssuedEmailToken } from "../auth/email-tokens";
import type { AppDb } from "../http/db";
import { defer } from "../http/defer";
import type { Ctx } from "../http/guard";
import { logWarn } from "../http/log";
import { notice, type NoticeDetails, type Rendered } from "./templates";
import { mailer, type MailKind, type MailMessage } from "./transport";

/**
 * Email links and security notices.
 *
 * Links open a web page with the token in the fragment (#t=<token>); the page
 * POSTs it to the API. The pages are fixed here so the web app and the API
 * agree in one place.
 *
 * Every credential or second-factor change sends a notice to a verified
 * address with a one-click "This wasn't me" link (a SECURITY_LOCKDOWN token
 * whose data names the change and its instant). An unverified address gets
 * no notice: it might belong to someone else.
 */

export const EMAIL_LINK_PAGES: Readonly<Record<EmailTokenPurpose, string>> = {
  VERIFY_EMAIL: "/verify-email",
  EMAIL_CHANGE: "/email-change",
  PASSWORD_RESET: "/reset-password",
  SECURITY_LOCKDOWN: "/auth/not-me",
};

export function emailLink(config: EdgeConfig, purpose: EmailTokenPurpose, token: string): string {
  return `${config.clientOrigin}${EMAIL_LINK_PAGES[purpose]}#t=${token}`;
}

/** A message for a freshly issued token. */
export function linkMail(kind: MailKind, to: string, userId: string, issued: IssuedEmailToken, link: string, rendered: Rendered): MailMessage {
  return { kind, to, userId, ...rendered, idempotencyKey: `${kind}:${issued.id}`, devSecret: link };
}

export interface NoticeUser {
  id: string;
  username: string;
  email: string | null;
  emailVerifiedAt: Date | string | null;
  credentialsVersion: number;
}

/**
 * Issue the lockdown token for a notice and build the message. Call it with
 * the transaction client of the change, using the same `now` the change
 * wrote: lockdown undoes what happened at or after that instant. Null when
 * the address is not verified or the account reached the daily notice cap.
 */
export async function prepareNotice(
  db: AppDb,
  config: EdgeConfig,
  user: NoticeUser,
  kind: MailKind,
  input: { now: Date; data?: Record<string, unknown>; details?: Partial<NoticeDetails>; to?: string | null },
): Promise<MailMessage | null> {
  const to = input.to === undefined ? user.email : input.to;
  if (!to || user.emailVerifiedAt == null) return null;
  const issued = await issueEmailToken(db, {
    userId: user.id,
    purpose: "SECURITY_LOCKDOWN",
    email: to,
    credentialsVersion: user.credentialsVersion,
    data: { kind, incidentAt: input.now.toISOString(), ...input.data },
    now: input.now,
  });
  if (!issued) {
    logWarn({ security: "NOTICE_CAP_REACHED", userId: user.id, kind }, "security notice skipped: daily notice cap reached");
    return null;
  }
  const link = emailLink(config, "SECURITY_LOCKDOWN", issued.token);
  const rendered = notice(kind, { username: user.username, lockdownLink: link, ...input.details });
  return linkMail(kind, to, user.id, issued, link, rendered);
}

/** Send after the response. Pass every message the request prepared; nulls are skipped. */
export async function sendMail(c: Ctx, ...messages: (MailMessage | null | undefined)[]): Promise<void> {
  const config = c.get("config")!;
  for (const message of messages) {
    if (message) await defer(c, mailer.send(c.env, config, message));
  }
}
