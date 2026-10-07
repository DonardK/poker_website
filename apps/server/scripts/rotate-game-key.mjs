#!/usr/bin/env node
/**
 * Re-encrypts every Table.stateCiphertext under the ACTIVE game encryption key.
 *
 *   node scripts/rotate-game-key.mjs --database-url "<admin URL>" [--apply] [--batch-size 100]
 *
 * DRY RUN BY DEFAULT: without --apply it only reads, decrypts and reports what
 * it would rewrite. Run `npm run build -w @poker/server` first (it imports dist/).
 *
 * Inputs, all explicit:
 * - --database-url: an ADMINISTRATOR connection URL, passed on the command
 *   line. This script NEVER reads .env (no dotenv, no config.ts import), so it
 *   cannot silently act on whatever database a .env file points at.
 * - The key ring from this process's environment, exactly as the server reads
 *   it: GAME_ENCRYPTION_KEYS ("kid:hex64,..."), GAME_ENCRYPTION_ACTIVE_KEY_ID
 *   and/or the legacy GAME_ENCRYPTION_KEY (key id "k0", which wrote every "v1."
 *   value). Export them in the shell that runs the script.
 *
 * Rotation procedure:
 *   1. Generate a new key, add it to GAME_ENCRYPTION_KEYS on EVERY server and
 *      make it GAME_ENCRYPTION_ACTIVE_KEY_ID; keep the old key(s) in the ring.
 *      Deploy. New writes now use the new key; old values still decrypt.
 *   2. Run this script (dry run, then --apply) with the same ring.
 *   3. Keep the old keys in the ring. Hand history is APPEND-ONLY: sealed
 *      audits (Hand.auditSealed) and encrypted hole cards written under an old
 *      key are never rewritten, and they stay readable through the key ring
 *      for as long as the key that wrote them remains in it. Remove a key only
 *      when no retained record still uses it.
 *
 * Concurrency: each row is rewritten with a compare-and-set on its current
 * ciphertext (UPDATE ... WHERE id = $1 AND "stateCiphertext" = $old). If a
 * running server saved the table meanwhile (under the active key, after step
 * 1), the update matches nothing and the newer state is kept: the script never
 * overwrites a live save with an older snapshot. Each new ciphertext is
 * decrypted and compared with the original plaintext before it is written.
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const keyRingModule = pathToFileURL(resolve(here, "../dist/security/key-ring.js")).href;

/** Parses argv; returns { databaseUrl, apply, batchSize } or throws a usage error. */
export function parseArgs(argv) {
  const out = { databaseUrl: undefined, apply: false, batchSize: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--dry-run") out.apply = false;
    else if (arg === "--database-url") out.databaseUrl = argv[++i];
    else if (arg.startsWith("--database-url=")) out.databaseUrl = arg.slice("--database-url=".length);
    else if (arg === "--batch-size") out.batchSize = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg.split("=")[0]}`);
  }
  if (!out.databaseUrl) throw new Error("--database-url <administrator connection URL> is required (this script never reads .env)");
  let url;
  try { url = new URL(out.databaseUrl); } catch { throw new Error("--database-url is not a valid URL"); }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("--database-url must be a postgresql:// URL");
  if (!Number.isInteger(out.batchSize) || out.batchSize < 1 || out.batchSize > 1000) throw new Error("--batch-size must be an integer from 1 to 1000");
  return out;
}

/**
 * Re-encrypts table states. `db` needs table.findMany and table.updateMany
 * (a PrismaClient, or a fake in tests). Returns counts; never throws for a
 * single bad row (it is counted in `failed` and left untouched).
 */
export async function rotateTableStates({ db, ring, apply, batchSize = 100, log = () => {} }) {
  const { ciphertextKeyId, decryptWithRing, encryptWithRing } = await import(keyRingModule);
  const counts = { scanned: 0, current: 0, rotated: 0, wouldRotate: 0, changedConcurrently: 0, failed: 0 };
  let lastId = undefined;
  for (;;) {
    const rows = await db.table.findMany({
      where: { stateCiphertext: { not: null }, ...(lastId === undefined ? {} : { id: { gt: lastId } }) },
      select: { id: true, stateCiphertext: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      counts.scanned += 1;
      const context = `table:${row.id}`;
      if (ciphertextKeyId(row.stateCiphertext) === ring.activeKeyId && row.stateCiphertext.startsWith("v2.")) { counts.current += 1; continue; }
      let plain; let next;
      try {
        plain = decryptWithRing(ring, row.stateCiphertext, context);
        next = encryptWithRing(ring, plain, context);
        // Paranoia: the new value must decrypt to exactly the same state.
        if (JSON.stringify(decryptWithRing(ring, next, context)) !== JSON.stringify(plain)) throw new Error("round trip mismatch");
      } catch (err) {
        counts.failed += 1;
        log(`table ${row.id}: cannot re-encrypt (${err instanceof Error ? err.message.slice(0, 120) : "error"}); left unchanged`);
        continue;
      }
      if (!apply) { counts.wouldRotate += 1; continue; }
      const result = await db.table.updateMany({ where: { id: row.id, stateCiphertext: row.stateCiphertext }, data: { stateCiphertext: next } });
      if (result.count === 1) counts.rotated += 1;
      else counts.changedConcurrently += 1;
    }
  }
  return counts;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  const { parseKeyRing } = await import(keyRingModule);
  let ring;
  try {
    ring = parseKeyRing({ keys: process.env.GAME_ENCRYPTION_KEYS, legacyKey: process.env.GAME_ENCRYPTION_KEY, activeKeyId: process.env.GAME_ENCRYPTION_ACTIVE_KEY_ID });
  } catch (err) { console.error(`Key ring: ${err.message}`); process.exit(2); }
  const host = new URL(args.databaseUrl).host;
  console.log(`${args.apply ? "APPLY" : "DRY RUN"}: re-encrypting Table.stateCiphertext on ${host} under key "${ring.activeKeyId}" (ring: ${[...ring.keys.keys()].join(", ")})`);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: args.databaseUrl });
  try {
    const counts = await rotateTableStates({ db, ring, apply: args.apply, batchSize: args.batchSize, log: (line) => console.log(line) });
    console.log(JSON.stringify(counts));
    if (!args.apply) console.log("Dry run only; re-run with --apply to write.");
    process.exitCode = counts.failed > 0 ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`rotate-game-key failed: ${err instanceof Error ? err.name : "error"}`); process.exit(1); });
}
