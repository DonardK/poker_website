import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, LegalDocument, Placeholder, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "Game Fairness · Hold'em Live",
  description: "How Hold'em Live shuffles, commits to every deck before dealing, records each hand in a hash chain, and what a player can and cannot verify.",
};

/**
 * COMPLIANCE NOTE: this page must state the limits of the verification as
 * plainly as its strengths. The commitments prove that the deck was fixed
 * before the deal and that the shown cards and actions match the record; they
 * do not prove that the shuffle was random or that the operator did not know
 * the deck. Never describe the system as certified until an accredited
 * laboratory has certified it.
 */
const sections: LegalSection[] = [
  {
    id: "shuffle",
    heading: "How the deck is shuffled",
    body: (
      <Bullets items={[
        "Every random number comes from the server operating system's cryptographically secure random number generator (via Node.js crypto, which uses OpenSSL's NIST SP 800-90A generator seeded by the operating system). There is no seed that anyone can set, replay or choose.",
        "The 52 cards are shuffled with the Fisher–Yates (Durstenfeld) algorithm, which gives every one of the 52! possible orders the same probability.",
        "Random numbers are mapped to card positions by rejection sampling: random values that would make some positions slightly more likely than others (modulo bias) are discarded and redrawn, so there is no bias at all.",
        "The generator is health-checked continuously. If it ever returns an obviously broken output (for example an all-zero block, or the same block twice), no hand can start.",
        "No player, staff member or interface can choose, see or influence the order of a deck before it is used.",
      ]} />
    ),
  },
  {
    id: "commitment",
    heading: "Commitment before the deal",
    body: (
      <>
        <p>Before any blind is posted or any card is dealt, the server fixes the complete deck order and commits to it:</p>
        <Bullets items={[
          "a SHA-256 deck commitment over the hand's unique id, the table, the hand number, all 52 cards in order and a 256-bit secret salt; and",
          "a salted SHA-256 Merkle root over the 52 deck positions, which lets each card be checked on its own without revealing any other card.",
        ]} />
        <p>
          Both commitments are sent to everyone at the table in the first update of the hand, together with your own hole cards
          and before any community card. The salts make the commitments reveal nothing about undealt cards.
        </p>
        <p>
          Every card you are shown (your hole cards, the board, and cards shown at showdown) comes with a Merkle proof. Your
          browser checks each proof against the committed root and checks that the card came from the correct position in the
          deal order (hole cards first, then burn and flop, burn and turn, burn and river). If any check fails, the table shows
          a warning.
        </p>
      </>
    ),
  },
  {
    id: "audit",
    heading: "Hash-chained hand record",
    body: (
      <Bullets items={[
        "Every hand has an audit record. Each event (blinds, deals, actions, timeouts, pots and payouts) is hashed together with the hash of the previous event, so changing, inserting, removing or reordering any event changes every later hash.",
        "The first event of each hand is linked to the final hash of the previous hand at the same table, so hands are chained together too.",
        "Events contain only information that was public when they happened; hidden cards appear only as deck positions. The deck order and salts are kept in a separate, encrypted sealed record for the operator and the regulator.",
        "Hand records are append-only and are stored in the same transaction that settles the hand, so a hand cannot be paid out without its record.",
      ]} />
    ),
  },
  {
    id: "verify",
    heading: "Verify a hand you played",
    body: (
      <>
        <p>
          After a hand you played has finished, the Verify hand button at the table downloads your copy of that hand&apos;s audit
          record and checks it in your browser, with the same verification code the server uses. It checks that:
        </p>
        <Bullets items={[
          "the hash chain is intact from the first event to the final hash;",
          "the board and every card shown at showdown match the pre-deal commitment and their deal positions;",
          "the record is the hand you asked for, at your own seat, and no card appears twice; and",
          "the record matches the commitments and hole cards your browser recorded while the hand was live. Without that live evidence (for example in another browser), the check proves only that the record is internally consistent and that the shown cards match its commitment.",
        ]} />
        <p>The result says exactly what was and was not checked. Chip conservation (blinds, bets, uncalled bets, pots and payouts adding up) is enforced by the server when the hand is settled; a hand whose chips do not add up is refused, not paid.</p>
      </>
    ),
  },
  {
    id: "limits",
    heading: "What this does not prove",
    body: (
      <>
        <p>We want you to understand the limits of these checks:</p>
        <Bullets items={[
          "The server generates and knows every deck. The commitment proves the deck was not changed after it was fixed and that the cards you saw came from it. It does not prove that the shuffle was random, and it does not prove that nobody at the operator looked at the deck. That is ensured by our controls, by the regulator's access to the sealed records and, once completed, by independent certification.",
          "Players never see undealt or mucked cards, so you cannot check the whole deck yourself.",
          "The checks cannot detect collusion between players or use of outside assistance; we monitor for these separately (see the Terms of Service).",
          "The verification code runs in your browser but is served by us. Independent tools can re-implement it from the published record format.",
          <>
            The random number generator and game have not yet been certified by an accredited testing laboratory. Laboratory
            certification is pending (<Placeholder>testing laboratory and certificate reference, once issued</Placeholder>). Nothing
            on this page is a laboratory certification.
          </>,
        ]} />
      </>
    ),
  },
  {
    id: "questions",
    heading: "Questions and disputes",
    body: (
      <p>
        If a check fails or you believe a hand was dealt or settled incorrectly, note the table name and hand number and
        follow the <Link className="underline" href="/complaints">complaints procedure</Link>. The rules applied to every hand
        are in the <Link className="underline" href="/rules">House Rules</Link>.
      </p>
    ),
  },
];

export default function FairnessPage() {
  return (
    <LegalDocument
      title="Game Fairness"
      summary={<p>How every deck is shuffled, committed to before the deal and recorded, how you can verify a hand you played, and the limits of that verification.</p>}
      sections={sections}
    />
  );
}
