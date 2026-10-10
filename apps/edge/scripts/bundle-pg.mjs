import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(root, "../.tmp/pg.mjs");

/** ESM build of `pg` so the workers vitest runner does not parse its CJS as a script. */
export async function bundlePg() {
  mkdirSync(dirname(outfile), { recursive: true });
  const require = createRequire(import.meta.url);
  const builtins = [
    "assert", "async_hooks", "buffer", "crypto", "dns", "events", "fs", "net", "os",
    "path", "perf_hooks", "stream", "string_decoder", "tls", "util", "zlib",
  ];
  await build({
    entryPoints: [require.resolve("pg")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    conditions: ["workerd", "node", "require", "default"],
    external: ["cloudflare:sockets", ...builtins.flatMap((name) => [name, `node:${name}`])],
    banner: {
      js: `import events from "node:events";
import crypto from "node:crypto";
import util from "node:util";
import * as utilTypes from "node:util/types";
import fs from "node:fs";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import stream from "node:stream";
import stringDecoder from "node:string_decoder";
import path from "node:path";
const require = (id) => {
  const table = {
    events, crypto, util, fs, dns, net, tls, stream, path,
    "node:events": events, "node:crypto": crypto, "node:util": util,
    "node:fs": fs, "node:dns": dns, "node:net": net, "node:tls": tls,
    "node:stream": stream, "node:path": path, "util/types": utilTypes,
    string_decoder: stringDecoder, "node:string_decoder": stringDecoder,
  };
  if (Object.prototype.hasOwnProperty.call(table, id)) return table[id];
  const error = new Error("Cannot find module '" + id + "'");
  error.code = "MODULE_NOT_FOUND";
  throw error;
};`,
    },
    logLevel: "warning",
  });
  return outfile;
}
