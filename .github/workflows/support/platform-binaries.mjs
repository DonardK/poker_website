#!/usr/bin/env node
/**
 * CI helper: install the native platform packages that package-lock.json is
 * missing for THIS platform.
 *
 * Why: the lockfile was generated on Windows with an existing node_modules,
 * and npm then records only the optional platform packages it had installed
 * (npm/cli#4828). For example it lists lightningcss-win32-x64-msvc and
 * @tailwindcss/oxide-win32-x64-msvc but not their linux-x64 counterparts, so
 * on ubuntu-latest `npm ci` installs no native binding and the web build fails
 * with "Cannot find module ...linux-x64-gnu". The permanent fix is to
 * regenerate the lockfile so it lists every platform (`npm install` with
 * `--os`/`--cpu` for each target, or a fresh install on npm >= 10.9), then
 * delete this step.
 *
 * What it does: for every package in the lockfile that declares
 * optionalDependencies, find the optional dependencies named for this
 * platform (e.g. "linux" + "x64", glibc rather than musl) that the lockfile
 * does not contain and are not installed, and install exactly the versions the
 * parent declares with `npm install --no-save` (package.json and the lockfile
 * are left untouched). Prints what it installs; --dry-run only prints.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const platform = process.env.TARGET_PLATFORM || process.platform;
const arch = process.env.TARGET_ARCH || process.arch;
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};

const words = (name) => name.toLowerCase().split(/[^a-z0-9]+/);
const platformWord = { win32: ["win32", "windows"], linux: ["linux"], darwin: ["darwin"] }[platform] ?? [platform];
function forThisPlatform(name) {
  const w = words(name);
  if (!platformWord.some((p) => w.includes(p)) || !w.includes(arch)) return false;
  if (platform === "linux" && (w.includes("musl") || w.includes("musleabihf"))) return false; // ubuntu is glibc
  return true;
}

const wanted = new Map();
for (const [path, entry] of Object.entries(packages)) {
  if (!path || entry.link || !entry.optionalDependencies) continue;
  const base = path.slice(0, path.lastIndexOf("node_modules/") >= 0 ? path.lastIndexOf("node_modules/") : 0);
  for (const [dep, range] of Object.entries(entry.optionalDependencies)) {
    if (!forThisPlatform(dep)) continue;
    const candidates = [`${path}/node_modules/${dep}`, `${base}node_modules/${dep}`, `node_modules/${dep}`];
    if (candidates.some((p) => packages[p])) continue; // the lockfile already has it: npm ci installed it
    if (existsSync(join(root, "node_modules", dep, "package.json"))) continue;
    wanted.set(dep, range);
  }
}

if (wanted.size === 0) { console.log(`[platform-binaries] nothing missing for ${platform}-${arch}`); process.exit(0); }
const specs = [...wanted].map(([name, range]) => `${name}@${range}`);
console.log(`[platform-binaries] missing from package-lock.json for ${platform}-${arch}:\n  ${specs.join("\n  ")}`);
if (dryRun) process.exit(0);
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-save", "--no-audit", "--no-fund", ...specs], { stdio: "inherit", shell: process.platform === "win32" });
