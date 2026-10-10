/** Numbered review reads and explicit coverage record. Never read secret files. */
import { readFileSync, appendFileSync } from 'node:fs';
for (const path of process.argv.slice(2)) {
 if ((path.includes('.env') && !path.endsWith('.env.example')) || path.includes('mcp.json')) throw new Error('Secret-bearing file requires redacted inspection');
 const text = readFileSync(path, 'utf8');
 console.log('\nFILE ' + path);
 console.log(text.split(/\r?\n/).map((line, i) => `${i+1}: ${line}`).join('\n'));
 appendFileSync('review/gpt-6.1-sol/reads.ndjson', JSON.stringify({ path, lines: text.split(/\r?\n/).length, at: new Date().toISOString() }) + '\n');
}
