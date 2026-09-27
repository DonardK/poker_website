import { applyAction, completeHand, createTable, leaveSeat, sitDown, startHand } from "../table.js";
import { legalActions } from "../legal.js";
import { projectTableState } from "../public.js";
import { verifyTableCards } from "@poker/shared";

function game() {
  let table = createTable({ tableId: "leave-flow", name: "Leave flow", maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  for (let seat = 0; seat < 3; seat++) table = sitDown(table, seat, {
    userId: `player-${seat}`, username: `Player-${seat}`, kind: "HUMAN", botProfile: null, buyIn: 1000, avatarHue: 0,
  });
  return startHand(table);
}

test("a mid-hand leave is visible to the client and pays exactly once at cleanup", async () => {
  let table = leaveSeat(game(), "player-1");
  const view = projectTableState(table, "player-1");
  expect(view.players[1]?.pendingLeave).toBe(true);
  expect(await verifyTableCards(view)).toBe(true);
  expect(table.cashOuts).toEqual([]);
  for (let step = 0; table.phase !== "SHOWDOWN" && step < 100; step++) {
    const legal = legalActions(table, table.toActSeat!)!;
    table = applyAction(table, table.players[table.toActSeat!]!.userId, {
      action: legal.actions.includes("CHECK") ? "CHECK" : legal.actions.includes("CALL") ? "CALL" : "ALL_IN",
    });
  }
  table = completeHand(table);
  expect(table.players[1]).toBeNull();
  expect(table.cashOuts).toEqual([{ userId: "player-1", stack: 995 }]);
  expect(projectTableState(table, "player-1").players[1]?.pendingLeave).toBe(false);
});

test("a newcomer who has no cards can cash out immediately during another player's hand", async () => {
  const before = game();
  const joined = sitDown(before, 4, { userId: "newcomer", username: "Newcomer", kind: "HUMAN", botProfile: null, buyIn: 1000, avatarHue: 0 });
  const after = leaveSeat(joined, "newcomer");
  expect(after.players[4]).toBeNull();
  expect(after.cashOuts).toEqual([{ userId: "newcomer", stack: 1000 }]);
  expect(after.toActSeat).toBe(before.toActSeat);
  expect(after.audit).toEqual(before.audit);
  expect(await verifyTableCards(projectTableState(after, "player-0"))).toBe(true);
});
