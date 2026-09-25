/**
 * Random but always-legal Hold'em driver for the leakage tests.
 *
 * - Every random choice comes from the engine's OS CSPRNG (`secureRandomInt`).
 *   Math.random and seeded generators are banned across the project.
 * - Actions are chosen only from `legalActions`, so every transition is one
 *   the server could really perform.
 * - Scripted plans (`foldOn`, `checkdown`, `shove`, `events`) produce the hand
 *   shapes the tests must cover without relying on luck: a fold on every
 *   street, all-in runouts, side pots, time-outs, sit-outs, departures and
 *   newcomers. Coverage assertions therefore never depend on chance.
 * - After every state change the observer receives the new table, which is
 *   exactly the state the server would project and emit.
 */
import type { ActionType, LegalActionSet } from "@poker/shared";
import { legalActions } from "../../legal.js";
import { secureRandomInt } from "../../rng.js";
import { applyAction, applyTimeout, completeHand, createTable, leaveSeat, sitDown, sitIn, sitOut, startHand } from "../../table.js";
import type { EngineIntent, EnginePlayer, EngineTable } from "../../types.js";

export const randInt = (maxExclusive: number): number => secureRandomInt(maxExclusive);
export const chance = (numerator: number, denominator: number): boolean => secureRandomInt(denominator) < numerator;
export function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() from an empty list");
  return items[secureRandomInt(items.length)]!;
}

export type Street = "PREFLOP" | "FLOP" | "TURN" | "RIVER";
export const STREETS: readonly Street[] = ["PREFLOP", "FLOP", "TURN", "RIVER"];
export const isBetting = (phase: EngineTable["phase"]): phase is Street => (STREETS as readonly string[]).includes(phase);

export type Style = "passive" | "balanced" | "aggressive";

export type Plan =
  /** Check/call until `street`; there the first actor bets or raises the minimum and everyone else folds. */
  | { kind: "foldOn"; street: Street }
  /** Check or call every decision: all live hands reach showdown. */
  | { kind: "checkdown" }
  /** Everyone moves all-in (or calls when a re-raise is closed): an all-in runout. */
  | { kind: "shove" }
  /** Newcomer mid-hand, time-out, sit-out on turn, departure off turn, sit-in and an all-in-sized RAISE. Needs 5+ deep stacks and a free seat. */
  | { kind: "events" }
  | { kind: "random"; style: Style; events: boolean };

export type Transition =
  | { kind: "sitDown"; userId: string; seat: number }
  | { kind: "startHand" }
  | { kind: "action"; userId: string; intent: EngineIntent; legal: LegalActionSet }
  | { kind: "timeout"; userId: string }
  | { kind: "sitOut"; userId: string }
  | { kind: "sitIn"; userId: string }
  | { kind: "leaveSeat"; userId: string }
  | { kind: "completeHand" };

export type Observer = (sim: TableSim, transition: Transition) => void | Promise<void>;

export interface Identity {
  userId: string;
  username: string;
}

let identityCounter = 0;
/** Ids and names that can never tokenize to a card code ("leak", "u12", "Player", "12"). */
export function freshIdentity(): Identity {
  identityCounter += 1;
  return { userId: `leak-u${identityCounter}`, username: `Player-${identityCounter}` };
}

const WEIGHTS: Record<Style, Record<ActionType, number>> = {
  passive: { FOLD: 1, CHECK: 12, CALL: 10, BET: 2, RAISE: 1, ALL_IN: 1 },
  balanced: { FOLD: 3, CHECK: 5, CALL: 5, BET: 4, RAISE: 3, ALL_IN: 1 },
  aggressive: { FOLD: 3, CHECK: 3, CALL: 4, BET: 6, RAISE: 6, ALL_IN: 3 },
};

/** Random legal intent. BET/RAISE sizes: minimum, all-in-sized, uniform in range, or pot-sized. */
export function randomIntent(table: EngineTable, legal: LegalActionSet, style: Style): EngineIntent {
  const weights = WEIGHTS[style];
  const total = legal.actions.reduce((sum, action) => sum + weights[action], 0);
  let roll = randInt(total);
  let action = legal.actions[0]!;
  for (const candidate of legal.actions) {
    roll -= weights[candidate];
    if (roll < 0) {
      action = candidate;
      break;
    }
  }
  if (action !== "BET" && action !== "RAISE") return { action };
  const lo = action === "BET" ? Math.min(legal.minBet, legal.maxRaiseTo) : legal.minRaiseTo;
  const hi = legal.maxRaiseTo;
  const sizes = [lo, hi, lo + randInt(hi - lo + 1), Math.min(hi, Math.max(lo, table.currentBet + table.potTotal))];
  return { action, amount: pick(sizes) };
}

