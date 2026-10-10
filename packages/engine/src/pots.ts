import { NO_RAKE, rakeByPot, rakeFor, type Card, type PotShare, type RakeTerms } from "@poker/shared";
import { evaluate, type EvaluatedHand } from "./evaluate.js";

export interface Contribution {
  seatIndex: number;
  committed: number;
  folded: boolean;
}

export interface BuiltPot {
  potIndex: number;
  amount: number;
  eligibleSeatIndexes: number[];
}

/**
 * If the largest commitment is not matched by any other player, the
 * unmatched difference is returned before pots are built.
 */
export function returnUncalledBets(contribs: readonly Contribution[]): {
  returned: Map<number, number>;
  adjusted: Contribution[];
} {
  const returned = new Map<number, number>();
  const adjusted = contribs.map((c) => ({ ...c }));
  const positive = adjusted.filter((c) => c.committed > 0);
  if (positive.length === 0) return { returned, adjusted };

  let max = 0;
  let maxSeat = -1;
  let second = 0;
  for (const c of positive) {
    if (c.committed > max) {
      second = max;
      max = c.committed;
      maxSeat = c.seatIndex;
    } else if (c.committed > second) {
      second = c.committed;
    }
  }
  const refund = max - second;
  if (refund > 0 && maxSeat >= 0) {
    const row = adjusted.find((c) => c.seatIndex === maxSeat);
    if (row) {
      row.committed -= refund;
      returned.set(maxSeat, refund);
    }
  }
  return { returned, adjusted };
}

/**
 * Cuts the chips at every distinct commitment level, folded players' levels
 * included. Consecutive levels can therefore share the same eligible players.
 * awardPots merges those levels into one pot (see mergePotsByEligibility).
 */
export function buildSidePots(contribs: readonly Contribution[]): BuiltPot[] {
  const active = contribs.filter((c) => c.committed > 0);
  if (active.length === 0) return [];
  const levels = [...new Set(active.map((c) => c.committed))].sort((a, b) => a - b);
  const pots: BuiltPot[] = [];
  let prev = 0;
  for (const level of levels) {
    const involved = active.filter((c) => c.committed >= level);
    const amount = (level - prev) * involved.length;
    const eligibleSeatIndexes = involved.filter((c) => !c.folded).map((c) => c.seatIndex);
    if (amount > 0) {
      pots.push({ potIndex: pots.length, amount, eligibleSeatIndexes });
    }
    prev = level;
  }
  return pots;
}

/**
 * COMPLIANCE NOTE (pot identity): a pot is defined by the players who can
 * win it. A side pot starts only where a live player's all-in amount is
 * exceeded. A folded player's chips are dead money in the pots they reach
 * and never open a pot of their own. This merges consecutive levels from
 * buildSidePots that have the same eligible players. Without the merge, each
 * piece is split separately with its own odd chip. Example: with folds at 5,
 * 25 and 56, a 220-chip pot split two ways paid 111 / 109 instead of
 * 110 / 110.
 */
export function mergePotsByEligibility(pots: readonly BuiltPot[]): BuiltPot[] {
  const merged: BuiltPot[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    // Eligible sets are nested (each level's is a subset of the one below), so equal sets are always adjacent.
    if (last && last.eligibleSeatIndexes.length === pot.eligibleSeatIndexes.length &&
        last.eligibleSeatIndexes.every((seat) => pot.eligibleSeatIndexes.includes(seat))) {
      last.amount += pot.amount;
    } else {
      merged.push({ potIndex: merged.length, amount: pot.amount, eligibleSeatIndexes: [...pot.eligibleSeatIndexes] });
    }
  }
  return merged;
}

/** Clockwise from left of the dealer (SB in a full ring) — casino odd-chip order. */
export function seatingOrderFromBlinds(dealerSeat: number, maxSeats: number): number[] {
  const order: number[] = [];
  for (let i = 1; i <= maxSeats; i += 1) {
    order.push((dealerSeat + i) % maxSeats);
  }
  return order;
}

