/** Isolated baseline commands. Every child inherits unreachable connection URLs. */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [label, command, ...args] = process.argv.slice(2);
if (!label || !command || !/^[a-z0-9-]+$/.test(label)) throw new Error('Usage: node review/gpt-6.1-sol/run.mjs label executable args...');
const root = 'review/gpt-6.1-sol';
mkdirSync(`${root}/logs`, { recursive: true });
const logfile = `${root}/logs/${label}.txt`;
writeFileSync(logfile, '');
const env = { ...process.env, DATABASE_URL: 'postgresql://review:unused@127.0.0.1:1/review?sslmode=require&sslaccept=strict', DIRECT_URL: 'postgresql://review:unused@127.0.0.1:1/review', DATABASE_TEST_ADMIN_URL: 'postgresql://review:unused@127.0.0.1:1/review', REDIS_URL: '', GAME_ENCRYPTION_KEY: '31'.repeat(32), JWT_ACCESS_SECRET: 'review-access-'.padEnd(64, 'a'), JWT_REFRESH_SECRET: 'review-refresh-'.padEnd(64, 'b'), NODE_ENV: label === 'build' ? 'production' : 'test', POKER_INTEGRATION_TESTS: '0', NEXT_TELEMETRY_DISABLED: '1', TLS_CERT_FILE: '', TLS_KEY_FILE: '', CLIENT_ORIGIN: 'http://localhost:3107', TRUST_PROXY_HOPS: '0' };
const started = Date.now();
if (label === 'direct-tls') env.PATH = 'C:\\Program Files\\Git\\usr\\bin;' + env.PATH;
const child = spawn(command, args, { env, shell: command.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { appendFileSync(logfile, chunk); process.stdout.write(chunk); });
child.on('error', error => { console.error(error.message); appendFileSync(logfile, error.message); });
child.on('close', (code, signal) => {
 const result = { label, command: [command, ...args].join(' '), exitCode: code, signal, durationSeconds: (Date.now() - started) / 1000, log: logfile, isolatedConnections: true };
 appendFileSync(`${root}/verification.ndjson`, JSON.stringify(result) + '\n');
 console.log('\nREVIEW_RESULT ' + JSON.stringify(result));
 process.exitCode = code ?? 1;
});
