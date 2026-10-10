// CR-010 recheck: scan player-facing source for a "$" that is not a template-literal "${" opener.
// Read-only: walks source files and prints matching lines (comments stripped).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const roots = ['apps/web/src', 'packages/engine/src', 'packages/shared/src'];
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(code)) return;
      // "$" not followed by "{" and not inside a regex anchor like /^...$/
      const m = code.match(/\$(?!\{)/g);
      if (!m) return;
      if (/\/[^/]*\$\/[gimsuy]*/.test(code) && !/["'`][^"'`]*\$[^{]/.test(code)) return;
      hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
}
roots.forEach(walk);
console.log(hits.length ? hits.join('\n') : 'no bare "$" in player-facing source');
