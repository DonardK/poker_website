/**
 * Fails when apps/edge/prisma/schema.prisma models, enums, or fields differ
 * from apps/server/prisma/schema.prisma. The generator block is the only
 * allowed difference (Workers runtime vs prisma-client-js). Migrations live
 * only under apps/server.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(edgeRoot, "../server/prisma/schema.prisma");
const edgePath = join(edgeRoot, "prisma/schema.prisma");

function body(path) {
  return readFileSync(path, "utf8")
    .replace(/generator\s+client\s*\{[^}]*\}/, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

const server = body(serverPath);
const edge = body(edgePath);
if (server === edge) {
  console.log("schema parity ok");
  process.exit(0);
}

const serverLines = server.split("\n");
const edgeLines = edge.split("\n");
const limit = Math.max(serverLines.length, edgeLines.length);
for (let i = 0; i < limit; i++) {
  if (serverLines[i] !== edgeLines[i]) {
    console.error(`schema parity failed at line ${i + 1}`);
    console.error(`  server: ${serverLines[i] ?? "<missing>"}`);
    console.error(`  edge:   ${edgeLines[i] ?? "<missing>"}`);
    process.exit(1);
  }
}
process.exit(1);
