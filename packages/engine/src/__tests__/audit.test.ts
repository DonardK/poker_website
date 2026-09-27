/**
 * Requirement 3: tamper-evident audit trail and SHA-256 immutability logging.
 *
 * These tests show that every hand has a UUID v4 id and UTC timestamps. The
 * SHA-256 deck commitment is created before any card is dealt and binds the
 * exact deck the cards came from. Every transition is hash-chained, the
 * post-hand verification hash covers the whole record, hands are chained per
 * table, and any single-field tamper is detected by the independent WebCrypto
 * verifier in @poker/shared.
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  deckCommitmentPreimage,
  eventPreimage,
  finalStatePreimage,
  genesisPreimage,
  holeCardPositions,
  holeCardsDigest,
  merkleContext,
  merkleRootAsync,
  RNG_DESCRIPTOR,
  UTC_ISO,
  UUID_V4,
  verifyAuditRecord,
  verifyParticipantAudit,
  verifySealedAudit,
  type Card,
  type HandAuditRecord,
  type ObservedHandEvidence,
} from "@poker/shared";
import { participantAudit, participantPositions, sealedAudit } from "../audit.js";
import { legalActions } from "../legal.js";
import { projectTableState } from "../public.js";
import { applyAction, applyTimeout, completeHand, createTable, leaveSeat, sitDown, sitOut, startHand } from "../table.js";
import type { EngineTable } from "../types.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

function seated(stacks: number[], tableId = "audit-table"): EngineTable {
  let t = createTable({ tableId, name: "Audit", maxSeats: 9, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
  stacks.forEach((buyIn, i) => {
    t = sitDown(t, i, { userId: `u${i}`, username: `Player-${i}`, kind: "HUMAN", botProfile: null, avatarHue: 0, buyIn, skipBuyInCheck: true });
  });
  return t;
}

/** Play to showdown with a varied but legal action pattern; returns the settled table. */
function playOut(t: EngineTable, pattern = 0, now = T0): EngineTable {
  for (let turn = 0; t.phase !== "SHOWDOWN" && turn < 200; turn++) {
    const seat = t.toActSeat!;
    const legal = legalActions(t, seat)!;
    const at = now + (turn + 1) * 1_000;
    if ((pattern + turn) % 11 === 7) { t = applyTimeout(t, at); continue; }
    const choice = legal.actions[(pattern * 7 + turn * 3) % legal.actions.length]!;
    const amount = choice === "BET" ? legal.minBet : choice === "RAISE" ? legal.minRaiseTo : undefined;
    t = applyAction(t, t.players[seat]!.userId, { action: choice, amount }, at);
  }
  expect(t.phase).toBe("SHOWDOWN");
  return t;
}

const clone = <T>(value: T): T => structuredClone(value);

