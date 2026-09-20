import { applyAction, applyTimeout, completeHand, createTable, leaveSeat, sitDown, sitIn, sitOut, startHand } from "../table.js";
import { legalActions } from "../legal.js";
import { toPublicTableState } from "../public.js";
import { verifyCardProof, verifyTableCards } from "@poker/shared";
import { cardProof, commitDeck } from "../fairness.js";
import { shuffledDeck } from "../deck.js";
import { secureRandomInt } from "../rng.js";
import type { EngineTable } from "../types.js";

function table(stacks: number[]) {
  let t = createTable({ tableId: "regression", name: "Regression", maxSeats: 9, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  stacks.forEach((buyIn, i) => { t = sitDown(t, i, { userId: `u${i}`, username: `P${i}`, kind: "HUMAN", botProfile: null, avatarHue: 0, buyIn, skipBuyInCheck: true }); });
  return t;
}
function act(t: EngineTable, action: "CALL" | "ALL_IN" | "CHECK" | "FOLD" | "RAISE", amount?: number) {
  return applyAction(t, t.players[t.toActSeat!]!.userId, { action, amount });
}
function finish(t: EngineTable) {
  for (let n = 0; t.phase !== "SHOWDOWN" && n < 100; n++) {
    const legal = legalActions(t, t.toActSeat!)!;
    t = act(t, legal.actions.includes("CHECK") ? "CHECK" : "CALL");
  }
  expect(t.phase).toBe("SHOWDOWN"); return t;
}

describe("poker security regressions", () => {
  it("blocks all-in raises when a short all-in has not reopened betting", () => {
    let t = startHand(table([1000, 1000, 50]));
    t = act(t, "RAISE", 40); t = act(t, "CALL"); t = act(t, "ALL_IN");
    expect(legalActions(t, t.toActSeat!)!.actions).toEqual(["FOLD", "CALL"]);
    expect(() => act(t, "ALL_IN")).toThrow();
  });
  it("reopens raising after cumulative short all-ins reach a full raise", () => {
    let t = startHand(table([50, 70, 1000, 1000]));
    t = act(t, "RAISE", 40); // seat 3, full raise of 30
    t = act(t, "ALL_IN"); // seat 0, +10
    t = act(t, "ALL_IN"); // seat 1, +20
    t = act(t, "CALL"); // seat 2
    expect(t.toActSeat).toBe(3);
    expect(legalActions(t, 3)!.actions).toContain("RAISE");
  });
  it("keeps the full bring-in when the big blind is short", () => {
    const t = startHand(table([1000, 1000, 3]));
    expect(t.currentBet).toBe(10);
    expect(legalActions(t, 0)!.callAmount).toBe(10);
  });
  it("runs out immediately if blinds leave no outstanding decision", () => {
    const t = startHand(table([5, 10]));
    expect(t.phase).toBe("SHOWDOWN");
    expect(t.board).toHaveLength(5);
    expect(t.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0)).toBe(15);
  });
  it("preserves all-in eligibility when a player sits out or leaves", () => {
    let t = startHand(table([40, 1000, 1000])); t = act(t, "ALL_IN");
    t = sitOut(t, "u0"); expect(t.players[0]!.status).toBe("ALL_IN");
    t = leaveSeat(t, "u0"); expect(t.players[0]!.status).toBe("ALL_IN");
    t = finish(t); expect(t.players[0]!.showedCards).toBe(true);
    t = completeHand(t); expect(t.players[0]).toBeNull();
    expect(t.cashOuts.some((c) => c.userId === "u0")).toBe(true);
    expect(t.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + t.cashOuts.reduce((sum, c) => sum + c.stack, 0)).toBe(2040);
  });
  it("deals a mid-hand newcomer into the next hand", () => {
    let t = startHand(table([1000, 1000]));
    t = sitDown(t, 4, { userId: "new", username: "New", kind: "HUMAN", botProfile: null, avatarHue: 0, buyIn: 1000 });
    expect(t.players[4]!.holeCards).toBeNull();
    t = startHand(completeHand(finish(t))); expect(t.players[4]!.holeCards).toHaveLength(2);
  });
  it("deals first to the big blind heads-up", () => {
    const t = startHand(table([1000, 1000]));
    expect(t.dealtSeats[0]).toBe(t.bbSeat);
    expect(t.players[t.bbSeat!]!.holeCards![0]).toBe(t.fairness!.deck[0]);
  });
  it("does not repeat the big blind across gaps or heads-up transition", () => {
    let t = table([1000, 1000, 1000, 1000]);
    t.players[6] = { ...t.players[3]!, seatIndex: 6 }; t.players[3] = null;
    t = startHand(t); const bbs: number[] = [];
    for (let i = 0; i < 4; i++) { bbs.push(t.bbSeat!); t = startHand(completeHand(finish(t))); }
    expect(bbs).toEqual([2, 6, 0, 1]);
    t = completeHand(finish(t)); const priorBB = t.bbSeat!;
    for (const p of [...t.players]) if (p && p.seatIndex !== priorBB && p.seatIndex !== 6) t = leaveSeat(t, p.userId);
    t = startHand(t); expect(t.bbSeat).not.toBe(priorBB);
  });
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])("rejects invalid money %p", (amount) => {
    const t = startHand(table([1000, 1000, 1000])); expect(() => act(t, "RAISE", amount)).toThrow();
  });
  it("rejects invalid seats and overlapping hand starts", () => {
    const t = table([1000, 1000]);
    expect(() => sitDown(t, 1.5, { userId: "bad", username: "Bad", kind: "HUMAN", botProfile: null, buyIn: 1000, avatarHue: 0 })).toThrow();
    expect(() => startHand(startHand(t))).toThrow();
    expect(() => completeHand(startHand(t))).toThrow();
  });
  it("stores actual actions and separates uncalled refunds from winnings", () => {
    let t = startHand(table([1000, 1000, 1000]));
    t = act(t, "RAISE", 40); t = act(t, "FOLD"); t = act(t, "FOLD");
    expect(t.actions.map((a) => a.action)).toEqual(["POST_SB", "POST_BB", "RAISE", "FOLD", "FOLD"]);
    expect(t.refunds).toEqual([{ seatIndex: 0, amount: 30 }]);
    expect(t.winners[0]!.amount).toBe(25);
    const next = startHand(completeHand(t)); expect(next.actions).toHaveLength(2);
  });
  it("conserves chips through 600 complete hands with exits, sit-outs and varied stacks", () => {
    for (let run = 0; run < 600; run++) {
      const stacks = Array.from({ length: 2 + run % 8 }, (_, seat) => 1 + (run * 37 + seat * 113) % 1500);
      const total = stacks.reduce((a, b) => a + b, 0);
      let t = startHand(table(stacks));
      for (let turn = 0; t.phase !== "SHOWDOWN" && turn < 100; turn++) {
        expect(t.toActSeat).not.toBeNull();
        const actor = t.players[t.toActSeat!]!;
        if (turn % 13 === 4) { t = sitOut(t, actor.userId); continue; }
        if (turn % 17 === 6) { t = leaveSeat(t, actor.userId); continue; }
        const legal = legalActions(t, t.toActSeat!)!;
        const action = legal.actions[(run + turn * 7) % legal.actions.length]!;
        t = applyAction(t, actor.userId, { action, amount: action === "BET" ? Math.min(legal.minBet, legal.maxRaiseTo) : action === "RAISE" ? legal.minRaiseTo : undefined });
      }
      expect(t.phase).toBe("SHOWDOWN");
      expect(t.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0)).toBe(total);
      expect(t.players.every((p) => !p || Number.isSafeInteger(p.stack) && p.stack >= 0)).toBe(true);
      const cards = [...t.players.flatMap((p) => p?.holeCards ?? []), ...t.board, ...t.burns, ...t.deck];
      expect(new Set(cards).size).toBe(52);
    }
  });
});

