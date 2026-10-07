/** Read-only tree fingerprint and coverage inventory. Never prints source/secrets. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const base = 'review/gpt-6.1-sol';
mkdirSync(base, { recursive: true });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 30_000_000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
const exclusions = new Set(['node_modules', '.git', '.agents', '.codex', '.aws', '.npm-cache', 'dist', '.next', '.next-dev', '.next-browser-test', 'coverage', 'test-results', 'playwright-report', 'review']);
const inventory = [];
function walk(dir = '.') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replaceAll('\\', '/').replace(/^\.\//, '');
    if (entry.isDirectory()) { if (!exclusions.has(entry.name)) walk(path); }
    else if (!entry.name.endsWith('.log') && !entry.name.includes('.tsbuildinfo') && (!entry.name.startsWith('.env') || entry.name === '.env.example') && !entry.name.startsWith('.DS_')) inventory.push(path);
  }
}
walk();
const fingerprints = Object.fromEntries([...tracked, ...untracked].filter(path => existsSync(path)).map(path => [path, sha(readFileSync(path))]));
const result = { capturedAt: new Date().toISOString(), head: git('rev-parse', 'HEAD').trim(), diffSHA256: sha(git('diff', 'HEAD')), initialStatus: git('status', '--porcelain=v1'), diffStat: git('diff', 'HEAD', '--stat'), untracked, inventory: inventory.sort(), fingerprints, node: process.version, platform: process.platform, arch: process.arch };
if (!existsSync(join(base, 'baseline-tree.json'))) writeFileSync(join(base, 'baseline-tree.json'), JSON.stringify(result, null, 2));
else writeFileSync(join(base, 'final-tree.json'), JSON.stringify(result, null, 2));
writeFileSync(join(base, 'coverage.json'), JSON.stringify(inventory.sort().map(path => ({ path, status: 'NOT REVIEWED', findings: [], note: '' })), null, 2));
console.log(JSON.stringify({ head: result.head, diffSHA256: result.diffSHA256, files: inventory.length, tracked: tracked.length, untracked: untracked.length, node: result.node, platform: result.platform }, null, 2));
