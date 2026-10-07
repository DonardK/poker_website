/**
 * Recheck (legal-compliance group), static + in-process, no database:
 *  1. F02: does any server module outside src/money import the ledger?
 *  2. F06 / new finding: is gameConfig (ENABLE_LEGACY_BOTS, personal time
 *     bank D4) read by anything? What does the server's createTable call give
 *     a new table?
 *  3. F12 / new finding: tables created by the migrations versus the
 *     privilege matrix in test/db/privileges.test.mjs.
 *
 * SAFETY: sets DATABASE_URL/DIRECT_URL to a dead loopback address BEFORE
 * importing apps/server (config.ts loads .env without overriding). Prints no
 * environment values. Usage (repository root):
 *   node review/claude/recheck/legal-compliance/wiring-and-migrations.mjs
 */
process.env.DATABASE_URL = 'postgresql://review:unused@127.0.0.1:1/review';
process.env.DIRECT_URL = 'postgresql://review:unused@127.0.0.1:1/review';
process.env.REDIS_URL = '';
process.env.ENABLE_LEGACY_BOTS = 'false';
delete process.env.TIME_BANK_INITIAL_MS; delete process.env.TIME_BANK_MAX_MS; delete process.env.TIME_BANK_REFILL_MS; delete process.env.TIME_BANK_REFILL_EVERY_HANDS;

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
const serverSrc = walk(join(root, 'apps/server/src')).filter((p) => p.endsWith('.ts'));

// 1. ledger usage
const ledgerUsers = serverSrc.filter((p) => !p.includes(`${join('src', 'money')}`) && /from\s+["'][^"']*money\//.test(readFileSync(p, 'utf8')));
console.log('[F02] server modules outside src/money that import money/*:', ledgerUsers.length ? ledgerUsers.map((p) => relative(root, p)) : 'none');
const bankrollWrites = serverSrc.flatMap((p) => readFileSync(p, 'utf8').split('\n').map((line, i) => [p, i + 1, line]))
  .filter(([, , line]) => /bankroll:\s*\{\s*(increment|decrement)/.test(line) || /bankroll:\s*env\.DEFAULT_STARTING_BANKROLL/.test(line));
console.log('[F02] direct User.bankroll writes:', bankrollWrites.map(([p, n]) => `${relative(root, p).replace(/\\/g, '/')}:${n}`).join(', '));

// 2. gameConfig wiring
const { gameConfig } = await import('../../../../apps/server/dist/config.js');
console.log('[F06] gameConfig (ENABLE_LEGACY_BOTS=false):', JSON.stringify(gameConfig));
const readers = serverSrc.filter((p) => !p.endsWith('config.ts') && /\bgameConfig\b|enableLegacyBots|extraTimeBank/.test(readFileSync(p, 'utf8')));
console.log('[F06] server modules reading gameConfig / enableLegacyBots / extraTimeBank:', readers.length ? readers.map((p) => relative(root, p)) : 'none');
const manager = readFileSync(join(root, 'apps/server/src/game/manager.ts'), 'utf8');
const call = manager.split('\n').map((l, i) => [i + 1, l]).find(([, l]) => /createTable\(\{/.test(l));
console.log(`[F06] manager.ts:${call[0]} createTable args:`, call[1].trim().replace(/^.*createTable\(/, 'createTable('));
const { createTable } = await import('../../../../packages/engine/dist/index.js');
const t = createTable({ tableId: 'x', name: 'x', maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 20_000, createdAt: Date.now() });
console.log('[F06] engine table from those args: extraTimeBank =', JSON.stringify(t.extraTimeBank));
const botBranch = manager.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /actor\.kind === "BOT"|decideBotAction\(table\)/.test(l));
console.log('[F06] bot scheduling lines (no flag check):', botBranch.map(([n, l]) => `${n}: ${l.trim()}`).join(' | '));

// 3. migrations vs privilege matrix
const migDir = join(root, 'apps/server/prisma/migrations');
const created = [];
for (const name of readdirSync(migDir).sort()) {
  const file = join(migDir, name, 'migration.sql');
  try { for (const m of readFileSync(file, 'utf8').matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?public"?\.)?"([^"]+)"/gi)) created.push([m[1], name]); } catch { /* not a migration dir */ }
}
const priv = readFileSync(join(root, 'apps/server/test/db/privileges.test.mjs'), 'utf8');
const expectedBlock = priv.slice(priv.indexOf('const EXPECTED = {'), priv.indexOf('};', priv.indexOf('const EXPECTED = {')));
const expected = [...expectedBlock.matchAll(/^\s*([A-Za-z_]+):/gm)].map((m) => m[1]);
const missing = created.filter(([table]) => !expected.includes(table));
console.log('[F12] tables created by migrations:', created.map(([t, m]) => `${t}(${m.slice(0, 14)})`).join(', '));
console.log('[F12] tables missing from privileges.test.mjs EXPECTED:', missing.length ? missing.map(([t, m]) => `${t} (${m})`) : 'none');
console.log('[F12] mtimes: privileges.test.mjs', statSync(join(root, 'apps/server/test/db/privileges.test.mjs')).mtime.toISOString(),
  '| game_reliability migration', statSync(join(migDir, '20261003100000_game_reliability', 'migration.sql')).mtime.toISOString());
