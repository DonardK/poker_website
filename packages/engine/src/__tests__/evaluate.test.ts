import type { Card } from "@poker/shared";
import { evaluate, evaluate5 } from "../evaluate.js";

function ev(codes: string[]) {
  return evaluate(codes as Card[]);
}

describe("hand evaluator", () => {
  it("ranks royal flush over straight flush", () => {
    const royal = ev(["Ah", "Kh", "Qh", "Jh", "Th"]);
    const sf = ev(["9s", "8s", "7s", "6s", "5s"]);
    expect(royal.category).toBe("ROYAL_FLUSH");
    expect(sf.category).toBe("STRAIGHT_FLUSH");
    expect(royal.rankValue).toBeGreaterThan(sf.rankValue);
  });

  it("detects the wheel straight and wheel straight flush", () => {
    const wheel = ev(["Ah", "2c", "3d", "4s", "5h"]);
    const six = ev(["2h", "3c", "4d", "5s", "6h"]);
    const steelWheel = ev(["Ah", "2h", "3h", "4h", "5h"]);
    expect(wheel.category).toBe("STRAIGHT");
    expect(wheel.name).toContain("Five-high");
    expect(six.rankValue).toBeGreaterThan(wheel.rankValue);
    expect(steelWheel.category).toBe("STRAIGHT_FLUSH");
  });

  it("resolves kickers on pairs", () => {
    const ak = ev(["9h", "9c", "Ah", "Kd", "2s"]);
    const aq = ev(["9d", "9s", "Ac", "Qh", "3c"]);
    expect(ak.category).toBe("ONE_PAIR");
    expect(ak.rankValue).toBeGreaterThan(aq.rankValue);
  });

  it("resolves two-pair kickers", () => {
    const a = ev(["Kh", "Kc", "9d", "9s", "Ah"]);
    const b = ev(["Kd", "Ks", "9h", "9c", "Qh"]);
    expect(a.rankValue).toBeGreaterThan(b.rankValue);
  });

  it("ranks quads, boats, flushes, and trips in order", () => {
    const quads = ev(["Ah", "Ac", "Ad", "As", "2c"]);
    const boat = ev(["Kh", "Kc", "Kd", "9s", "9h"]);
    const flush = ev(["Ah", "9h", "7h", "4h", "2h"]);
    const trips = ev(["Qh", "Qc", "Qd", "9s", "2c"]);
    expect(quads.rankValue).toBeGreaterThan(boat.rankValue);
    expect(boat.rankValue).toBeGreaterThan(flush.rankValue);
    expect(flush.rankValue).toBeGreaterThan(trips.rankValue);
  });

  it("picks the best five from seven cards", () => {
    const seven = ev(["Ah", "Ad", "Kh", "Qh", "Jh", "Th", "2c"]);
    expect(seven.category).toBe("ROYAL_FLUSH");
    const pairBoard = ev(["7h", "2c", "9d", "9s", "3c", "Ah", "Kc"]);
    expect(pairBoard.category).toBe("ONE_PAIR");
    expect(pairBoard.name).toContain("Nines");
  });

  it("evaluate5 and evaluate agree on five cards", () => {
    const cards = ["Td", "9c", "8h", "7s", "6d"] as Card[];
    expect(evaluate(cards).rankValue).toBe(evaluate5(cards).rankValue);
  });
});
