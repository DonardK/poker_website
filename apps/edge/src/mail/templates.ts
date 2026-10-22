import type { MailKind } from "./transport";

/**
 * Account email bodies: plain text plus minimal HTML. Every interpolated
 * value is HTML-escaped. No images, no tracking pixels, no external assets.
 * Links carry their token in the URL fragment (#t=...), never the query.
 */

const SITE_NAME = "Hold'em Live";

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

interface Block {
  /** Plain text; escaped for HTML. */
  text: string;
  link?: { label: string; href: string };
}

function render(subject: string, blocks: Block[]): Rendered {
  const text = [...blocks.map((block) => (block.link ? `${block.text}\n${block.link.href}` : block.text)), "", `— ${SITE_NAME}`].join("\n\n");
  const body = blocks.map((block) => {
    const paragraph = `<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`;
    if (!block.link) return paragraph;
    const href = escapeHtml(block.link.href);
    return `${paragraph}<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:10px 18px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(block.link.label)}</a></p>`
      + `<p style="margin:0 0 16px;font-size:12px;color:#555555">If the button does not work, copy this address into your browser:<br>${href}</p>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111111;background:#ffffff">`
    + `<div style="max-width:560px">${body}<p style="margin:24px 0 0;font-size:12px;color:#555555">${escapeHtml(SITE_NAME)}</p></div></body></html>`;
  return { subject: `${subject} | ${SITE_NAME}`, text, html };
}

function notMe(lockdownLink: string | null): Block[] {
  if (!lockdownLink) return [];
  return [{
    text: "If this wasn't you, secure your account now. This signs out every device, removes anything added since, and lets you choose a new password. The link works for 7 days.",
    link: { label: "This wasn't me", href: lockdownLink },
  }];
}

export interface NoticeDetails {
  username: string;
  lockdownLink: string | null;
  /** NEW_SIGN_IN */
  when?: string;
  device?: string | null;
  country?: string | null;
  ip?: string | null;
  /** PASSKEY_ADDED / PASSKEY_REMOVED */
  passkeyName?: string;
  /** BACKUP_CODE_USED */
  remaining?: number;
  /** EMAIL_CHANGE_NOTICE */
  newEmail?: string;
  stage?: "requested" | "changed";
  /** PASSWORD_CHANGED */
  how?: "reset" | "change";
}

export function verifyEmail(input: { username: string; link: string }): Rendered {
  return render("Confirm your email", [
    { text: `Hi ${input.username}, please confirm this is your email address. The link works for 24 hours.`, link: { label: "Confirm email", href: input.link } },
    { text: "If you did not create an account, you can ignore this email." },
  ]);
}

export function passwordReset(input: { username: string; link: string }): Rendered {
  return render("Reset your password", [
    { text: `Hi ${input.username}, use this link to choose a new password. It works once, for 30 minutes. Your username is ${input.username}.`, link: { label: "Choose a new password", href: input.link } },
    { text: "If you did not ask for this, ignore this email: your password stays the same. Two-step verification, if you use it, is still required after a reset." },
  ]);
}

export function emailChangeConfirm(input: { username: string; link: string; newEmail: string }): Rendered {
  return render("Confirm your new email", [
    { text: `Hi ${input.username}, confirm that ${input.newEmail} should become the email address of your account. The link works for 1 hour.`, link: { label: "Confirm new email", href: input.link } },
    { text: "If you did not ask for this, ignore this email and nothing changes." },
  ]);
}

export function emailInUse(): Rendered {
  return render("Someone tried to use your email", [
    { text: "Someone asked to move another account to this email address. It already belongs to an account, so nothing was changed." },
    { text: "If you have forgotten your password, you can reset it from the sign-in page. Otherwise, no action is needed." },
  ]);
}

export function stepUpCode(input: { username: string; code: string; purpose: string; minutes: number }): Rendered {
  return render("Your confirmation code", [
    { text: `Hi ${input.username}, your code to confirm a ${input.purpose} is ${input.code}. It works once, for ${input.minutes} minutes, and only in the browser that asked for it.` },
    { text: "We will never ask for this code by phone, chat or email. If you did not ask for it, change your password." },
  ]);
}

export function notice(kind: MailKind, details: NoticeDetails): Rendered {
  const hi = `Hi ${details.username},`;
  switch (kind) {
    case "NEW_SIGN_IN":
      return render("New sign-in to your account", [
        { text: `${hi} your account was signed in from a new device.` },
        { text: [
          `When: ${details.when ?? "just now"} (UTC)`,
          `Device: ${details.device ?? "unknown"}`,
          `Location: ${details.country ?? "unknown"}`,
          `Network: ${details.ip ?? "unknown"}`,
        ].join("\n") },
        ...notMe(details.lockdownLink),
      ]);
    case "PASSWORD_CHANGED":
      return render("Your password was changed", [
        { text: details.how === "reset"
          ? `${hi} your password was reset with an emailed link, and every device was signed out.`
          : `${hi} your password was changed, and your other devices were signed out.` },
        ...notMe(details.lockdownLink),
      ]);
    case "TOTP_ENABLED":
      return render("Two-step verification is on", [
        { text: `${hi} two-step verification with an authenticator app was turned on. Keep your backup codes somewhere safe.` },
        ...notMe(details.lockdownLink),
      ]);
    case "TOTP_DISABLED":
      return render("Two-step verification was turned off", [
        { text: `${hi} two-step verification was turned off for your account. Withdrawals are paused for a while as a precaution.` },
        ...notMe(details.lockdownLink),
      ]);
    case "BACKUP_CODES_REGENERATED":
      return render("New backup codes were created", [
        { text: `${hi} a new set of backup codes was created. The old codes no longer work.` },
        ...notMe(details.lockdownLink),
      ]);
    case "BACKUP_CODE_USED":
      return render("A backup code was used", [
        { text: `${hi} a backup code was used to sign in. ${details.remaining ?? 0} unused codes are left; you can create a new set in your security settings.` },
        ...notMe(details.lockdownLink),
      ]);
    case "PASSKEY_ADDED":
      return render("A passkey was added", [
        { text: `${hi} a passkey${details.passkeyName ? ` ("${details.passkeyName}")` : ""} was added to your account. It can now be used to sign in.` },
        ...notMe(details.lockdownLink),
      ]);
    case "PASSKEY_REMOVED":
      return render("A passkey was removed", [
        { text: `${hi} a passkey${details.passkeyName ? ` ("${details.passkeyName}")` : ""} was removed from your account.` },
        ...notMe(details.lockdownLink),
      ]);
    case "EMAIL_CHANGE_NOTICE":
      return render(details.stage === "changed" ? "Your email address was changed" : "Your email address is being changed", [
        { text: details.stage === "changed"
          ? `${hi} the email address of your account was changed to ${details.newEmail ?? "a new address"}. This address no longer receives account email.`
          : `${hi} someone asked to change the email address of your account to ${details.newEmail ?? "a new address"}. It changes only if that address is confirmed.` },
        ...notMe(details.lockdownLink),
      ]);
    default:
      return render("Account security notice", [{ text: `${hi} a security setting of your account changed.` }, ...notMe(details.lockdownLink)]);
  }
}
