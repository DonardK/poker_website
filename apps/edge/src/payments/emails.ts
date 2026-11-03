/**
 * Payment emails (docs/money/WALLET.md section 15.4): rendered at send time
 * from an EmailOutbox row (template + payload of strings), in the style of
 * src/mail/templates.ts: plain text plus minimal HTML, every value escaped,
 * no images or tracking. Sandbox (TEST_EUR) emails say so in the subject.
 *
 * destination-added and withdrawal-requested carry a "This wasn't me" link: a
 * token signed by the payments Worker (signNotMe) that opens
 * /auth/not-me#w=<token>; the page posts it to POST /api/wallet/not-me, which
 * freezes withdrawals, removes recently added destinations and the one the
 * email named. It cannot reset a password or sign anyone in, so it is safe to
 * keep in the outbox payload.
 */
import { escapeHtml, type Rendered } from "../mail/templates";
import { b64urlDecode, b64urlEncode, hmacSha256, textEqual } from "../auth/bytes";

const SITE_NAME = "Hold'em Live";

export const PAYMENT_TEMPLATES = [
  "deposit-credited", "refund-held", "withdrawal-requested", "withdrawal-paid", "withdrawal-failed",
  "destination-added", "destination-removed", "chargeback", "security-lockdown",
] as const;
export type PaymentTemplate = (typeof PAYMENT_TEMPLATES)[number];

export type EmailPayload = Record<string, string>;

interface Block {
  text: string;
  link?: { label: string; href: string };
}

