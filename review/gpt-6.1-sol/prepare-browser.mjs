/** Copies the existing isolated fixture into the permitted review directory.
 * Adds only localhost fault controls; does not import server/config or .env. */
import {readFileSync,writeFileSync} from 'node:fs';
let s=readFileSync('apps/web/test/support/game-server.mjs','utf8');
s=s.replace('let table;','let table;\nlet rotateToken = false; let delayJoin = false;');
s=s.replace("accessToken: 'browser-fixture-token'","accessToken: rotateToken ? 'review-rotated-fixture-token' : 'browser-fixture-token'");
s=s.replace("socket.join(room()); socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero));","socket.join(room()); if (delayJoin) setTimeout(() => socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero)), 1500); else socket.emit(E.STATE_SNAPSHOT, projectTableState(table, hero));");
s=s.replace("commit(recordActivity(applyAction(table, hero, { action: payload.action, amount: payload.amount }), Date.now(), hero));\n    ack({ ok: true });","try { commit(recordActivity(applyAction(table, hero, { action: payload.action, amount: payload.amount }), Date.now(), hero)); ack({ ok: true }); } catch (err) { refuse(engineFailure(err), payload, ack); }");
s=s.replace("server.listen(4107, '127.0.0.1');",`app.post('/__review/rotate', (_req,res)=>{rotateToken=true;delayJoin=true;res.json({ok:true});});
app.post('/__review/wallet', (_req,res)=>{bankroll=10000;io.emit(E.USER_PATCH,{bankroll});res.json({ok:true});});
app.post('/__review/remove-no-pay', (_req,res)=>{while(table.phase!=='SHOWDOWN')table=applyAction(table,table.players[table.toActSeat].userId,{action:legalActions(table,table.toActSeat).actions.includes('CHECK')?'CHECK':'CALL'});table=completeHand(table);res.json({ok:true});});
app.post('/__review/reset', (req,res)=>{rotateToken=false;delayJoin=false;reset(req.body.mode);res.json({ok:true});});
server.listen(4107, '127.0.0.1');`);
writeFileSync('review/gpt-6.1-sol/repro/browser-fixture.mjs',s);
console.log('Prepared review-only browser fixture; existing fixture unchanged.');
