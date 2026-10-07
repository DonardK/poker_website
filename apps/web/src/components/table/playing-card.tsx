"use client";

import type { Card } from "@poker/shared";
import { motion, useReducedMotion } from "framer-motion";

const SUITS: Record<string, { name: string; glyph: string }> = {
  h: { name: "hearts", glyph: "\u2665" },
  d: { name: "diamonds", glyph: "\u2666" },
  c: { name: "clubs", glyph: "\u2663" },
  s: { name: "spades", glyph: "\u2660" },
};

/** Spoken rank names, so a screen reader says "Ace of hearts", never "A of hearts". */
const RANK_NAMES: Record<string, string> = {
  "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine",
  T: "Ten", J: "Jack", Q: "Queen", K: "King", A: "Ace",
};

/** "Ace of hearts", "Ten of clubs"; null for anything that is not a card token. */
export function cardName(card: Card | null | undefined): string | null {
  const rank = RANK_NAMES[card?.[0] ?? ""];
  const suit = SUITS[card?.[1] ?? ""];
  return rank && suit ? `${rank} of ${suit.name}` : null;
}

export function PlayingCard({
  card,
  delay = 0,
  hidden = false,
  compact = false,
}: {
  card?: Card | null;
  delay?: number;
  hidden?: boolean;
  compact?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const face = !hidden && card;
  const rank = card?.[0] === "T" ? "10" : card?.[0] ?? "";
  const suit = SUITS[card?.[1] ?? ""];
  const red = card?.[1] === "h" || card?.[1] === "d";

  return (
    <motion.div
      role="img"
      aria-label={face ? cardName(card) ?? "Unknown card" : "Face-down card"}
      initial={reducedMotion ? false : { opacity: 0, x: -16, y: -20, rotate: -9, scale: 0.84 }}
      animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
      transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 230, damping: 24, mass: 0.8, delay }}
      className={`playing-card ${compact ? "playing-card--compact" : ""} ${face ? (red ? "playing-card--red" : "playing-card--black") : "playing-card--back"}`}
    >
      {face ? (
        <div className="playing-card-face" aria-hidden="true">
          <span className="playing-card-corner playing-card-corner--top"><strong>{rank}</strong><span>{suit?.glyph}</span></span>
          <span className="playing-card-pip">{suit?.glyph}</span>
          <span className="playing-card-corner playing-card-corner--bottom"><strong>{rank}</strong><span>{suit?.glyph}</span></span>
        </div>
      ) : (
        <span className="playing-card-back-mark" aria-hidden="true">{"\u2660"}</span>
      )}
    </motion.div>
  );
}
