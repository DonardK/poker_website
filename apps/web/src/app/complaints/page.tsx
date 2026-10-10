import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, LegalDocument, Placeholder, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "Complaints",
  description: "How to make a complaint to Hold'em Live, how it is handled, and how to escalate it.",
};

const sections: LegalSection[] = [
  {
    id: "how",
    heading: "How to complain",
    body: (
      <>
        <p>
          E-mail <Placeholder>complaints e-mail address</Placeholder>, from the address registered on your account if you have
          one. Please include:
        </p>
        <Bullets items={[
          "your username (guests: the guest name shown in the lobby);",
          "what happened and what outcome you want;",
          "for a hand: the table name, the hand number, the approximate time, and the result of the Verify hand check if you ran it;",
          "any screenshots that help.",
        ]} />
        <p>Never send us your password. We will never ask for it.</p>
      </>
    ),
  },
  {
    id: "handling",
    heading: "How we handle it",
    body: (
      <Bullets items={[
        <>We acknowledge your complaint within <Placeholder>number</Placeholder> working days and give you a reference.</>,
        "A member of staff who was not involved in the matter investigates it. For a hand, this includes the hand's tamper-evident audit record, which shows every card dealt, every action and every chip movement.",
        <>We send you our final response, with our reasons, within <Placeholder>number</Placeholder> days of receiving the complaint. If we need longer, we tell you why and when to expect it.</>,
        "If we find we made a mistake, we correct it (for example by restoring play chips) and tell you what we changed.",
        "We keep a record of every complaint and its outcome.",
      ]} />
    ),
  },
  {
    id: "escalation",
    heading: "If you are not satisfied",
    body: (
      <>
        <p>
          If you are not satisfied with our final response, you can escalate your complaint free of charge to our independent
          alternative dispute resolution (ADR) provider: <Placeholder>ADR entity name and contact details</Placeholder>.
        </p>
        <p>
          Once we hold a Malta Gaming Authority licence, you can also contact the Authority&apos;s player support service
          (<Placeholder>MGA player support contact</Placeholder>). Data protection complaints can go to the Information and Data
          Protection Commissioner (see our <Link className="underline" href="/privacy">Privacy Notice</Link>).
        </p>
      </>
    ),
  },
  {
    id: "related",
    heading: "Related documents",
    body: (
      <p>
        The <Link className="underline" href="/rules">House Rules</Link> decide every hand, and the{" "}
        <Link className="underline" href="/fairness">Game Fairness</Link> page explains how a hand can be verified.
      </p>
    ),
  },
];

export default function ComplaintsPage() {
  return (
    <LegalDocument
      title="Complaints"
      summary={<p>If something went wrong, tell us. This page explains how to complain, how we handle complaints and how to escalate one.</p>}
      sections={sections}
    />
  );
}
