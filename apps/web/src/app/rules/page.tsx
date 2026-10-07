import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, LegalDocument, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "House Rules · Hold'em Live",
  description: "The no-limit Texas Hold'em rules Hold'em Live applies: blinds, button, betting, showdown, pots, time bank, sitting out and table closure.",
};

/**
 * COMPLIANCE NOTE: these rules describe what the engine does
 * (packages/engine/src/table.ts, legal.ts, pots.ts) and the adopted house-rule
 * decisions (time bank D4, sit-out after a timeout D1, idle closure D3,
 * showdown order D2, voided hands D12). A rule change in the engine must be
 * reflected here, and this page must never promise behaviour the engine does
 * not implement.
 */
const sections: LegalSection[] = [
  {
    id: "game",
    heading: "The game",
    body: (
      <>
        <p>
          All tables play no-limit Texas Hold&apos;em between human players, 2 to 9 seats, with fixed small and big blinds and no
          antes. Chips are whole numbers. Each player receives two private hole cards; five community cards are dealt face up
          in three rounds (the flop of three cards, the turn and the river). A card is burned (dealt face down and never used)
          before the flop, the turn and the river.
        </p>
        <p>
          The best five-card hand made from a player&apos;s two hole cards and the five community cards wins, using standard
          hand rankings (royal flush highest, then straight flush, four of a kind, full house, flush, straight, three of a kind,
          two pair, one pair, high card). An ace plays high or low in a straight (A-2-3-4-5 is the lowest straight). Suits never
          rank: hands of equal value split the pot.
        </p>
      </>
    ),
  },
  {
    id: "seating",
    heading: "Buying in and joining a hand",
    body: (
      <Bullets items={[
        "The buy-in is between 20 and 200 big blinds, taken from your play-chip balance. Nothing is taken until you confirm.",
        "Once a game is running (a hand has been played and at least two other players can play on), a player who takes a seat waits for the big blind: they are dealt in when the big blind reaches them and post it then. They are never dealt in on the button or between the button and the blinds for free. A player who sits down while a hand is in progress waits for the next hand at the earliest.",
        "When a game first starts, or when fewer than two other players could play on, newcomers are dealt in straight away.",
        "Cards are dealt one at a time clockwise, starting with the player to the left of the button (heads-up: the big blind), until everyone dealt in has two cards.",
      ]} />
    ),
  },
  {
    id: "button",
    heading: "Button and blinds",
    body: (
      <>
        <p>The table uses a forward-moving big blind with a dead button:</p>
        <Bullets items={[
          "Each hand the big blind moves to the next player in line who can play. Nobody can skip the big blind by leaving and returning.",
          "The small blind is posted by the player who was the big blind on the previous hand. If that player has left or is sitting out, the small blind is dead (not posted) for that hand.",
          "The button moves to the seat where the small blind was due on the previous hand. If that seat is now empty, the button is dead: it stays on the empty seat for the hand.",
          "Heads-up (two players), the button posts the small blind and the other player the big blind. The button acts first before the flop and last after it.",
          "A player who posts a blind but has fewer chips than the blind is all-in for what they have.",
        ]} />
      </>
    ),
  },
  {
    id: "missed-blinds",
    heading: "Sitting out and missed blinds",
    body: (
      <Bullets items={[
        "You may sit out at any time. If you sit out during your own turn, your hand is checked if checking is free and otherwise folded; while a hand you are in continues, you are checked or folded on each turn. You are not dealt into later hands until you press Sit in.",
        "While you sit out, every blind the big blind passes over you, and the small blind you would have posted after your big blind, are recorded as missed.",
        "When you return after missing blinds you do not post them as dead money. Instead you wait for the big blind: you are dealt in again when the big blind reaches your seat.",
        "If your turn runs out of time (see the turn clock below), you are sat out automatically, as if you had pressed Sit out, and stay out until you press Sit in.",
      ]} />
    ),
  },
  {
    id: "betting",
    heading: "Betting",
    body: (
      <Bullets items={[
        "Before the flop, betting starts with the player to the left of the big blind; on later rounds, with the first active player to the left of the button.",
        "The minimum bet is one big blind. A raise must be at least the size of the largest previous bet or raise in the same round; the maximum is all your chips (no limit).",
        "An all-in that is less than a full raise does not reopen the betting for players who have already acted in that round and have not faced a full raise since: they may only call or fold.",
        "You cannot bet more than the chips in front of you at the start of the hand, and you cannot add chips during a hand.",
        "A player who cannot match a bet may call all-in for the rest of their chips; side pots are formed as described below.",
      ]} />
    ),
  },
  {
    id: "turn-clock",
    heading: "Turn clock and time bank",
    body: (
      <Bullets items={[
        "On each turn you have a base time of 20 seconds to act.",
        "You also have a personal time bank, which is used automatically once your base time runs out. It starts at 30 seconds when you sit down, grows by 5 seconds for every 10 hands you are dealt, and holds at most 60 seconds. Time bank you use is not given back, but the bank keeps growing by 5 seconds every 10 hands up to the 60-second maximum.",
        "If both run out, the server acts for you: it checks if checking is free, otherwise it folds your hand. You are then sat out (see above).",
        "The countdown on your screen is based on the time remaining as reported by the server, not on your device's clock. The server's clock decides.",
        "If the service is interrupted during a hand, the player to act gets a fresh base time from the moment service resumes, and no time bank is charged for the outage.",
      ]} />
    ),
  },
  {
    id: "showdown",
    heading: "Showdown",
    body: (
      <>
        <p>
          When the betting on the river is complete and two or more players remain, there is a showdown. Losing hands are
          mucked automatically; you never have to show a hand that cannot win.
        </p>
        <Bullets items={[
          "The first hand shown is that of the last player to bet or raise in the final betting round. If nobody bet in that round, the first player still in the hand to the left of the button shows first.",
          "Then, going clockwise, each remaining player's hand is shown only if it beats or ties the best hand already shown in at least one pot that player can win; otherwise it is mucked.",
          "Winning hands are always shown.",
          "All-in showdown: when players are all-in and the remaining community cards are dealt with no further betting possible, every live hand is shown.",
          "Mucked cards are never shown to other players. They remain in the sealed hand record available only to the operator and the regulator.",
        ]} />
      </>
    ),
  },
  {
    id: "pots",
    heading: "Pots, side pots and split pots",
    body: (
      <Bullets items={[
        "Uncalled bets are returned: if the largest bet in a hand is not matched by any other player, the unmatched part goes back to the player who made it before any pot is awarded.",
        "When a player is all-in for less than others have bet, a main pot is formed that every remaining player can win, and the extra chips go into one or more side pots that only the players who contributed to them can win. A folded player's chips stay in the pots they reached (dead money); folding never creates a separate pot.",
        "Each pot is awarded to the best eligible hand. If two or more hands tie for a pot, that pot is split equally between them.",
        "Odd chips: when a pot cannot be split equally, the indivisible chip or chips go one at a time to the tied winners in clockwise order, starting with the first winner to the left of the button.",
        "If everyone else folds, the last remaining player wins the pot without showing.",
        "Play tables take no rake.",
      ]} />
    ),
  },
  {
    id: "leaving",
    heading: "Leaving the table",
    body: (
      <Bullets items={[
        "Between hands, leaving returns your whole stack to your balance immediately.",
        "During a hand you are playing, your hand is folded when your turn comes, not before, so play continues in order. (In the rare case where folding would leave a pot that nobody still in the hand could win, your hand is checked instead when checking is free.) If you are already all-in, your hand stays live and remains eligible for the pots you contributed to.",
        "Your remaining stack, including anything you win in that hand, returns to your balance as soon as the hand ends.",
      ]} />
    ),
  },
  {
    id: "idle",
    heading: "Idle tables",
    body: (
      <Bullets items={[
        "A table where no seated player has taken any action for 5 minutes shows a closing warning to every seated player for 30 seconds. Any seated player can keep the table open by confirming they are still there or by acting.",
        "Actions the server takes on a player's behalf (timeouts) do not count as activity.",
        "If the warning is not answered, the table closes. A hand in progress is completed under the normal sit-out rules and recorded like any other hand; then every player's chips are returned to their balance. A closed table cannot be reopened.",
      ]} />
    ),
  },
  {
    id: "interruptions",
    heading: "Interruptions and voided hands",
    body: (
      <Bullets items={[
        "Every hand state is saved by the server as it happens. After an outage, an interrupted hand continues from the last saved state, with a fresh turn clock for the player to act.",
        "A disconnection does not protect your hand: if you are not connected when it is your turn, your turn clock runs as normal.",
        "If a hand cannot be recovered, it may be voided. A voided hand has no winner: every chip each player committed to it is returned to them. Voiding a hand requires the approval of two different authorised staff members and is recorded in the audit log.",
      ]} />
    ),
  },
  {
    id: "disputes",
    heading: "Disputes",
    body: (
      <p>
        The server&apos;s hand record decides every hand. Every hand you played can be checked with the Verify hand button at
        the table (see <Link className="underline" href="/fairness">Game Fairness</Link>). To dispute a hand, follow the
        <Link className="underline" href="/complaints"> complaints procedure</Link> and quote the table name and hand number.
      </p>
    ),
  },
];

export default function RulesPage() {
  return (
    <LegalDocument
      title="House Rules"
      summary={<p>These rules decide every hand on Hold&apos;em Live. They form part of the Terms of Service.</p>}
      sections={sections}
    />
  );
}
