"use client";

import type { Card } from "@poker/shared";
import { motion } from "framer-motion";

const RED = new Set(["h", "d"]);

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
  const rank = card?.[0] ?? "";
  const suit = card?.[1] ?? "";
  const red = RED.has(suit);
  const face = !hidden && card;

  return (
    <motion.div
      initial={{ opacity: 0, y: -24, rotate: -12, scale: 0.7 }}
      animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 20, delay }}
      className={`grid place-items-center rounded-md border font-semibold shadow-md ${
        compact ? "h-12 w-8 text-[11px] sm:h-14 sm:w-10 sm:text-sm" : "h-16 w-11 text-sm"
      } ${
        face ? "border-white/80 bg-[#f7f4ea] " + (red ? "text-red-600" : "text-zinc-900") : "border-white/20 bg-[#1a3a6b]"
      }`}
    >
      {face ? (
        <span>
          {rank}
          {suitGlyph(suit)}
        </span>
      ) : (
        <span className="text-[10px] text-white/70">♠</span>
      )}
    </motion.div>
  );
}

function suitGlyph(suit: string): string {
  switch (suit) {
    case "h":
      return "♥";
    case "d":
      return "♦";
    case "c":
      return "♣";
    case "s":
      return "♠";
    default:
      return "";
  }
}