function passive(legal: LegalActionSet): EngineIntent {
  if (legal.actions.includes("CHECK")) return { action: "CHECK" };
  if (legal.actions.includes("CALL")) return { action: "CALL" };
  return { action: "ALL_IN" };
}

export interface TableSimConfig {
  tableId: string;
  name: string;
  maxSeats: number;
  smallBlind: number;
}

interface HandContext {
  plan: Plan;
  decisions: number;
  opener: number | null;
  eventSitter: string | null;
}

/** One table plus the transitions applied to it. The observer runs after every transition. */
export class TableSim {
  table: EngineTable;
  /** Every userId that has sat here, including departed players (they stay authenticated viewers). */
  readonly everSeated = new Set<string>();
  /** Recent transitions, for failure messages. */
  readonly recent: Transition[] = [];
  now = Date.now();

  constructor(config: TableSimConfig, private readonly observe: Observer) {
    this.table = createTable({ ...config, bigBlind: config.smallBlind * 2, timeBankMs: 15_000 });
  }

  private tick(): number {
    this.now += 1_000;
    return this.now;
  }

  private async commit(next: EngineTable, transition: Transition): Promise<void> {
    this.table = next;
    this.recent.push(transition);
    if (this.recent.length > 30) this.recent.shift();
    await this.observe(this, transition);
  }

  describe(): string {
    return `table ${this.table.tableId} hand #${this.table.handNumber} phase ${this.table.phase}; recent: ${JSON.stringify(this.recent.slice(-8))}`;
  }

  player(userId: string): EnginePlayer | null {
    return this.table.players.find((p) => p?.userId === userId) ?? null;
  }

  seated(): EnginePlayer[] {
    return this.table.players.filter((p): p is EnginePlayer => p !== null);
  }

  emptySeats(): number[] {
    return this.table.players.map((p, seat) => (p ? -1 : seat)).filter((seat) => seat >= 0);
  }

  async seat(seat: number, stack: number, identity: Identity = freshIdentity(), bot = false): Promise<Identity> {
    const next = sitDown(this.table, seat, {
      ...identity, avatarHue: 0, kind: bot ? "BOT" : "HUMAN", botProfile: bot ? pick(["TAG", "LOOSE_PASSIVE", "MANIAC", "GTO"] as const) : null,
      buyIn: stack, skipBuyInCheck: true,
    });
    this.everSeated.add(identity.userId);
    await this.commit(next, { kind: "sitDown", userId: identity.userId, seat });
    return identity;
  }

  async act(intent: EngineIntent): Promise<void> {
    const seat = this.table.toActSeat!;
    const legal = legalActions(this.table, seat)!;
    const userId = this.table.players[seat]!.userId;
    await this.commit(applyAction(this.table, userId, intent, this.tick()), { kind: "action", userId, intent, legal });
  }

  async timeout(): Promise<void> {
    const userId = this.table.players[this.table.toActSeat!]!.userId;
    await this.commit(applyTimeout(this.table, this.tick()), { kind: "timeout", userId });
  }

  async sitOut(userId: string): Promise<void> {
    await this.commit(sitOut(this.table, userId, this.tick()), { kind: "sitOut", userId });
  }

  async sitIn(userId: string): Promise<void> {
    await this.commit(sitIn(this.table, userId, this.tick()), { kind: "sitIn", userId });
  }

  async leave(userId: string): Promise<void> {
    await this.commit(leaveSeat(this.table, userId, this.tick()), { kind: "leaveSeat", userId });
  }

  async start(): Promise<void> {
    await this.commit(startHand(this.table, this.tick()), { kind: "startHand" });
  }

  async complete(): Promise<void> {
    await this.commit(completeHand(this.table), { kind: "completeHand" });
  }

  /** startHand, betting until SHOWDOWN, showdown-phase events (`atShowdown`, or random ones), completeHand. */
  async playHand(plan: Plan, atShowdown?: (sim: TableSim) => Promise<void>): Promise<void> {
    await this.start();
    const ctx: HandContext = { plan, decisions: 0, opener: null, eventSitter: null };
    for (let steps = 0; isBetting(this.table.phase); steps++) {
      if (steps > 2_000) throw new Error(`Hand did not terminate: ${this.describe()}`);
      const seat = this.table.toActSeat;
      if (seat == null) throw new Error(`No actor during a betting round: ${this.describe()}`);
      const legal = legalActions(this.table, seat);
      if (!legal) throw new Error(`Actor has no legal actions: ${this.describe()}`);
      await this.decide(ctx, seat, legal);
    }
    if (this.table.phase !== "SHOWDOWN") throw new Error(`Hand ended outside SHOWDOWN: ${this.describe()}`);
    if (atShowdown) await atShowdown(this);
    else if (plan.kind === "random" && plan.events) {
      // Stand-ups and sit-outs while the result is on screen.
      if (chance(1, 8)) await this.leave(pick(this.seated()).userId);
      if (chance(1, 12) && this.seated().length > 0) await this.sitOut(pick(this.seated()).userId);
    }
    await this.complete();
  }