function render(subject: string, blocks: Block[], sandbox: boolean): Rendered {
  const fullSubject = `${sandbox ? "[SANDBOX] " : ""}${subject} | ${SITE_NAME}`;
  const all = sandbox ? [{ text: "This is a sandbox notice: test money only, nothing real moved." }, ...blocks] : blocks;
  const text = [...all.map((block) => (block.link ? `${block.text}\n${block.link.href}` : block.text)), "", `— ${SITE_NAME}`].join("\n\n");
  const body = all.map((block) => {
    const paragraph = `<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`;
    if (!block.link) return paragraph;
    const href = escapeHtml(block.link.href);
    return `${paragraph}<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(block.link.label)}</a></p>`
      + `<p style="margin:0 0 16px;font-size:12px;color:#555555">If the button does not work, copy this address into your browser:<br>${href}</p>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111111;background:#ffffff">`
    + `<div style="max-width:560px">${body}<p style="margin:24px 0 0;font-size:12px;color:#555555">${escapeHtml(SITE_NAME)}</p></div></body></html>`;
  return { subject: fullSubject, text, html };
}

const amountText = (payload: EmailPayload, field = "amount") => `${payload[field] ?? "?"} ${payload.asset === "TEST_EUR" ? "test EUR" : "EUR"}`;

const notMeBlock = (payload: EmailPayload, siteOrigin: string, text: string): Block[] => (payload.notMe
  ? [{ text, link: { label: "This wasn't me", href: `${siteOrigin}/auth/not-me#w=${payload.notMe}` } }]
  : []);

/** The rendered email, or null for an unknown template (the row is cancelled). */
export function renderPaymentEmail(template: string, payload: EmailPayload, input: { username: string; siteOrigin: string }): Rendered | null {
  const hi = `Hi ${input.username},`;
  const sandbox = payload.asset === "TEST_EUR";
  switch (template as PaymentTemplate) {
    case "deposit-credited":
      return render("Your deposit arrived", [
        { text: `${hi} your deposit of ${amountText(payload)} is in your wallet.` },
        ...(payload.refundHeld && payload.refundHeld !== "0.00"
          ? [{ text: `${payload.refundHeld} of it is over your deposit limit (or could not be accepted) and is being sent back to where it came from.` }]
          : []),
      ], sandbox);
    case "refund-held":
      return render("Part of your deposit is being returned", [
        { text: `${hi} ${amountText(payload)} of your deposit could not be kept in your wallet (${payload.reason ?? "limit"}) and is being returned to its source.` },
        ...(payload.needsAddress === "true"
          ? [{ text: "We cannot tell which address a crypto payment came from. Add a payout address in your wallet: our team sends the money there after a review." }]
          : []),
      ], sandbox);
    case "withdrawal-requested":
      return render("Withdrawal requested", [
        { text: `${hi} you asked to withdraw ${amountText(payload)} to ${payload.destination ?? "your payout destination"}. We review withdrawals before they are sent.` },
        ...(payload.notMe
          ? notMeBlock(payload, input.siteOrigin, "If this was not you, stop it now: this freezes withdrawals, removes that destination and cancels any withdrawal that has not been sent. Then change your password.")
          : [{ text: "If this was not you, change your password now and contact support." }]),
      ], sandbox);
    case "withdrawal-paid":
      return render("Your withdrawal was sent", [
        { text: `${hi} ${amountText(payload, "youReceive")} was sent to ${payload.destination ?? "your payout destination"}.${payload.txHash ? ` Transaction: ${payload.txHash}` : ""}` },
      ], sandbox);
    case "withdrawal-failed":
      return render("Your withdrawal did not go through", [
        { text: `${hi} your withdrawal of ${amountText(payload)} was not sent (${payload.reason ?? "not completed"}). The money is back in your wallet.` },
      ], sandbox);
    case "destination-added": {
      const card = payload.card === "true";
      const blocks: Block[] = [
        {
          text: card
            ? `${hi} the card ${payload.address ?? "?"} ${payload.restored === "true" ? "was restored to your account by our team" : "paid a deposit and was saved to your account"}. It can receive withdrawals from ${payload.usableAfter ?? "tomorrow"} (UTC).`
            : `${hi} a new payout address was added to your account: ${payload.address ?? "?"} (${payload.asset ?? ""}). It can receive withdrawals from ${payload.usableAfter ?? "tomorrow"} (UTC).`,
        },
        ...notMeBlock(payload, input.siteOrigin, `If you did not add this ${card ? "card" : "address"}, stop it now: this freezes withdrawals, removes it and every payout destination added in the last 72 hours, and cancels pending withdrawals. Then change your password.`),
      ];
      return render(card ? "A card was saved for payouts" : "A payout address was added", blocks, payload.sandbox === "true");
    }
    case "destination-removed":
      return render("A payout destination was removed", [
        { text: `${hi} the payout destination ${payload.display ?? ""} was removed from your account.` },
      ], payload.sandbox === "true");
    case "chargeback":
      return render("A deposit was disputed", [
        { text: `${hi} your bank or card issuer disputed a deposit of ${amountText(payload)}. Withdrawals are paused while we look at it. Contact support if you did not dispute it.` },
      ], sandbox);
    case "security-lockdown":
      return render("Withdrawals are frozen", [
        { text: `${hi} as you asked, withdrawals are frozen, recently added payout addresses were removed and pending withdrawals were cancelled. Change your password and contact support to unfreeze them.` },
      ], payload.sandbox === "true");
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// "This wasn't me" tokens: w1.<payload>.<mac>, HMAC-SHA256 under NOTIFY_LINK_SECRET
// ---------------------------------------------------------------------------

export const NOT_ME_TTL_MS = 7 * 86_400_000;

export interface NotMeClaims {
  /** User id. */
  u: string;
  /** What the email reported: "destination-added" or "withdrawal-requested". */
  k: string;
  /** The subject: the instrument, or the withdrawal. */
  s: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

const encoder = new TextEncoder();

export async function signNotMe(secret: string, claims: NotMeClaims): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const mac = b64urlEncode(await hmacSha256(encoder.encode(secret), `not-me:w1:${body}`));
  return `w1.${body}.${mac}`;
}

/** The claims of a valid, unexpired token, else null. */
export async function verifyNotMe(secret: string, token: unknown, now: Date): Promise<NotMeClaims | null> {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "w1") return null;
  const expected = b64urlEncode(await hmacSha256(encoder.encode(secret), `not-me:w1:${parts[1]}`));
  if (!textEqual(expected, parts[2]!)) return null;
  try {
    const bytes = b64urlDecode(parts[1]!);
    if (!bytes) return null;
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Partial<NotMeClaims>;
    if (typeof claims.u !== "string" || typeof claims.k !== "string" || typeof claims.s !== "string" || typeof claims.e !== "number") return null;
    if (claims.e <= now.getTime()) return null;
    return claims as NotMeClaims;
  } catch {
    return null;
  }
}
