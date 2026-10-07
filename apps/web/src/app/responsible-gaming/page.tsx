import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, LegalDocument, Placeholder, type LegalSection } from "@/components/legal-document";
import { PLAY_CHIPS_NOTICE } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Responsible Gaming · Hold'em Live",
  description: "Responsible gaming at Hold'em Live: staying in control, the limits and exclusion tools, and where to get help.",
};

/**
 * COMPLIANCE NOTE: the deposit/loss/session limits, reality checks, time-out
 * and self-exclusion listed here are the real-money controls of decision R8.
 * They are labelled "available with real-money play" because the play-chip
 * service has no deposits; this page must not claim a tool is live before the
 * server enforces it.
 */
const REAL_MONEY = "Available with real-money play.";

const sections: LegalSection[] = [
  {
    id: "approach",
    heading: "Our approach",
    body: (
      <>
        <p>
          Poker should be entertainment. Hold&apos;em Live is for adults only (18+). {PLAY_CHIPS_NOTICE} Even without money at
          stake, playing can take more time or attention than you intended, and play-chip poker can be a step towards gambling
          for money. We want you to stay in control.
        </p>
        <p>We do not offer credit, we never encourage you to chase losses, and we do not send marketing to people who have excluded themselves.</p>
      </>
    ),
  },
  {
    id: "today",
    heading: "What you can do today",
    body: (
      <Bullets items={[
        "Sit out or leave a table at any time. Between hands, leaving returns your chips immediately; during a hand, they return as soon as it ends.",
        "Tables close automatically after 5 minutes without activity, so a forgotten tab does not keep you in the game.",
        "Take breaks. Set yourself a time limit before you sit down and stop when you reach it.",
        <>Ask us to close your account at any time (<Placeholder>support e-mail address</Placeholder>).</>,
      ]} />
    ),
  },
  {
    id: "tools",
    heading: "Limits and exclusion tools",
    body: (
      <>
        <p>When real-money play launches, every account will have these tools, enforced by our servers:</p>
        <Bullets items={[
          <><strong>Deposit limits</strong> (daily, weekly, monthly). {REAL_MONEY}</>,
          <><strong>Loss limits</strong> (daily, weekly, monthly). {REAL_MONEY}</>,
          <><strong>Session-time limits</strong> that end your session when reached. {REAL_MONEY}</>,
          <><strong>Reality checks:</strong> a reminder of how long you have been playing and your result, at an interval you choose (default every 60 minutes). {REAL_MONEY}</>,
          <><strong>Time-out:</strong> a break from play for 24 hours, 7 days, 30 days or 6 weeks. {REAL_MONEY}</>,
          <><strong>Self-exclusion:</strong> for 6 months, 1 year, 5 years or permanently, applied to you as a verified person, so new accounts are blocked too. {REAL_MONEY}</>,
        ]} />
        <p>Lowering a limit will take effect immediately. Raising or removing a limit will take effect only after a 24-hour cooling-off period. A time-out or self-exclusion cannot be cancelled early.</p>
      </>
    ),
  },
  {
    id: "signs",
    heading: "Warning signs",
    body: (
      <>
        <p>Consider taking a break or seeking help if you:</p>
        <Bullets items={[
          "play for longer than you planned, or find it hard to stop;",
          "play to escape problems, stress or low mood;",
          "feel irritable or restless when you are not playing;",
          "hide how much you play from people close to you;",
          "neglect work, study, sleep or family because of playing;",
          "chase losses, or think about gambling for money to win back what you lost.",
        ]} />
      </>
    ),
  },
  {
    id: "help",
    heading: "Where to get help",
    body: (
      <>
        <p>Free, confidential support is available. Helpline details are being confirmed for each country we serve:</p>
        <Bullets items={[
          <>Malta: <Placeholder>national responsible gambling helpline name, phone number and website</Placeholder></>,
          <>International: <Placeholder>Gamblers Anonymous contact details</Placeholder></>,
          <>Your country: <Placeholder>local helpline for each served jurisdiction</Placeholder></>,
          <>Blocking software for gambling sites: <Placeholder>recommended tools</Placeholder></>,
        ]} />
      </>
    ),
  },
  {
    id: "minors",
    heading: "Protecting minors",
    body: (
      <p>
        Nobody under 18 may play. Every account confirms its holder is 18 or older, and we close accounts we believe belong to
        minors. If children use your device, sign out after playing and consider parental-control software. See also our{" "}
        <Link className="underline" href="/terms">Terms of Service</Link>.
      </p>
    ),
  },
];

export default function ResponsibleGamingPage() {
  return (
    <LegalDocument
      title="Responsible Gaming"
      summary={<p>How to keep poker fun: what you can do today, the limits and exclusion tools that come with real-money play, warning signs and where to get help.</p>}
      sections={sections}
    />
  );
}