export function splitOddChips(
  amount: number,
  winnerSeats: readonly number[],
  dealerSeat: number,
  maxSeats: number,
): { payouts: Map<number, number>; oddChipSeatIndex: number | null } {
  const payouts = new Map<number, number>();
  if (winnerSeats.length === 0 || amount <= 0) {
    return { payouts, oddChipSeatIndex: null };
  }
  const base = Math.floor(amount / winnerSeats.length);
  let rem = amount % winnerSeats.length;
  for (const seat of winnerSeats) payouts.set(seat, base);
  const order = seatingOrderFromBlinds(dealerSeat, maxSeats);
  // The first extra chip's seat only. Later extras are already in `payouts`
  // (same clockwise order). The field stays a single seat: PotShare, the hand
  // audit, and the server's pot row all store number | null.
  let oddChipSeatIndex: number | null = null;
  for (const seat of order) {
    if (rem <= 0) break;
    if (!payouts.has(seat)) continue;
    payouts.set(seat, (payouts.get(seat) ?? 0) + 1);
    if (oddChipSeatIndex === null) oddChipSeatIndex = seat;
    rem -= 1;
  }
  return { payouts, oddChipSeatIndex };
}

export interface RakeTaken {
  total: number;
  /** Deduction per pot (main pot first), listing only pots actually raked. */
  perPot: { potIndex: number; amount: number }[];
}

/**
 * Settle the pots. Uncalled bets go back first; the rest is the chips
 * contested. With `rake` terms (omitted = no rake) the rake is
 * min(cap, floor(contested x bps / 10000)), or 0 when no flop was dealt
 * under "no flop, no drop" (a flop was dealt when the board has 3+ cards,
 * all-in runouts included). It comes out of the main pot first, then the
 * side pots in order. Each pot's winners share what is left of it, with the
 * usual odd-chip rule. The returned pots keep their gross amounts (what was
 * contested); payouts are net of rake.
 */
export function awardPots(opts: {
  contribs: readonly Contribution[];
  holeCards: Record<number, [Card, Card]>;
  board: readonly Card[];
  dealerSeat: number;
  maxSeats: number;
  rake?: RakeTerms;
}): {
  returned: Map<number, number>;
  pots: PotShare[];
  payouts: Map<number, number>;
  evaluations: Map<number, EvaluatedHand>;
  rake: RakeTaken;
} {
  const { returned, adjusted } = returnUncalledBets(opts.contribs);
  const built = mergePotsByEligibility(buildSidePots(adjusted));
  const contested = built.reduce((sum, pot) => sum + pot.amount, 0);
  const total = rakeFor(contested, opts.rake ?? NO_RAKE, opts.board.length >= 3);
  const perPot = rakeByPot(built.map((pot) => pot.amount), total);
  const evaluations = new Map<number, EvaluatedHand>();
  const payouts = new Map<number, number>();
  const add = (seat: number, amt: number) => payouts.set(seat, (payouts.get(seat) ?? 0) + amt);

  for (const [seat, amt] of returned) add(seat, amt);

  const pots: PotShare[] = built.map((pot) => {
    // What the winners share: the pot less the rake taken from it.
    const net = pot.amount - (perPot.find((row) => row.potIndex === pot.potIndex)?.amount ?? 0);
    const eligible = pot.eligibleSeatIndexes;
    if (eligible.length === 0) {
      return {
        potIndex: pot.potIndex,
        amount: pot.amount,
        eligibleSeatIndexes: [],
        winnerSeatIndexes: [],
        oddChipSeatIndex: null,
      };
    }
    if (eligible.length === 1) {
      add(eligible[0]!, net);
      return {
        potIndex: pot.potIndex,
        amount: pot.amount,
        eligibleSeatIndexes: eligible,
        winnerSeatIndexes: eligible,
        oddChipSeatIndex: null,
      };
    }
    let best = -1;
    const scores: { seat: number; value: number }[] = [];
    for (const seat of eligible) {
      const hole = opts.holeCards[seat];
      if (!hole) throw new Error(`Missing hole cards for seat ${seat}`);
      const ev = evaluate([...hole, ...opts.board]);
      evaluations.set(seat, ev);
      scores.push({ seat, value: ev.rankValue });
      if (ev.rankValue > best) best = ev.rankValue;
    }
    const winners = scores.filter((s) => s.value === best).map((s) => s.seat);
    const split = splitOddChips(net, winners, opts.dealerSeat, opts.maxSeats);
    for (const [seat, amt] of split.payouts) add(seat, amt);
    return {
      potIndex: pot.potIndex,
      amount: pot.amount,
      eligibleSeatIndexes: eligible,
      winnerSeatIndexes: winners,
      oddChipSeatIndex: split.oddChipSeatIndex,
    };
  });

  return { returned, pots, payouts, evaluations, rake: { total, perPot } };
}

export function totalChips(contribs: readonly Contribution[], stacks: Record<number, number>): number {
  let sum = 0;
  for (const c of contribs) sum += c.committed;
  for (const v of Object.values(stacks)) sum += v;
  return sum;
}
