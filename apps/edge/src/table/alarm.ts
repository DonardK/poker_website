import {
  idleSince,
  turnDeadline,
  turnIdOf,
  type EngineTable,
} from "@poker/engine";
import { TABLE_IDLE_TIMEOUT_MS, type ActionType } from "@poker/shared";

const HAND_BREAK_MS = 3_200;

export type AlarmKind = "timeout" | "showdown" | "deal" | "idle-warn" | "idle-close" | "bot" | "outbox" | "retry";

/** What the single alarm will do when it fires. `at` is absolute epoch ms. */
export interface AlarmPlan {
  at: number;
  kind: AlarmKind;
  turnId?: string;
  handNumber?: number;
  userId?: string;
  intent?: { action: ActionType; amount?: number };
}

export function readyToDeal(table: EngineTable): boolean {
  if (table.closingAt != null || table.closeReason != null) return false;
  const live = table.players.filter((p) => p && !p.sittingOut && p.stack > 0);
  return live.length >= 2 && live.some((p) => p!.kind === "HUMAN");
}

/**
 * Earliest deadline. Bot decisions are taken here (when the alarm is armed),
 * not when it fires, and only if legacy bots are enabled.
 */
export async function planAlarm(table: EngineTable, now: number, opts: { pending: boolean; bots: boolean }): Promise<AlarmPlan | null> {
  const options: AlarmPlan[] = [];
  if (opts.pending) options.push({ at: now + 1_000, kind: "outbox" });
  if (table.status !== "CLOSED") {
    if (table.phase === "SHOWDOWN") {
      options.push({
        at: (table.settledAt ?? now) + HAND_BREAK_MS,
        kind: "showdown",
        handNumber: table.handNumber,
      });
    } else if ((table.phase === "WAITING" || table.phase === "COMPLETE") && readyToDeal(table)) {
      options.push({ at: now + 100, kind: "deal" });
    } else {
      const turnId = turnIdOf(table);
      const actor = table.toActSeat == null ? null : table.players[table.toActSeat];
      if (turnId && actor) {
        const deadline = turnDeadline(table) ?? now;
        if (actor.kind === "BOT" && opts.bots && deadline > now) {
          const { decideBotAction } = await import("@poker/engine");
          const decision = decideBotAction(table);
          options.push({
            at: Math.min(deadline, (table.turnStartedAt ?? now) + decision.delayMs),
            kind: "bot",
            turnId,
            userId: actor.userId,
            intent: decision.intent,
          });
        } else {
          options.push({ at: deadline, kind: "timeout", turnId });
        }
      }
    }
    if (table.closeReason == null) {
      if (table.closingAt == null) options.push({ at: idleSince(table) + TABLE_IDLE_TIMEOUT_MS, kind: "idle-warn" });
      else options.push({ at: table.closingAt, kind: "idle-close" });
    }
  }
  if (options.length === 0) return null;
  options.sort((a, b) => a.at - b.at);
  return options[0] ?? null;
}

export function parsePlan(raw: string | null): AlarmPlan | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AlarmPlan;
    if (typeof parsed?.at !== "number" || typeof parsed.kind !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
