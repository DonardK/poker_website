/**
 * Fails when the shared ledger client differs between the two workspaces:
 * apps/edge/src/money/{amounts,flows,ledger}.ts must be byte-identical to
 * apps/server/src/money/ (docs/money/WALLET.md section 8.1). The server copy
 * is the one the real-PostgreSQL suites exercise (npm run test:db); the edge
 * copy is the one the Workers run. Line endings are normalised first, so a
 * Windows checkout (core.autocrlf) compares like CI. keys.ts and tx.ts are
 * edge-only and not compared.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = ["amounts.ts", "flows.ts", "ledger.ts"];

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

let failed = false;
for (const name of SHARED) {
  const serverPath = join(edgeRoot, "../server/src/money", name);
  const edgePath = join(edgeRoot, "src/money", name);
  const server = read(serverPath);
  const edge = read(edgePath);
  if (server === edge) continue;
  failed = true;
  const serverLines = server.split("\n");
  const edgeLines = edge.split("\n");
  const limit = Math.max(serverLines.length, edgeLines.length);
  for (let i = 0; i < limit; i++) {
    if (serverLines[i] !== edgeLines[i]) {
      console.error(`money parity failed: ${name} differs at line ${i + 1}`);
      console.error(`  server: ${serverLines[i] ?? "<missing>"}`);
      console.error(`  edge:   ${edgeLines[i] ?? "<missing>"}`);
      break;
    }
  }
}
if (failed) {
  console.error("Make the same change in apps/server/src/money and apps/edge/src/money.");
  process.exit(1);
}
console.log(`money parity ok (${SHARED.join(", ")})`);