describe("randomness and private card proofs", () => {
  it.each([0, -1, NaN, Infinity, 1.5, 2 ** 48])("rejects RNG range %p without hanging", (n) => { expect(() => secureRandomInt(n)).toThrow(); });
  it("verifies every committed card and rejects altered card, salt, position, sibling and context", async () => {
    const c = commitDeck(shuffledDeck(), "proof", 1);
    for (let i = 0; i < 52; i++) expect(await verifyCardProof(c.context, c.root, cardProof(c, i))).toBe(true);
    const proof = cardProof(c, 0);
    expect(await verifyCardProof(c.context, c.root, { ...proof, card: c.deck[1]! })).toBe(false);
    expect(await verifyCardProof(c.context, c.root, { ...proof, salt: "0".repeat(64) })).toBe(false);
    expect(await verifyCardProof(c.context, c.root, { ...proof, index: 1 })).toBe(false);
    expect(await verifyCardProof(c.context, c.root, { ...proof, siblings: ["0".repeat(64), ...proof.siblings.slice(1)] })).toBe(false);
    expect(await verifyCardProof("another hand", c.root, proof)).toBe(false);
  });
  it("proves only authorized cards and retains one root for every street", async () => {
    let t = startHand(table([1000, 1000, 1000])); const root = t.fairness!.root;
    const hero = toPublicTableState(t, "u0"); expect(hero.fairness!.proofs).toHaveLength(2);
    expect(await verifyTableCards(hero)).toBe(true);
    expect(toPublicTableState(t, null).fairness!.proofs).toEqual([]);
    t = act(t, "FOLD"); t = finish(t);
    const view = toPublicTableState(t, "u1");
    expect(view.fairness!.root).toBe(root); expect(view.players[0]!.holeCards).toBeNull();
    expect(view.fairness!.proofs).toHaveLength(9); expect(await verifyTableCards(view)).toBe(true);
    const altered = structuredClone(view); altered.board[0] = t.fairness!.deck[51]!;
    expect(await verifyTableCards(altered)).toBe(false);
    const noProof = structuredClone(view); noProof.fairness!.proofs.pop(); expect(await verifyTableCards(noProof)).toBe(false);
  });
});
