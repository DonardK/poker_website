/** Review-only in-memory fault injection. Assertions prove current defects,
 * not acceptance tests. Expected safe behavior is described at each probe.
 * Every connection variable is overridden before any server import. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { io as connect } from 'socket.io-client';
Object.assign(process.env,{NODE_ENV:'test',CLIENT_ORIGIN:'http://localhost:3107',DATABASE_URL:'postgresql://review:unused@127.0.0.1:1/review',DIRECT_URL:'postgresql://review:unused@127.0.0.1:1/review',DATABASE_TEST_ADMIN_URL:'postgresql://review:unused@127.0.0.1:1/review',REDIS_URL:'',TLS_CERT_FILE:'',TLS_KEY_FILE:'',TRUST_PROXY_HOPS:'0',GAME_ENCRYPTION_KEY:'31'.repeat(32),JWT_ACCESS_SECRET:'synthetic-access-'.padEnd(64,'a'),JWT_REFRESH_SECRET:'synthetic-refresh-'.padEnd(64,'b')});
const {prisma}=await import('../../../apps/server/dist/db/prisma.js');
const {TableManager,tableManager}=await import('../../../apps/server/dist/game/manager.js');
const {createApp}=await import('../../../apps/server/dist/app.js');
const {createSocketServer}=await import('../../../apps/server/dist/socket/index.js');
const {signAccessToken,signRefreshToken}=await import('../../../apps/server/dist/auth/jwt.js');
const {encryptState,decryptState}=await import('../../../apps/server/dist/game/encryption.js');
const {logger}=await import('../../../apps/server/dist/logger.js');
const E=await import('../../../packages/engine/dist/index.js');
const {SOCKET_EVENTS,REFRESH_COOKIE_NAME,TABLE_IDLE_TIMEOUT_MS}=await import('../../../packages/shared/dist/index.js');
logger.error=()=>{}; logger.warn=()=>{}; logger.info=()=>{};
const uid='fixture-0'; const sid='synthetic-session';
let user={id:uid,username:'Fixture_0',kind:'HUMAN',role:'PLAYER',bankroll:9000,avatarHue:0};
let session={id:sid,userId:uid,expiresAt:new Date(Date.now()+3600000),createdAt:new Date(),refreshToken:''};
let authFault=false, duplicateUser=false;
prisma.session.findUnique=async()=>{if(authFault)throw new Error('Synthetic database timeout');return {...session,user};};
prisma.user.findUnique=async()=>({...user}); prisma.user.findFirst=async()=>null;
prisma.user.create=async()=>{if(duplicateUser)throw Object.assign(new Error('Synthetic unique violation'),{code:'P2002'});return {...user};};
prisma.session.updateMany=async()=>({count:1}); prisma.session.deleteMany=async()=>({count:1});
prisma.tableSeat.findUnique=async()=>({tableId:'fault-table'});
const observations={};
let row;
function install(t,patch={}) {
 row={id:'fault-table',status:t?.status??'IN_HAND',name:'Synthetic faults',maxSeats:3,smallBlind:5,bigBlind:10,timeBankMs:15000,isPrivate:false,hostId:uid,stateCiphertext:t?encryptState(t,'table:fault-table'):null,...patch};
 prisma.table.findUnique=async()=>structuredClone(row); prisma.table.findMany=async()=>[{id:row.id}];
 prisma.$transaction=async(fn)=>{ let pending=structuredClone(row); const tx={
  $queryRaw:async()=>[{id:row.id}],table:{findUnique:async()=>structuredClone(pending),update:async({data})=>{pending={...pending,...data};}},
  hand:{findFirst:async()=>null},tableSeat:{update:async()=>{}},user:{updateMany:async()=>({count:1})}
 }; const result=await fn(tx);row=pending;return result;};
}
const waiting=(count=3,at=Date.now())=>{let t=E.createTable({tableId:'fault-table',name:'Synthetic faults',maxSeats:3,smallBlind:5,bigBlind:10,timeBankMs:15000,createdAt:at}); for(let i=0;i<count;i++)t=E.sitDown(t,i,{userId:`fixture-${i}`,username:`Fixture_${i}`,kind:'HUMAN',botProfile:null,buyIn:1000,avatarHue:0},at);return t;};
const manager=new TableManager(); manager.stop();
install(null);
await assert.rejects(manager.standUp(row.id,uid),e=>e.code==='RECOVERY_REQUIRED');
observations.missingState={leaveRejected:'RECOVERY_REQUIRED',cashOutImpossible:true};
install(waiting(),{stateCiphertext:'v1.not-valid'});
await assert.rejects(manager.standUp(row.id,uid)); observations.corruptCiphertext={leaveRejected:true};
// Expected: committed clean-up/cash-out must not depend on the next shuffle.
let t=E.startHand(waiting());
while(t.phase!=='SHOWDOWN') t=E.applyAction(t,t.players[t.toActSeat].userId,{action:E.legalActions(t,t.toActSeat).actions.includes('CHECK')?'CHECK':'CALL'});
t.players[2].pendingLeave=true; t.players[2].sittingOut=true; install(t);
const prior=row.stateCiphertext;
const rng=crypto.randomFillSync;
try { crypto.randomFillSync=()=>{throw new Error('Synthetic RNG outage');};syncBuiltinESMExports();
 await assert.rejects(manager.mutate(row.id,current=>E.startHand(E.completeHand(current))));
} finally {crypto.randomFillSync=rng;syncBuiltinESMExports();}
assert.equal(row.stateCiphertext,prior);
observations.nextShuffleFailure={cleanUpRolledBack:true,pendingLeaveStillSeated:decryptState(row.stateCiphertext,'table:fault-table').players[2].pendingLeave};
// Expected: a scheduling failure after commit must not suppress wallet delivery.
let botTurn=E.startHand(waiting());
botTurn.players[botTurn.toActSeat].kind='BOT';
botTurn.players[botTurn.toActSeat].botProfile='MANIAC';install(botTurn);
const priorBotRevision=botTurn.revision;
manager.stopped=false;
try {crypto.randomFillSync=()=>{throw new Error('Synthetic bot RNG outage');};syncBuiltinESMExports();
 await assert.rejects(manager.mutate(row.id,current=>structuredClone(current)),/Synthetic bot RNG outage/);
} finally {crypto.randomFillSync=rng;syncBuiltinESMExports();manager.stop();}
assert.equal(decryptState(row.stateCiphertext,'table:fault-table').revision,priorBotRevision+1);
observations.postCommitBotFailure={mutationReportedFailed:true,stateActuallyCommitted:true,turnTimerArmed:false};
// Expected: both workers apply a shared restart grace deadline.
const originalNow=Date.now;const fixed=originalNow();install(waiting(1,fixed-2*TABLE_IDLE_TIMEOUT_MS));
const fresh=new TableManager();fresh.stop();fresh.resumedAt=fixed;
const old=new TableManager();old.stop();old.resumedAt=fixed-10*TABLE_IDLE_TIMEOUT_MS;
try {Date.now=()=>fixed;await fresh.idleCheck(row.id);assert.equal((await fresh.get(row.id)).closingAt,null);await old.idleCheck(row.id);assert.ok((await fresh.get(row.id)).closingAt>fixed);}
finally {Date.now=originalNow;fresh.stop();old.stop();}
observations.multiWorkerRestart={freshWorkerWouldNotWarn:true,olderWorkerStartedWarning:true};
// Expected: a newer wallet balance cannot be overwritten by an older delivery.
let release;const blocked=new Promise(r=>release=r);let reads=0;const balances=[];
prisma.user.findUnique=async()=>{const n=++reads;if(n===1){await blocked;return {bankroll:9000};}return {bankroll:10000};};
manager.io={to:()=>({emit:(_event,payload)=>balances.push(payload.bankroll)})};
const first=manager.patchBankroll(uid);await Promise.resolve();await manager.patchBankroll(uid);release();await first;
assert.deepEqual(balances,[10000,9000]);observations.walletPatchOrder={receivedBalances:balances,noWalletRevision:true};manager.io=null;
prisma.user.findUnique=async()=>({...user});install(waiting());
const http=createServer(createApp());const sockets=createSocketServer(http);tableManager.stop();
await new Promise(r=>http.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${http.address().port}`;
const request=(path,opts={})=>fetch(base+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json',...opts.headers},body:opts.body??'{}'});
let client;
try {
 const refresh=signRefreshToken(uid,sid);session.refreshToken=crypto.createHash('sha256').update(refresh).digest('hex');
 authFault=true;const response=await request('/auth/refresh',{headers:{Cookie:`${REFRESH_COOKIE_NAME}=${refresh}`}});
 assert.equal(response.status,401);const deleted=/Expires=Thu, 01 Jan 1970/i.test(response.headers.get('set-cookie')??'');assert.ok(deleted);
 observations.refreshDatabaseTimeout={status:response.status,refreshCookieDeleted:deleted};authFault=false;
 // Two tabs share the same cookie. One CAS wins, the other receives a fatal 401.
 prisma.session.updateMany=async({where,data})=>{if(where.refreshToken!==session.refreshToken)return {count:0};Object.assign(session,data);return {count:1};};
 const racing=await Promise.all([request('/auth/refresh',{headers:{Cookie:`${REFRESH_COOKIE_NAME}=${refresh}`}}),request('/auth/refresh',{headers:{Cookie:`${REFRESH_COOKIE_NAME}=${refresh}`}})]);
 assert.deepEqual(racing.map(r=>r.status).sort(),[200,401]);
 observations.multiTabRefresh={statuses:racing.map(r=>r.status).sort(),loserMessage:await racing.find(r=>r.status===401).json()};
 duplicateUser=true;const collision=await request('/auth/guest');assert.equal(collision.status,500);observations.uniqueGuestCollision={status:collision.status};duplicateUser=false;
 // An already-active warning is not replayed on authentication in the lobby.
 install(E.beginIdleWarning(waiting(1),Date.now()+10000));let notices=0;
 client=connect(base,{auth:{token:signAccessToken(uid,user.username,sid)},transports:['websocket'],autoConnect:false,reconnection:true});
 client.on(SOCKET_EVENTS.TABLE_IDLE_NOTICE,()=>notices++);const ready=once(client,SOCKET_EVENTS.AUTH_OK,{signal:AbortSignal.timeout(3000)});client.connect();const [ok]=await ready;await new Promise(r=>setTimeout(r,100));
 assert.equal(ok.activeTableId,'fault-table');assert.equal(notices,0);observations.warningReplay={activeTablePresent:true,warningNoticesAfterAuthentication:notices};
 authFault=true;const gone=once(client,'disconnect',{signal:AbortSignal.timeout(3000)});client.emit(SOCKET_EVENTS.REHYDRATE,{});const [reason]=await gone;authFault=false;await new Promise(r=>setTimeout(r,250));
 assert.equal(reason,'io server disconnect');assert.equal(client.active,false);
 observations.socketDatabaseTimeout={disconnectReason:reason,automaticReconnectionActive:client.active};
 console.log(JSON.stringify({purpose:'Current defects confirmed with in-memory faults; no real database',observations},null,2));
} finally {client?.disconnect();manager.stop();tableManager.stop();await new Promise(r=>sockets.close(r));http.closeAllConnections();await prisma.$disconnect();}
