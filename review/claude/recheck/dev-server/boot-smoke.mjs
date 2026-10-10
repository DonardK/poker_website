/**
 * Boots the REAL game-server source (apps/server/src/index.ts, through tsx) the way `npm run dev`
 * does, but against the disposable PostgreSQL that apps/server/test/support/pg.mjs starts (every
 * migration applied, runtime role poker_server) and on 127.0.0.1:4010 (never the owner's 4000).
 * Then it makes the same calls the lobby makes and watches the process for a while, to find out
 * whether the code itself starts, stays up and answers.
 *
 * Run from apps/server:
 *   node test/support/pg.mjs --exec "node ../../review/claude/recheck/dev-server/boot-smoke.mjs"
 *
 * Safety: refuses to run unless DATABASE_URL is on 127.0.0.1 (pg.mjs --exec sets it to the
 * disposable cluster, and dotenv never overrides a variable that is already set).
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const dbUrl = process.env.DATABASE_URL ?? '';
let dbHost = '';
try { dbHost = new URL(dbUrl).hostname; } catch { /* handled below */ }
if (dbHost !== '127.0.0.1') {
  console.error('refusing to run: DATABASE_URL is not the disposable loopback database');
  process.exit(2);
}

const PORT = 4010;
const base = `http://127.0.0.1:${PORT}`;
const DEV_ORIGIN = 'http://localhost:3000';
const ansi = /\u001b\[[0-9;]*m/g;
const output = [];
let exit = null;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const collect = (chunk) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) output.push(line.replace(ansi, '')); };
child.stdout.on('data', collect);
child.stderr.on('data', collect);
child.on('exit', (code, signal) => { exit = { code, signal }; });

const get = async (path, init = {}) => {
  try {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let body = text; try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) { return { error: String(err?.cause?.code ?? err?.message ?? err) }; }
};

const result = { startedListening: false, steps: {} };
const started = Date.now();
while (!exit && Date.now() - started < 90_000) {
  const health = await get('/api/health');
  if (health.status === 200) { result.startedListening = true; result.secondsToListen = Math.round((Date.now() - started) / 100) / 10; break; }
  await sleep(500);
}

if (result.startedListening) {
  result.steps.ready = await get('/api/ready').then((r) => ({ status: r.status, body: r.body }));
  const guestBody = JSON.stringify({ acceptTerms: true, confirmAge: true, termsVersion: '2026-10-01' });
  const guest = await get('/api/auth/guest', { method: 'POST', body: guestBody, headers: { 'Content-Type': 'application/json', Origin: DEV_ORIGIN } });
  result.steps.guestFromDevOrigin = { status: guest.status, error: guest.error, gotToken: Boolean(guest.body?.accessToken), username: guest.body?.user?.username };
  const token = guest.body?.accessToken;
  if (token) {
    const tables = await get('/api/tables', { headers: { Authorization: `Bearer ${token}`, Origin: DEV_ORIGIN } });
    result.steps.lobbyList = { status: tables.status, count: Array.isArray(tables.body) ? tables.body.length : tables.body?.tables?.length ?? null };
    const me = await get('/api/auth/me', { headers: { Authorization: `Bearer ${token}`, Origin: DEV_ORIGIN } });
    result.steps.me = { status: me.status };
  }
  // What a browser on a DIFFERENT origin sees (e.g. the site opened as 127.0.0.1:3000 or a LAN address).
  for (const origin of [DEV_ORIGIN, 'http://127.0.0.1:3000']) {
    const pre = await get('/api/auth/guest', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    result.steps[`preflightFrom_${origin}`] = { status: pre.status, allowOrigin: pre.headers?.['access-control-allow-origin'] ?? null };
    const post = await get('/api/auth/guest', { method: 'POST', body: guestBody, headers: { 'Content-Type': 'application/json', Origin: origin } });
    result.steps[`guestFrom_${origin}`] = { status: post.status, error: post.body?.error ?? post.error };
  }
  // Does it stay up? (unhandled rejections and uncaught errors exit the process on purpose)
  await sleep(20_000);
  result.stillRunningAfter20s = exit === null;
}

result.exited = exit;
if (!child.killed && exit === null) child.kill();
await sleep(500);
console.log(JSON.stringify(result, null, 2));
console.log('--- last server output (' + Math.min(output.length, 40) + ' of ' + output.length + ' lines) ---');
console.log(output.slice(-40).join('\n'));
process.exit(result.startedListening && result.stillRunningAfter20s ? 0 : 1);