  private async decide(ctx: HandContext, seat: number, legal: LegalActionSet): Promise<void> {
    const { plan } = ctx;
    const actor = this.table.players[seat]!;
    const decision = ctx.decisions++;
    switch (plan.kind) {
      case "checkdown":
        return this.act(passive(legal));
      case "shove":
        return this.act(legal.actions.includes("ALL_IN") ? { action: "ALL_IN" } : passive(legal));
      case "foldOn": {
        const street = this.table.phase as Street;
        if (STREETS.indexOf(street) < STREETS.indexOf(plan.street)) return this.act(passive(legal));
        if (ctx.opener === null) {
          ctx.opener = seat;
          if (legal.actions.includes("RAISE")) return this.act({ action: "RAISE", amount: legal.minRaiseTo });
          if (legal.actions.includes("BET")) return this.act({ action: "BET", amount: legal.minBet });
          return this.act(passive(legal));
        }
        return this.act(legal.actions.includes("FOLD") ? { action: "FOLD" } : passive(legal));
      }
      case "events": {
        if (decision === 0) {
          // A newcomer sits down mid-hand (dealt out), then the first actor times out.
          const empty = this.emptySeats();
          if (empty.length > 0) await this.seat(empty[0]!, this.table.bigBlind * 100);
          return this.timeout();
        }
        if (decision === 1) {
          // Sitting out on your own turn is an immediate time-out.
          ctx.eventSitter = actor.userId;
          return this.sitOut(actor.userId);
        }
        if (decision === 2) {
          // Another live player leaves off-turn; the actor then makes an all-in-sized RAISE.
          const leaver = this.table.dealtSeats
            .map((s) => this.table.players[s]!)
            .find((p) => p.seatIndex !== seat && p.status === "ACTIVE");
          if (leaver) await this.leave(leaver.userId);
          if (this.table.toActSeat !== seat || !isBetting(this.table.phase)) return;
          const current = legalActions(this.table, seat)!;
          if (current.actions.includes("RAISE")) return this.act({ action: "RAISE", amount: current.maxRaiseTo });
          return this.act(passive(current));
        }
        if (decision === 3 && ctx.eventSitter && this.player(ctx.eventSitter)?.sittingOut) await this.sitIn(ctx.eventSitter);
        if (this.table.toActSeat !== seat || !isBetting(this.table.phase)) return;
        return this.act(passive(legalActions(this.table, seat)!));
      }
      case "random": {
        if (plan.events) {
          const roll = randInt(1_000);
          if (roll < 20) return this.timeout();
          if (roll < 35) return this.sitOut(actor.userId);
          if (roll < 50) return this.leave(actor.userId);
          if (roll < 65) {
            const others = this.seated().filter((p) => p.seatIndex !== seat && !p.sittingOut);
            if (others.length > 0) return this.sitOut(pick(others).userId);
          } else if (roll < 80) {
            const others = this.seated().filter((p) => p.seatIndex !== seat && !p.pendingLeave);
            if (others.length > 0) return this.leave(pick(others).userId);
          } else if (roll < 100) {
            const away = this.seated().filter((p) => p.sittingOut && !p.pendingLeave);
            if (away.length > 0) return this.sitIn(pick(away).userId);
          } else if (roll < 110) {
            const empty = this.emptySeats();
            if (empty.length > 0) {
              await this.seat(pick(empty), this.table.bigBlind * (1 + randInt(300)));
              return;
            }
          }
        }
        return this.act(randomIntent(this.table, legal, plan.style));
      }
    }
  }

  /** Between-hands traffic: sit-ins, newcomers and stand-ups while WAITING. */
  async betweenHands(): Promise<void> {
    for (const p of this.seated()) if (p.sittingOut && chance(1, 2)) await this.sitIn(p.userId);
    if (chance(1, 3) && this.emptySeats().length > 0) await this.seat(pick(this.emptySeats()), this.table.bigBlind * (1 + randInt(300)));
    if (chance(1, 10) && this.seated().length > 0) await this.leave(pick(this.seated()).userId);
  }

  liveForDeal(): number {
    return this.seated().filter((p) => !p.sittingOut && p.stack > 0).length;
  }
}
