/** Review-only probes. Expected: the owner must define automatic sit-out;
 * current repeated timeouts keep the absent player eligible for future blinds.
 * Configuration should reject out-of-storage and Node timeout-overflow values.
 * No real database or server process is used. */
import assert from 'node:assert/strict';
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://review:unused@127.0.0.1:1/review',DIRECT_URL:'postgresql://review:unused@127.0.0.1:1/review',DATABASE_TEST_ADMIN_URL:'postgresql://review:unused@127.0.0.1:1/review',REDIS_URL:'',TLS_CERT_FILE:'',TLS_KEY_FILE:'',TRUST_PROXY_HOPS:'0',GAME_ENCRYPTION_KEY:'31'.repeat(32),JWT_ACCESS_SECRET:'synthetic-access-'.padEnd(64,'a'),JWT_REFRESH_SECRET:'synthetic-refresh-'.padEnd(64,'b'),DEFAULT_STARTING_BANKROLL:'2147483648',TURN_TIME_BANK_MS:'2147483648',JWT_ACCESS_TTL:'not-a-duration'});
const E=await import('../../../packages/engine/dist/index.js');
const {env}=await import('../../../apps/server/dist/config.js');
assert.equal(env.DEFAULT_STARTING_BANKROLL,2147483648);assert.equal(env.TURN_TIME_BANK_MS,2147483648);assert.equal(env.JWT_ACCESS_TTL,'not-a-duration');
let t=E.createTable({tableId:'absence',name:'Synthetic absence',maxSeats:2,smallBlind:5,bigBlind:10,timeBankMs:15000,createdAt:Date.now()});
for(let i=0;i<2;i++)t=E.sitDown(t,i,{userId:`fixture-${i}`,username:`Fixture_${i}`,kind:'HUMAN',botProfile:null,buyIn:1000,avatarHue:0});
let timeouts=0;
for(let hand=0;hand<30;hand++) {
 t=E.startHand(t);
 for(let step=0;t.phase!=='SHOWDOWN';step++) {
  assert.ok(step<1000);const actor=t.players[t.toActSeat];
  if(actor.userId==='fixture-0'){t=E.applyTimeout(t);timeouts++;}
  else {const legal=E.legalActions(t,t.toActSeat);t=E.applyAction(t,actor.userId,{action:legal.actions.includes('CHECK')?'CHECK':'CALL'});}
 }
 t=E.completeHand(t);
 assert.equal(t.players[0].sittingOut,false);
}
assert.ok(t.players[0].stack<1000);
console.log(JSON.stringify({configAccepted:{bankrollBeyondPostgresInt:true,timeBankBeyondNodeDelay:true,invalidJwtDuration:true},absence:{hands:30,timeouts,stillSittingIn:!t.players[0].sittingOut,startingStack:1000,remainingStack:t.players[0].stack},classification:'Unpublished house-policy gap; not an engine arithmetic bug'},null,2));
