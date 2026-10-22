import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, CounselNote, LegalDocument, Placeholder, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "What personal data Hold'em Live collects, why, how long it is kept and your rights.",
};

/**
 * COMPLIANCE NOTE: section 2 lists the data the code actually stores today
 * (User and Session rows, hand records and audit trail, server logs, the
 * refresh cookie and sessionStorage hand evidence). Keep it in step with the
 * schema; anything collected later (KYC, payments, device ids) must be added
 * here before it is collected.
 */
const sections: LegalSection[] = [
  {
    id: "controller",
    heading: "Who is responsible for your data",
    body: (
      <p>
        The data controller is <Placeholder>Operator name</Placeholder>, registered at <Placeholder>registered address</Placeholder>.
        Data protection contact: <Placeholder>DPO / privacy e-mail address</Placeholder>.
      </p>
    ),
  },
  {
    id: "data",
    heading: "Data we collect",
    body: (
      <>
        <Bullets items={[
          <><strong>Account data:</strong> your username; your e-mail address and whether you have confirmed it; a password hash (PBKDF2-SHA256; we never store or see your password itself); your avatar colour; when the account was created and last seen.</>,
          <><strong>Sign-in methods you add:</strong> for two-step verification, the authenticator secret (encrypted) and keyed hashes of your backup codes; for passkeys, each passkey&apos;s public key, a name and when it was added and last used (the private key never leaves your device).</>,
          <><strong>Consent records:</strong> the terms version you accepted, when you accepted it, and when you confirmed you are 18 or older.</>,
          <><strong>Security data:</strong> failed sign-in counts and temporary lock-outs; for every sign-in session, the IP address and browser user agent it started from, when it was created, last used, expires or was revoked, and why it was revoked; the devices you sign in from (a hash of a random device cookie, the browser and system, a shortened IP address and the country) so that we can alert you to sign-ins from new devices; and a history of security events (sign-ins and changes to how you sign in, with time, shortened IP address and browser), used for alerts, your security page and fraud prevention. New passwords are checked against known data breaches by sending only the first five characters of a hash of the password (k-anonymity), never the password.</>,
          <><strong>Gameplay data:</strong> your play-chip balance and its changes, the tables you sat at, buy-ins and chips returned when you leave a table, every action you take, and the hand history of hands you played, including your hole cards. Each hand has a tamper-evident audit record; the cards that were never shown to players (undealt and mucked cards) are kept only in an encrypted, sealed record for the operator and the regulator.</>,
          <><strong>Server logs:</strong> technical and security logs (requests, errors, sign-in and admin events) that can contain your user id, IP address and timestamps.</>,
          <><strong>Stored on your device:</strong> strictly necessary, HTTP-only cookies for signing in (the session, a hint that a session exists, and a random device identifier for new-device alerts); in your browser&apos;s session storage, verification evidence for hands you are playing (fairness commitments and a digest of your own hole cards), cleared when you sign out; and, only if you tick &ldquo;Stay signed in&rdquo;, the usernames of up to five accounts used on this device (with an avatar colour and the time of last use, never a password or token) so you can switch accounts quickly. You can remove them on the sign-in page.</>,
        ]} />
        <p>We do not use advertising or analytics cookies, and we do not sell personal data.</p>
        <CounselNote>confirm the list is complete before launch and add any data collected by hosting, e-mail or support providers.</CounselNote>
      </>
    ),
  },
  {
    id: "purposes",
    heading: "Why we use it",
    body: (
      <>
        <Bullets items={[
          "To create and run your account and let you play (performance of our contract with you).",
          "To keep accounts secure and detect abuse such as credential stuffing, collusion and multi-accounting (our legitimate interest in a safe, fair game).",
          "To keep a tamper-evident record of every hand so that disputes can be resolved and the game audited (legitimate interest; once licensed, a legal obligation).",
          "To record that you confirmed you are 18 or older and accepted our terms (legal obligation and legitimate interest).",
          "To answer your requests and complaints.",
        ]} />
        <CounselNote>legal bases per purpose to be confirmed in the DPIA; real-money play will add KYC, anti-money-laundering and responsible-gaming processing required by Maltese law.</CounselNote>
      </>
    ),
  },
  {
    id: "visibility",
    heading: "What other players can see",
    body: (
      <p>
        Other players at your table see your username, avatar colour, seat, chip stack and actions, and the cards you show at
        showdown. They never see your cards unless you show them or the rules require them to be shown (see the
        <Link className="underline" href="/rules"> House Rules</Link>).
      </p>
    ),
  },
  {
    id: "sharing",
    heading: "Who we share it with",
    body: (
      <>
        <p>
          Our hosting and database providers process data on our behalf (<Placeholder>provider names and locations</Placeholder>),
          and our e-mail provider (Resend) sends account e-mails such as confirmation links, password resets and security alerts.
          Once real-money play is offered, payment and identity-verification providers will process the data they need for
          that. We disclose data to regulators, law enforcement or courts when the law requires it. Nothing else is shared.
        </p>
        <CounselNote>list processors (including Resend as e-mail processor), international transfers and the safeguards relied on (e.g. adequacy decision or standard contractual clauses).</CounselNote>
      </>
    ),
  },
  {
    id: "retention",
    heading: "How long we keep it",
    body: (
      <>
        <p>
          Session records are kept for <Placeholder>period</Placeholder> after the session ends. Hand records and audit trails are
          append-only and are kept for <Placeholder>period required by the regulator</Placeholder>. Account data is kept while the
          account is open and for <Placeholder>period</Placeholder> afterwards. Server logs are kept for <Placeholder>period</Placeholder>.
        </p>
        <CounselNote>retention periods to be set; audit records may have to outlive account deletion, in which case they are kept but no longer used for anything else.</CounselNote>
      </>
    ),
  },
  {
    id: "rights",
    heading: "Your rights",
    body: (
      <>
        <p>
          Under the GDPR you can ask for access to your data, correction, erasure, restriction, portability, and object to
          processing based on legitimate interests. Some data (for example hand audit records) may have to be kept even after
          an erasure request; we will tell you when that applies.
        </p>
        <p>
          Contact <Placeholder>privacy e-mail address</Placeholder>. You may also complain to the Information and Data Protection
          Commissioner (Malta) or the data protection authority where you live.
        </p>
      </>
    ),
  },
  {
    id: "security",
    heading: "Security",
    body: (
      <p>
        Connections are encrypted (HTTPS), passwords are hashed, sign-in tokens are short-lived and rotated, sessions can be
        revoked, two-step verification and passkeys are offered, sign-ins from new devices are alerted, links in our e-mails
        work once and expire, sealed hand records are encrypted, and staff access to audit records is logged.
      </p>
    ),
  },
  {
    id: "changes",
    heading: "Changes",
    body: <p>We will update this notice before we start collecting new kinds of data, in particular before real-money play (identity verification and payment data) is introduced.</p>,
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Notice"
      summary={<p>This notice explains what personal data we collect when you play, why, who can see it and the rights you have. It is marked for review by our data protection counsel.</p>}
      sections={sections}
    />
  );
}
