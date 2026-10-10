/** Read-only verification of configured poker storage; never prints cards or secrets. */
import { prisma } from '../apps/server/dist/db/prisma.js';
import { decryptState } from '../apps/server/dist/game/encryption.js';
import { regulatorVerification, sealedAuditContext } from '../apps/server/dist/game/audit.js';

let stage = 'connection';
try {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    stage = 'transport';
    const transport = await tx.$queryRaw`SELECT current_user AS role, ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
    stage = 'table state authentication';
    const tables = await tx.table.findMany({ select: { id: true, stateCiphertext: true } });
    let statesVerified = 0;
    for (const table of tables) {
      if (!table.stateCiphertext) continue;
      const state = decryptState(table.stateCiphertext, `table:${table.id}`);
      if (state.tableId !== table.id) throw new Error('Table state row binding failed');
      statesVerified++;
    }
    stage = 'stored hole card authentication';
    const players = await tx.handPlayer.findMany({ select: {
      seatIndex: true, holeCards: true, encryptedHoleCards: true,
      hand: { select: { tableId: true, handNumber: true } },
    } });
    for (const player of players) {
      if (player.holeCards.length !== 0 || !player.encryptedHoleCards) throw new Error('Unexpected hole card storage');
      const cards = decryptState(player.encryptedHoleCards, `hand:${player.hand.tableId}:${player.hand.handNumber}:seat:${player.seatIndex}`);
      if (!Array.isArray(cards) || cards.length !== 2 || cards.some((card) => !/^[2-9TJQKA][cdhs]$/.test(card)) || cards[0] === cards[1]) {
        throw new Error('Invalid stored hole cards');
      }
    }
    stage = 'hand audit verification';
    const hands = await tx.hand.findMany({
      select: { tableId: true, handNumber: true, handUuid: true, deckCommitment: true, finalStateHash: true, auditRecord: true, auditSealed: true },
      orderBy: [{ tableId: 'asc' }, { handNumber: 'asc' }],
    });
    const tips = new Map();
    let fullAuditsVerified = 0;
    let legacyHands = 0;
    for (const hand of hands) {
      if (!hand.auditRecord || !hand.auditSealed) { legacyHands++; continue; }
      const sealed = decryptState(hand.auditSealed, sealedAuditContext(hand.tableId, hand.handNumber));
      const report = await regulatorVerification(hand, hand.auditRecord, sealed, tips.get(hand.tableId) ?? null);
      if (!report.ok) throw new Error('Stored hand failed regulator verification; inspect privately');
      tips.set(hand.tableId, { handNumber: hand.handNumber, finalStateHash: hand.finalStateHash });
      fullAuditsVerified++;
    }
    return { transport, encryptedStatesAuthenticatedAndBoundToRow: statesVerified, encryptedHoleCardPairsVerified: players.length,
      totalHands: hands.length, fullAuditsVerified, legacyHandsWithoutNewAudit: legacyHands };
  }, { timeout: 20_000, maxWait: 10_000 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Do not serialize Prisma's query context, URLs, records or decrypted data.
  const category = /connect|reach|P1001|permission|denied/i.test(error?.message ?? '') ? 'connection or permission error'
    : /authenticate|decrypt/i.test(error?.message ?? '') ? 'authenticated decryption failed'
    : /row binding/i.test(error?.message ?? '') ? 'table row binding failed'
    : /regulator verification/i.test(error?.message ?? '') ? 'regulator verification failed' : 'other';
  console.error(JSON.stringify({ error: 'Read-only database verification failed', stage, category, type: error?.name, code: error?.code ?? null }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
