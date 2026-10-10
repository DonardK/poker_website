#!/usr/bin/env node
/** Turn Wrangler preview logs into a pull-request comment body. URLs only. */
import { readFileSync, writeFileSync } from "node:fs";

const logPath = process.argv[2];
const outPath = process.argv[3];
if (!logPath || !outPath) {
  console.error("usage: node preview-comment.mjs <wrangler-log> <comment.json>");
  process.exit(2);
}

const log = readFileSync(logPath, "utf8");
const urls = [...new Set([...log.matchAll(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/g)].map((match) => match[0]))];
const lines = [
  "<!-- poker-cloudflare-preview -->",
  "Preview workers for this pull request. They use the Wrangler `preview` environment and its Hyperdrive config. This job does not receive NEON_DIRECT_URL.",
  "",
  ...(urls.length
    ? urls.map((url) => `- ${url}`)
    : ["Wrangler did not print a workers.dev URL. The deploy log lists the host."]),
];
writeFileSync(outPath, JSON.stringify({ body: lines.join("\n") }));
