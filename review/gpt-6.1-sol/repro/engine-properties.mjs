/** Review-only property probe. Expected: conserve chips, immutable inputs,
 * private projections, terminating hands, terminal closure and valid audits.
 * Selection PRNG is seeded; production shuffles still use their OS CSPRNG.
 * No database is imported or contacted. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
Object.assign(process.env, { DATABASE_URL:'postgresql://review:unused@127.0.0.1:1/review', DIRECT_URL:'postgresql://review:unused@127.0.0.1:1/review', REDIS_URL:'', GAME_ENCRYPTION_KEY:'31'.repeat(32), JWT_ACCESS_SECRET:'synthetic-access-'.padEnd(64,'a'), JWT_REFRESH_SECRET:'synthetic-refresh-'.padEnd(64,'b'), NODE_ENV:'test' });
const E = await import('../../../packages/engine/dist/index.js');
const { verifyTableCards, verifySealedAudit } = await import('../../../packages/shared/dist/index.js');
const { encryptState, decryptState } = await import('../../../apps/server/dist/game/encryption.js');
let seed = 0x61_50_2026;
const rand = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
let transitions = 0, projections = 0, settled = 0, restarts = 0, rejected = 0;
const total = t => t.players.reduce((s,p) => s+(p?.stack??0)+(t.phase === 'SHOWDOWN' || t.phase==='COMPLETE' ? 0 : p?.committedThisHand??0),0)+t.cashOuts.reduce((s,c)=>s+c.stack,0);
for (let run=0;run<1000;run++) {
  let now = Date.UTC(2026,8,30)+run*1e6;
  let t = E.createTable({ tableId:`fuzz-${run}`,name:'Synthetic property fixture',maxSeats:2+rand(8),smallBlind:5,bigBlind:10,timeBankMs:15000,createdAt:now });
  let funded=0;
  const transition = fn => { const before=JSON.stringify(t); const next=fn(t); assert.equal(JSON.stringify(t),before,'input immutable'); t=next; assert.equal(total(t),funded,'chips including deferred cash-outs conserved'); transitions++; };
  for (let i=0;i<t.maxSeats;i++) { const buyIn=200+rand(1801); funded+=buyIn; transition(x=>E.sitDown(x,i,{userId:`fixture-${i}`,username:`Fixture_${i}`,avatarHue:0,kind:'HUMAN',botProfile:null,buyIn},now)); }
  for (let hand=0;hand<4 && t.status!=='CLOSED';hand++) {
    if (t.players.filter(p=>p&&!p.sittingOut&&p.stack>0).length<2) break;
    transition(x=>E.startHand(x,now));
    for (let step=0;t.phase!=='SHOWDOWN';step++) {
      assert.ok(step<1000,'hand terminates'); now+=10;
      if (rand(20)===0) { const sealed=encryptState(t,`table:${t.tableId}`); assert.deepEqual(decryptState(sealed,`table:${t.tableId}`),t); assert.throws(()=>decryptState(sealed,'table:wrong')); restarts++; }
      if (rand(20)===0) { const returning=t.players.find(p=>p?.sittingOut&&!p.pendingLeave);if(returning&&t.closeReason==null)transition(x=>E.sitIn(x,returning.userId,now)); }
      if (rand(20)===0 && t.closeReason==null) { const empty=t.players.findIndex(p=>p===null);if(empty>=0){const buyIn=200+rand(1801);funded+=buyIn;transition(x=>E.sitDown(x,empty,{userId:`late-${run}-${hand}-${step}`,username:'Late_Fixture',avatarHue:0,kind:'HUMAN',botProfile:null,buyIn},now));} }
      const before=JSON.stringify(t);
      assert.throws(()=>E.applyAction(t,'not-seated',{action:'CALL'},now)); assert.equal(JSON.stringify(t),before); rejected++;
      for(const amount of [0,-1,20.5,NaN,Infinity]) { assert.throws(()=>E.applyAction(t,t.players[t.toActSeat].userId,{action:'CALL',amount},now));assert.equal(JSON.stringify(t),before);rejected++; }
      for (const viewer of [null,t.players[t.toActSeat]?.userId].filter(v=>v!==undefined)) { const p=E.projectTableState(t,viewer,now); assert.ok(await verifyTableCards(p)); assert.ok(p.players.every(row=>!row.holeCards || row.userId===viewer || row.showedCards)); projections++; }
      const actor=t.players[t.toActSeat]; assert.ok(actor && actor.stack>0 && actor.status==='ACTIVE');
      const legal=E.legalActions(t,t.toActSeat); assert.ok(legal);
      const choice=rand(15);
      if (choice===0) transition(x=>E.applyTimeout(x,now));
      else if(choice===1) transition(x=>E.sitOut(x,actor.userId,now));
      else if(choice===2) transition(x=>E.leaveSeat(x,actor.userId,now));
      else if(choice===3) transition(x=>E.closeTable(x,'IDLE',now));
      else { const action=legal.actions[rand(legal.actions.length)]; const intent={action}; if(action==='BET'||action==='RAISE') intent.amount=legal.minRaiseTo+rand(legal.maxRaiseTo-legal.minRaiseTo+1); transition(x=>E.applyAction(x,actor.userId,intent,now)); }
    }
    assert.ok((await verifySealedAudit(t.audit,E.sealedAudit(t.fairness))).ok); assert.ok(E.verifyHandOutcome(t.audit,E.sealedAudit(t.fairness)).ok); settled++;
    transition(x=>E.completeHand(x,now)); transition(x=>E.closeIfEmpty(x,now));
  }
  if(t.status!=='CLOSED') transition(x=>E.closeTable(x,'IDLE',now));
  if(t.phase==='SHOWDOWN') transition(x=>E.completeHand(x,now));
  assert.equal(t.status,'CLOSED'); assert.equal(t.players.filter(Boolean).length,0);
  assert.throws(()=>E.sitDown(t,0,{userId:'late',username:'Late',avatarHue:0,kind:'HUMAN',botProfile:null,buyIn:200},now));
}
console.log(JSON.stringify({ result:'PASS',runs:1000,transitions,projections,settled,restarts,rejected,selectionSeed:'0x61502026',shuffle:'OS CSPRNG; not seeded' },null,2));
