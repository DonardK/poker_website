/**
 * Payment notifications through the durable EmailOutbox (INTEGRATION.md
 * override 10; docs/money/WALLET.md section 15.4). enqueueEmail runs in the
 * transaction of the money change it reports (dedupeKey makes it once per
 * event); the PayoutDispatcher drains the outbox through apps/edge/src/mail
 * (Resend, the same transport as account email). The address is read at send
 * time and only a verified one gets mail. A row carries the settlement asset
 * of the Worker that wrote it, and only that Worker sends it.
 */
import type { MailConfig } from "../env";
import type { PrismaClient } from "../generated/prisma/client";
import { errBrief, logWarn } from "../http/log";
import { deliverOrCollect, type MailMessage } from "../mail/transport";
import type { MoneyTx } from "../money/tx";
import type { PaymentsActiveConfig } from "./config";
import { renderPaymentEmail, type EmailPayload, type PaymentTemplate } from "./emails";
import type { PaymentsEnv } from "./env";

export async function enqueueEmail(tx: MoneyTx, scope: string, input: { userId: string; template: PaymentTemplate; payload: EmailPayload; dedupeKey: string }): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO public."EmailOutbox" ("userId", "template", "scope", "payload", "dedupeKey")
    VALUES (${input.userId}, ${input.template}, ${scope}, ${JSON.stringify(input.payload)}::jsonb, ${input.dedupeKey.slice(0, 200)})
    ON CONFLICT ("dedupeKey") DO NOTHING`;
}

const MAILBOX = /^(?:[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,253}|[^<>\r\n]{1,64} <[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,253}>)$/;

/** The payments Worker's own copy of the mail settings (RESEND_API_KEY and MAIL_FROM go together). */
export function paymentsMailConfig(env: PaymentsEnv): MailConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (apiKey && apiKey.length >= 16 && from && MAILBOX.test(from)) {
    return { transport: "resend", apiKey, from, replyTo: env.MAIL_REPLY_TO?.trim() || null };
  }
  return { transport: "sink", exposeLinks: false };
}

interface ClaimedEmail {
  id: string;
  userId: string;
  template: string;
  payload: EmailPayload;
  attempts: number;
}

const MAX_ATTEMPTS = 8;
const LEASE_MS = 120_000;

/**
 * Sends up to `limit` due emails. Claimed rows are SENDING with a lease, so a
 * crashed drain is retried after the lease; Resend's Idempotency-Key
 * (email-outbox:<id>) makes the retry harmless. Returns how many were handled.
 */
export async function drainOutbox(db: PrismaClient, env: PaymentsEnv, config: PaymentsActiveConfig, now: Date, limit = 3): Promise<number> {
  const at = now.toISOString();
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const claimed = await db.$queryRaw<ClaimedEmail[]>`
    UPDATE public."EmailOutbox" SET "status" = 'SENDING', "leaseUntil" = ${lease}::timestamp, "attempts" = "attempts" + 1
     WHERE "id" IN (SELECT "id" FROM public."EmailOutbox"
                     WHERE "scope" = ${config.settlementAsset}
                       AND (("status" = 'PENDING' AND "nextAttemptAt" <= ${at}::timestamp)
                            OR ("status" = 'SENDING' AND "leaseUntil" < ${at}::timestamp))
                     ORDER BY "nextAttemptAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING "id"::text AS id, "userId", "template", "payload", "attempts"`;
  if (claimed.length === 0) return 0;
  const mail = paymentsMailConfig(env);
  for (const row of claimed) {
    let status: "SENT" | "PENDING" | "FAILED" | "CANCELLED" = "PENDING";
    let lastError: string | null = null;
    try {
      const user = await db.user.findUnique({ where: { id: row.userId }, select: { username: true, email: true, emailVerifiedAt: true } });
      const rendered = user ? renderPaymentEmail(row.template, row.payload ?? {}, { username: user.username, siteOrigin: config.publicSiteOrigin }) : null;
      if (!user || !user.email || user.emailVerifiedAt === null) {
        status = "CANCELLED";
        lastError = "NO_VERIFIED_EMAIL";
      } else if (!rendered) {
        status = "CANCELLED";
        lastError = "UNKNOWN_TEMPLATE";
      } else {
        const message: MailMessage = { kind: "PAYMENT_NOTICE", to: user.email, userId: row.userId, ...rendered, idempotencyKey: `email-outbox:${row.id}` };
        const result = await deliverOrCollect(env, mail, message);
        if (result.ok) status = "SENT";
        else if (mail.transport === "sink") {
          status = "CANCELLED";
          lastError = "MAIL_DISABLED";
        } else {
          status = row.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
          lastError = "DELIVERY_FAILED";
        }
      }
    } catch (error) {
      status = row.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
      lastError = errBrief(error).errName.slice(0, 100);
    }
    const retryAt = new Date(now.getTime() + Math.min(2 ** row.attempts, 60) * 60_000).toISOString();
    try {
      await db.$executeRaw`
        UPDATE public."EmailOutbox"
           SET "status" = ${status}::"EmailOutboxStatus", "lastError" = ${lastError},
               "sentAt" = CASE WHEN ${status} = 'SENT' THEN ${at}::timestamp ELSE NULL END,
               "leaseUntil" = NULL,
               "nextAttemptAt" = CASE WHEN ${status} = 'PENDING' THEN ${retryAt}::timestamp ELSE "nextAttemptAt" END
         WHERE "id" = ${row.id}::uuid AND "status" = 'SENDING'`;
    } catch (error) {
      logWarn({ ...errBrief(error), outboxId: row.id }, "email outbox row could not be updated; the lease will retry it");
    }
  }
  return claimed.length;
}