describe("hand audit record", () => {
  it("opens with a UUID v4 hand id, UTC timestamps and a deck commitment made before any card is dealt", async () => {
    const t = startHand(seated([1000, 1000, 1000]), T0);
    const record = t.audit!;
    expect(record.handId).toMatch(UUID_V4);
    expect(record.handId).toBe(t.fairness!.handId);
    expect(record.startedAt).toBe(new Date(T0).toISOString());
    expect(record.startedAt).toMatch(UTC_ISO);
    expect(record.rng).toEqual(RNG_DESCRIPTOR);

    // Event order proves the commitment precedes every deal: HAND_STARTED
    // (which the genesis hash binds to the commitment), then blinds, then the deal.
    expect(record.events.slice(0, 4).map((e) => e.type)).toEqual(["HAND_STARTED", "BLIND_POSTED", "BLIND_POSTED", "HOLE_CARDS_DEALT"]);

    // The commitment is SHA-256 over the canonical full deck order, and that
    // deck is exactly the one the hole cards were dealt from.
    const fair = t.fairness!;
    expect(record.deckCommitment).toBe(sha256(deckCommitmentPreimage(record.handId, t.tableId, t.handNumber, fair.deck, fair.deckSalt)));
    expect(record.merkleRoot).toBe(await merkleRootAsync(merkleContext(t.tableId, t.handNumber, record.handId), fair.deck, fair.salts));
    t.dealtSeats.forEach((seat, i) => {
      const [a, b] = holeCardPositions(i, t.dealtSeats.length);
      expect(t.players[seat]!.holeCards).toEqual([fair.deck[a], fair.deck[b]]);
    });
    // Live, unsettled record verifies as a chain but carries no final hash yet.
    expect(await verifyAuditRecord(record)).toEqual({ ok: true });
    expect(record.finalStateHash).toBeNull();
    expect((await verifyAuditRecord(record, { requireSettled: true })).ok).toBe(false);
  });

  it("does not put any hidden hole card value into the chain", () => {
    const t = playOut(startHand(seated([1000, 1000, 1000, 1000]), T0), 3);
    const hidden = t.dealtSeats.flatMap((seat) => (t.players[seat]!.showedCards ? [] : t.players[seat]!.holeCards!));
    const nonShowdown = JSON.stringify(t.audit!.events.filter((e) => e.type !== "SHOWDOWN"));
    for (const card of [...hidden, ...t.dealtSeats.flatMap((s) => t.players[s]!.holeCards!)]) {
      if (t.board.includes(card)) continue;
      expect(nonShowdown.split(/[^0-9A-Za-z]+/)).not.toContain(card);
    }
    const showdown = JSON.stringify(t.audit!.events.filter((e) => e.type === "SHOWDOWN"));
    for (const card of hidden) expect(showdown.split(/[^0-9A-Za-z]+/)).not.toContain(card);
  });

  it("chains every transition and seals with a post-hand verification hash that the WebCrypto verifier reproduces", async () => {
    for (let pattern = 0; pattern < 40; pattern++) {
      const stacks = Array.from({ length: 2 + (pattern % 8) }, (_, i) => 40 + ((pattern * 97 + i * 131) % 900));
      let t = startHand(seated(stacks), T0);
      if (pattern % 5 === 1 && t.toActSeat !== null) t = sitOut(t, t.players[t.toActSeat]!.userId, T0 + 500);
      if (pattern % 7 === 2) {
        const bystander = t.players.find((p) => p && p.status === "ACTIVE" && p.seatIndex !== t.toActSeat);
        if (bystander) t = leaveSeat(t, bystander.userId, T0 + 600);
      }
      if (t.phase !== "SHOWDOWN") t = playOut(t, pattern);
      const record = t.audit!;
      expect(record.events.at(-1)!.type).toBe("HAND_SETTLED");
      expect(record.events.at(-2)!.type).toBe("POTS_AWARDED");
      expect(record.settledAt).toMatch(UTC_ISO);
      // Independent recomputation of every link with node:crypto.
      let prev = sha256(genesisPreimage(record));
      record.events.forEach((event, i) => {
        expect(event.seq).toBe(i);
        expect(event.at).toMatch(UTC_ISO);
        expect(event.prevHash).toBe(prev);
        const { hash, ...body } = event;
        expect(hash).toBe(sha256(eventPreimage(record.handId, body)));
        prev = hash;
      });
      expect(record.finalStateHash).toBe(sha256(finalStatePreimage(record.handId, prev, record.events.length, record.settledAt!)));
      expect(await verifyAuditRecord(record, { requireSettled: true })).toEqual({ ok: true });
      // Settlement data in the chain matches the engine's final stacks.
      const settled = record.events.at(-1)!.data as { stacks: { seatIndex: number; stack: number }[]; chipTotal: number };
      for (const { seatIndex, stack } of settled.stacks) {
        // A player who leaves after settlement is cashed out with the settled stack.
        const seated = t.players[seatIndex];
        expect(seated ? seated.stack : t.cashOuts.find((c) => c.userId === `u${seatIndex}`)!.stack).toBe(stack);
      }
      expect(settled.chipTotal).toBe(stacks.reduce((a, b) => a + b, 0));
    }
  });

  it("records every player action and state transition in order", () => {
    const t = playOut(startHand(seated([1000, 1000, 1000]), T0), 1);
    const actions = t.audit!.events.filter((e) => e.type === "PLAYER_ACTION" || e.type === "BLIND_POSTED");
    expect(actions).toHaveLength(t.actions.length);
    actions.forEach((event, i) => {
      expect(event.data.seatIndex).toBe(t.actions[i]!.seatIndex);
      expect(event.phase).toBe(t.actions[i]!.street);
      if (event.type === "PLAYER_ACTION") expect(event.data.action).toBe(t.actions[i]!.action);
    });
    // Phase trail never goes backwards.
    const order = ["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"];
    const phases = t.audit!.events.map((e) => order.indexOf(e.phase));
    expect(phases.every((p, i) => p >= 0 && (i === 0 || p >= phases[i - 1]!))).toBe(true);
    const streets = t.audit!.events.filter((e) => e.type === "STREET_DEALT").map((e) => e.data.street);
    expect(streets).toEqual(["FLOP", "TURN", "RIVER"].slice(0, streets.length));
  });

  it("detects any single tamper: edit, insert, delete, reorder, header change, final hash or settle time", async () => {
    const t = playOut(startHand(seated([1000, 1000, 1000]), T0), 4);
    const record = t.audit!;
    expect((await verifyAuditRecord(record, { requireSettled: true })).ok).toBe(true);
    const tampered: Array<[string, (r: HandAuditRecord) => void]> = [
      ["edit action amount", (r) => { const e = r.events.find((x) => x.type === "BLIND_POSTED")!; e.data.amount = (e.data.amount as number) + 1; }],
      ["edit stack in settlement", (r) => { (r.events.at(-1)!.data.stacks as { stack: number }[])[0]!.stack += 1; }],
      ["edit timestamp", (r) => { r.events[1]!.at = "2030-01-01T00:00:00.000Z"; }],
      ["edit phase", (r) => { r.events[1]!.phase = "FLOP"; }],
      ["delete an event", (r) => { r.events.splice(2, 1); }],
      ["insert an event", (r) => { r.events.splice(2, 0, clone(r.events[2]!)); }],
      ["swap two events", (r) => { [r.events[1], r.events[2]] = [r.events[2]!, r.events[1]!]; }],
      ["truncate the tail", (r) => { r.events.pop(); }],
      ["recompute one hash only", (r) => { r.events[3]!.data.note = "x"; const { hash: _h, ...b } = r.events[3]!; r.events[3]!.hash = sha256(eventPreimage(r.handId, b)); }],
      ["change hand id", (r) => { r.handId = "11111111-1111-4111-8111-111111111111"; }],
      ["change deck commitment", (r) => { r.deckCommitment = "0".repeat(64); }],
      ["change merkle root", (r) => { r.merkleRoot = "f".repeat(64); }],
      ["change previous hand link", (r) => { r.previousHandHash = "a".repeat(64); }],
      ["change start time", (r) => { r.startedAt = "2026-09-24T12:00:00.001Z"; }],
      ["change settle time", (r) => { r.settledAt = "2026-09-24T13:00:00.000Z"; }],
      ["change final hash", (r) => { r.finalStateHash = "b".repeat(64); }],
      ["change rng descriptor", (r) => { (r.rng as unknown as Record<string, string>).source = "Math.random"; }],
      ["non-UTC timestamp", (r) => { r.events[0]!.at = "2026-09-24T14:00:00.000+02:00"; }],
    ];
    for (const [name, mutate] of tampered) {
      const copy = clone(record);
      mutate(copy);
      const result = await verifyAuditRecord(copy, { requireSettled: true });
      if (result.ok) throw new Error(`tamper not detected: ${name}`);
    }
  });

  it("chains consecutive hands at a table through previousHandHash", async () => {
    let t = playOut(startHand(seated([1000, 1000, 1000]), T0));
    const first = clone(t.audit!);
    expect(first.previousHandHash).toBeNull();
    t = playOut(startHand(completeHand(t), T0 + 60_000), 2, T0 + 60_000);
    const second = t.audit!;
    expect(second.previousHandHash).toBe(first.finalStateHash);
    expect(second.handId).not.toBe(first.handId);
    expect(t.auditChainTip).toBe(second.finalStateHash);
    expect((await verifyAuditRecord(second, { requireSettled: true })).ok).toBe(true);
  });

  it("gives regulators a sealed record that recomputes commitment, Merkle root and every dealt card", async () => {
    const t = playOut(startHand(seated([300, 1000, 50, 1000, 120]), T0), 5);
    const sealed = sealedAudit(t.fairness!);
    const report = await verifySealedAudit(t.audit!, sealed);
    expect(report.ok).toBe(true);
    for (const seat of t.dealtSeats) {
      expect(report.holeCards!.find((h) => h.seatIndex === seat)!.cards).toEqual(t.players[seat]!.holeCards);
    }
    expect(report.burns).toEqual(t.burns);

    const swapped = clone(sealed);
    [swapped.deck[50], swapped.deck[51]] = [swapped.deck[51]!, swapped.deck[50]!];
    expect((await verifySealedAudit(t.audit!, swapped)).ok).toBe(false);
    expect((await verifySealedAudit(t.audit!, { ...sealed, deckSalt: "0".repeat(64) })).ok).toBe(false);
    const salts = clone(sealed); salts.merkleSalts[0] = "0".repeat(64);
    expect((await verifySealedAudit(t.audit!, salts)).ok).toBe(false);
    expect((await verifySealedAudit(t.audit!, { ...sealed, handId: "11111111-1111-4111-8111-111111111111" })).ok).toBe(false);
  });

  it("gives each participant a redacted audit that verifies and opens only cards they could see", async () => {
    for (let pattern = 0; pattern < 25; pattern++) {
      let t = startHand(seated([1000, 1000, 1000, 1000]), T0);
      // Capture live evidence exactly as a browser would from its last snapshot.
      const live = new Map<string, ObservedHandEvidence>();
      const liveCards = new Map<string, [Card, Card]>();
      const capture = (table: EngineTable) => {
        for (const p of table.players) {
          if (!p) continue;
          const view = projectTableState(table, p.userId);
          const hero = view.players.find((x) => x.userId === p.userId)!;
          if (!view.fairness) continue;
          if (hero.holeCards) liveCards.set(p.userId, hero.holeCards);
          live.set(p.userId, {
            tableId: table.tableId, handNumber: table.handNumber, userId: p.userId,
            handId: view.fairness.handId, merkleRoot: view.fairness.root, deckCommitment: view.fairness.deckCommitment,
            auditSeq: view.fairness.auditSeq, auditHead: view.fairness.auditHead,
          });
        }
      };
      capture(t);
      for (let turn = 0; t.phase !== "SHOWDOWN" && turn < 200; turn++) {
        const legal = legalActions(t, t.toActSeat!)!;
        const choice = legal.actions[(pattern * 5 + turn) % legal.actions.length]!;
        t = applyAction(t, t.players[t.toActSeat!]!.userId, { action: choice, amount: choice === "RAISE" ? legal.minRaiseTo : choice === "BET" ? legal.minBet : undefined }, T0 + turn * 1_000);
        if (t.phase !== "SHOWDOWN") capture(t);
      }
      const sealed = sealedAudit(t.fairness!);
      for (const seat of t.dealtSeats) {
        const player = t.players[seat]!;
        const audit = participantAudit(t.audit!, sealed, seat);
        // The browser stores only a digest of its own hole cards.
        const evidence: ObservedHandEvidence = { ...live.get(player.userId)!, holeCardsDigest: await holeCardsDigest(t.audit!.handId, liveCards.get(player.userId)!) };
        expect(await verifyParticipantAudit(audit, evidence)).toEqual({ ok: true });
        // Opened cards are exactly: own hole cards, the dealt board, tabled hands.
        const opened = new Set(audit.proofs.map((p) => p.card));
        const entitled = new Set([...player.holeCards!, ...t.board,
          ...t.dealtSeats.filter((s) => t.players[s]!.showedCards).flatMap((s) => t.players[s]!.holeCards!)]);
        expect(opened).toEqual(entitled);
        expect(audit.proofs.map((p) => p.index)).toEqual(participantPositions(t.audit!, seat));
        const tokens = new Set(JSON.stringify(audit).split(/[^0-9A-Za-z]+/));
        for (const card of sealed.deck) if (!entitled.has(card)) expect(tokens.has(card)).toBe(false);

        // Live evidence that disagrees with the record is rejected.
        const other = evidence;
        expect((await verifyParticipantAudit(audit, { ...other, merkleRoot: "0".repeat(64) })).ok).toBe(false);
        expect((await verifyParticipantAudit(audit, { ...other, auditHead: "0".repeat(64) })).ok).toBe(false);
        const wrongCards: [Card, Card] = [t.board[0] ?? sealed.deck[51]!, player.holeCards![1]];
        expect((await verifyParticipantAudit(audit, { ...other, holeCardsDigest: await holeCardsDigest(t.audit!.handId, wrongCards) })).ok).toBe(false);
        // The audit must be the hand, table and seat the user asked about.
        expect((await verifyParticipantAudit(audit, { ...other, handNumber: t.handNumber + 1 })).ok).toBe(false);
        expect((await verifyParticipantAudit(audit, { ...other, tableId: "another-table" })).ok).toBe(false);
        expect((await verifyParticipantAudit(audit, { ...other, userId: "someone-else" })).ok).toBe(false);
      }
    }
  });

  it("rejects participant audits that open extra positions, change a card, or omit a proof", async () => {
    const t = playOut(startHand(seated([1000, 1000, 1000]), T0), 6);
    const sealed = sealedAudit(t.fairness!);
    const seat = t.dealtSeats[0]!;
    const audit = participantAudit(t.audit!, sealed, seat);
    expect((await verifyParticipantAudit(audit)).ok).toBe(true);
    const unauthorized = [...Array(52).keys()].find((i) => !audit.proofs.some((p) => p.index === i))!;
    const { cardProof } = await import("../fairness.js");
    const extra = clone(audit); extra.proofs.push(cardProof(t.fairness!, unauthorized));
    expect((await verifyParticipantAudit(extra)).ok).toBe(false);
    const missing = clone(audit); missing.proofs.pop();
    expect((await verifyParticipantAudit(missing)).ok).toBe(false);
    const wrongCard = clone(audit); wrongCard.proofs[0]!.card = sealed.deck[unauthorized]!;
    expect((await verifyParticipantAudit(wrongCard)).ok).toBe(false);
    const wrongSeat = clone(audit); wrongSeat.viewerSeat = 8;
    expect((await verifyParticipantAudit(wrongSeat)).ok).toBe(false);
    expect(() => participantAudit(t.audit!, sealed, 8)).toThrow();
  });

  it("canonical JSON is deterministic and rejects values that could hash ambiguously", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    for (const bad of [1.5, NaN, Infinity, undefined, { a: undefined }, [1, , 2], new Date(0), 10n, () => 1]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
  });

  it("purges every card secret at Hand Clean-up while keeping the table chain tip", () => {
    const settled = playOut(startHand(seated([1000, 1000, 1000]), T0));
    const clean = completeHand(settled);
    expect(clean.deck).toEqual([]);
    expect(clean.burns).toEqual([]);
    expect(clean.board).toEqual([]);
    expect(clean.fairness).toBeNull();
    expect(clean.audit).toBeNull();
    expect(clean.handChipTotal).toBeNull();
    expect(clean.players.every((p) => !p || p.holeCards === null)).toBe(true);
    expect(clean.auditChainTip).toBe(settled.audit!.finalStateHash);
    expect(JSON.stringify(projectTableState(clean, "u0"))).not.toMatch(/"holeCards":\[/);
  });
});
