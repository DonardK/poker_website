import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, LegalDocument, Placeholder, type LegalSection } from "@/components/legal-document";
import { PLAY_CHIPS_NOTICE, TERMS_VERSION } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that apply to Hold'em Live, a play-chip Texas Hold'em service for adults.",
};

const sections: LegalSection[] = [
  {
    id: "operator",
    heading: "Who we are",
    body: (
      <>
        <p>
          Hold&apos;em Live (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated by <Placeholder>Operator name</Placeholder>{" "}
          (<Placeholder>legal entity and company number</Placeholder>), registered at <Placeholder>registered address</Placeholder>.
          Contact: <Placeholder>support e-mail address</Placeholder>.
        </p>
        <p>
          Today the service offers play-chip poker only. It does not hold a gaming licence because it accepts no stakes of
          value. Real-money play will only be offered after we obtain a licence from the Malta Gaming Authority
          (<Placeholder>MGA licence number, once granted</Placeholder>) and only under separate terms that you will be asked to accept.
        </p>
      </>
    ),
  },
  {
    id: "eligibility",
    heading: "Who may play",
    body: (
      <Bullets items={[
        "You must be at least 18 years old. You confirm this when you create an account; we may ask for proof and close accounts held by minors.",
        "You may only play where online poker, including play-chip poker, is lawful for you. You are responsible for checking the law where you are.",
        "One account per person. Our staff may not play at tables.",
        "You must play for yourself, with your own decisions. Accounts may not be shared, sold or operated by software.",
      ]} />
    ),
  },
  {
    id: "play-chips",
    heading: "Play chips",
    body: (
      <>
        <p className="font-semibold">{PLAY_CHIPS_NOTICE}</p>
        <Bullets items={[
          "Play chips are granted free of charge for entertainment. They cannot be bought, sold, transferred between accounts, exchanged for money, prizes, goods, crypto-assets or any other value, and they are never converted into real-money balances. There is no cash redemption.",
          "Chip amounts are whole numbers. Your balance, buy-ins, bets and winnings are recorded by the server; the server's record is authoritative.",
          "We may adjust a balance to correct an error, or reset play-chip balances for everyone, with notice where practical.",
          "Play tables charge no rake.",
        ]} />
      </>
    ),
  },
  {
    id: "accounts",
    heading: "Accounts and security",
    body: (
      <>
        <p>You need an account to play. An account has a username, an e-mail address and a password. Keep your password secret; you are responsible for activity on your account until you tell us it is compromised.</p>
        <p>
          Protect your account: keep your password, passkeys and backup codes to yourself, and turn on two-step verification
          (a passkey or codes from an authenticator app). We will never ask for your password or codes. Tell us at once if you
          think your account is compromised; use &ldquo;This wasn&apos;t me&rdquo; in a sign-in alert or security e-mail to sign
          out everywhere and choose a new password.
        </p>
        <p>
          If you tick &ldquo;Stay signed in&rdquo;, this device stays signed in for up to 30 days (14 days without use); otherwise
          the session ends when you close the browser, or after 24 hours. Signing out ends the session on this device; you can
          also sign out every other session from Account &amp; security. You can be signed out automatically when a session
          expires or is revoked for security reasons. Changes to how you sign in, and payouts once real money is offered, may
          ask you to confirm it&apos;s you first.
        </p>
      </>
    ),
  },
  {
    id: "games",
    heading: "Games, rules and fairness",
    body: (
      <>
        <p>
          Every game is no-limit Texas Hold&apos;em between human players and follows our <Link className="underline" href="/rules">House Rules</Link>,
          which form part of these terms. How cards are shuffled and how you can verify a hand you played are explained
          on the <Link className="underline" href="/fairness">Game Fairness</Link> page.
        </p>
        <p>If an action is shown on your screen but not accepted by the server (for example because your connection dropped or your turn had already ended), the server&apos;s record decides what happened.</p>
      </>
    ),
  },
  {
    id: "fair-play",
    heading: "Fair play",
    body: (
      <>
        <p>The following are prohibited and can lead to removal of chips, suspension or closure of the account:</p>
        <Bullets items={[
          "Collusion: sharing hole-card information, soft-playing or co-operating with another player at the same table.",
          "Chip dumping: deliberately losing chips to another account.",
          "Using bots, scripts, real-time assistance software or any automation to play.",
          "Holding or operating more than one account, or playing on someone else's account.",
          "Exploiting a bug or fault instead of reporting it, or interfering with the service, other players' connections or our systems.",
          "Abusive, threatening or discriminatory behaviour, and usernames that impersonate staff or others.",
        ]} />
      </>
    ),
  },
  {
    id: "interruptions",
    heading: "Interruptions, idle tables and voided hands",
    body: (
      <Bullets items={[
        "If the service is interrupted during a hand, the hand continues from the last state the server recorded when service resumes. The player to act gets a fresh turn clock and no personal time bank is charged for the outage.",
        "If a hand cannot be recovered, it may be voided: every chip committed to it is returned to the players who committed it, and the hand is recorded as void. Voiding requires the approval of two different authorised staff members.",
        "A table with no player activity for 5 minutes shows a 30-second closing warning to the seated players. If nobody responds, it closes: any hand in progress is completed under the normal sit-out rules and every player's chips are returned to their balance.",
      ]} />
    ),
  },
  {
    id: "suspension",
    heading: "Suspension and closure",
    body: (
      <p>
        You can stop playing at any time and ask us to close your account (see <Link className="underline" href="/complaints">Complaints</Link> for
        how to contact us). We may suspend or close an account that breaches these terms, that we reasonably believe is held
        by a minor, or where the law requires it. Play chips have no value, so closing an account never creates a payment obligation.
      </p>
    ),
  },
  {
    id: "liability",
    heading: "Availability and liability",
    body: (
      <p>
        The play-chip service is provided free of charge and &ldquo;as available&rdquo;. We do not guarantee uninterrupted
        play. <Placeholder>Limitation of liability wording to be drafted by counsel; it must not exclude liability that cannot be excluded under Maltese or EU consumer law.</Placeholder>
      </p>
    ),
  },
  {
    id: "complaints",
    heading: "Complaints",
    body: <p>Our complaint procedure and escalation route are described on the <Link className="underline" href="/complaints">Complaints</Link> page.</p>,
  },
  {
    id: "changes",
    heading: "Changes to these terms",
    body: (
      <p>
        These terms are version {TERMS_VERSION}. When we change them in substance we publish a new version with a new date.
        New accounts must accept the current version; we may ask existing players to accept a new version before they
        continue to play. We record which version you accepted and when.
      </p>
    ),
  },
  {
    id: "law",
    heading: "Governing law",
    body: <p><Placeholder>Governing law and jurisdiction clause (expected: Malta), to be confirmed by counsel, without depriving consumers of the protection of the mandatory law of their country of residence.</Placeholder></p>,
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      summary={<p>These terms govern your use of Hold&apos;em Live. In short: you must be 18 or older, you need an account, which you can secure with two-step verification, you play for play chips with no cash value, and our House Rules decide every hand.</p>}
      sections={sections}
    />
  );
}
