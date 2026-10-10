#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_NOTICES.md: every third-party package that ships in the
 * PRODUCTION dependency tree (npm workspaces: the server, the web app and the
 * packages they use), with its version, its licence (SPDX expression) and the
 * licence / NOTICE text the package ships, where present.
 *
 * Source of truth: package-lock.json, entries that are not dev-only (`dev`
 * unset). That is the tree `npm ci --omit=dev` installs, including optional
 * platform packages (marked "optional"), whichever machine runs this script.
 * Licence texts are read from node_modules/<package>/ when the package is
 * installed here; an optional package for another platform is listed with the
 * licence from the lockfile and a note that its text was not available.
 * Packages are cross-checked against `npm ls --omit=dev --all --json` (a
 * package npm reports that the lockfile does not have is an error).
 *
 * Licences with obligations beyond keeping a notice are flagged, with what
 * they require: LGPL-3.0-or-later (libvips inside @img/sharp-*, which Next.js
 * pulls in for image optimisation) and CC-BY-4.0 (caniuse-lite's data, via
 * browserslist/Next.js), plus any copyleft or unknown licence that appears.
 *
 * Output is deterministic (sorted, no timestamps), so re-running it on an
 * unchanged lockfile changes nothing.
 * Usage (repository root): node scripts/generate-third-party-notices.mjs [--check]
 *   --check: exit 1 if THIRD_PARTY_NOTICES.md is out of date (for CI).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(root, "THIRD_PARTY_NOTICES.md");
const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const entries = lock.packages ?? {};

/** Licence files a package ships (LICENSE, LICENCE, COPYING, NOTICE, with any extension), sorted. */
function licenceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|notice|third[-_]party[-_]notices?)([-_.].*)?$/i.test(name))
    .filter((name) => { try { return statSync(join(dir, name)).isFile(); } catch { return false; } })
    .sort((a, b) => a.localeCompare(b));
}

function licenceOf(entry, manifest) {
  const raw = entry.license ?? manifest?.license ?? manifest?.licenses;
  if (!raw) return "UNKNOWN";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  return raw.type ?? "UNKNOWN";
}

const nameOf = (path, entry) => entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

// --- the production set ------------------------------------------------------
const packages = new Map(); // key name@version -> record
for (const [path, entry] of Object.entries(entries)) {
  if (!path || entry.link || entry.dev) continue;
  if (!path.includes("node_modules/")) continue; // workspace packages (apps/*, packages/*): ours, UNLICENSED
  const name = nameOf(path, entry);
  const dir = join(root, path);
  const manifestPath = join(dir, "package.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const installed = Boolean(manifest && manifest.version === entry.version);
  const key = `${name}@${entry.version}`;
  const record = packages.get(key) ?? {
    name, version: entry.version, licence: licenceOf(entry, installed ? manifest : null),
    optional: true, installed: false, files: [], homepage: null, repository: null, platform: null,
  };
  record.optional &&= Boolean(entry.optional || entry.devOptional);
  if (entry.os || entry.cpu) record.platform = [...(entry.os ?? []), ...(entry.cpu ?? [])].join("/");
  if (installed && !record.installed) {
    record.installed = true;
    record.files = licenceFiles(dir).map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n").trim() }));
    record.homepage = manifest.homepage ?? null;
    const repo = manifest.repository;
    record.repository = typeof repo === "string" ? repo : repo?.url ?? null;
  }
  packages.set(key, record);
}

// A platform package for another platform that the lockfile lists without a licence
// (e.g. @next/swc-linux-x64-gnu): take the licence of an installed sibling of the
// same family and version (e.g. @next/swc-win32-x64-msvc), and say so.
const PLATFORM_WORD = /[-_](win32|windows|linux|linuxmusl|darwin|freebsd|android|wasm32|sunos|openbsd|netbsd|aix)([-_]|$)/;
for (const r of packages.values()) {
  if (r.licence !== "UNKNOWN" || r.installed) continue;
  const family = r.name.split(PLATFORM_WORD)[0];
  if (family === r.name) continue;
  const sibling = [...packages.values()].find((o) => o.installed && o.version === r.version && o.licence !== "UNKNOWN" && o.name.split(PLATFORM_WORD)[0] === family);
  if (sibling) { r.licence = sibling.licence; r.inferredFrom = sibling.name; }
}

// Optional platform packages that production packages declare but the lockfile lacks
// (the lockfile records only the platforms it was generated on; see .github/workflows/support/platform-binaries.mjs).
const declaredMissing = new Map();
for (const [path, entry] of Object.entries(entries)) {
  if (!path || entry.link || entry.dev || !entry.optionalDependencies) continue;
  for (const [dep, range] of Object.entries(entry.optionalDependencies)) {
    if (Object.keys(entries).some((p) => p.endsWith(`node_modules/${dep}`))) continue;
    declaredMissing.set(dep, { range, by: `${nameOf(path, entry)}@${entry.version}` });
  }
}

// --- cross-check with npm ls ---------------------------------------------------
// One fixed command string (no user input): npm.cmd needs a shell on Windows.
const ls = spawnSync("npm ls --omit=dev --all --json", { cwd: root, encoding: "utf8", shell: true, maxBuffer: 256 * 1024 * 1024 });
const fromNpm = new Set();
try {
  const walk = (deps) => { for (const [name, node] of Object.entries(deps ?? {})) { if (node.version && !node.resolved?.startsWith("file:")) fromNpm.add(`${name}@${node.version}`); walk(node.dependencies); } };
  walk(JSON.parse(ls.stdout).dependencies);
} catch { console.error("[notices] npm ls --omit=dev --all --json gave no readable output; using package-lock.json alone"); }
const workspaceNames = new Set(Object.entries(entries).filter(([p, e]) => p && !p.includes("node_modules/") && !e.link).map(([, e]) => e.name));
const unknown = [...fromNpm].filter((key) => !packages.has(key) && !workspaceNames.has(key.slice(0, key.lastIndexOf("@"))));
if (unknown.length) { console.error(`[notices] npm ls reports production packages missing from package-lock.json:\n  ${unknown.join("\n  ")}`); process.exit(1); }

// --- flags -----------------------------------------------------------------------
const OBLIGATIONS = [
  {
    test: (r) => /LGPL/i.test(r.licence) || /^@img\/sharp-libvips-/.test(r.name),
    title: "LGPL-3.0-or-later: libvips (bundled by @img/sharp-*; sharp is an optional dependency of Next.js)",
    text: [
      "The sharp platform packages ship a prebuilt shared libvips library (and its dependencies) under the GNU Lesser General Public License v3.0 or later. sharp's own JavaScript is Apache-2.0.",
      "Obligations when the web image (or any distributed build) contains them:",
      "- Keep this notice and the LGPL-3.0 and GPL-3.0 licence texts with the distribution (the package's LICENSE file reproduced below; the LGPL text is at https://www.gnu.org/licenses/lgpl-3.0.txt).",
      "- Keep libvips as a separately replaceable shared library (it is: the .so/.dll files inside the @img/sharp-* package); do not statically link it into other code and do not prohibit users from replacing it or reverse engineering for debugging such modifications.",
      "- Make the corresponding libvips source available for the exact version shipped (upstream: https://github.com/libvips/libvips and the build recipe at https://github.com/lovell/sharp-libvips), e.g. by a written offer or by hosting the source next to the image.",
      "- If image optimisation is not needed, Next.js can run without sharp (images.unoptimized, or do not install optional dependencies in the image), which removes this obligation.",
    ],
  },
  {
    test: (r) => /CC-BY-4\.0/i.test(r.licence),
    title: "CC-BY-4.0: caniuse-lite (browser support data used by browserslist / Next.js)",
    text: [
      "The data is from caniuse.com by Alexis Deveria, licensed under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/).",
      "Obligations: keep this attribution (creator, the licence name and link, and a link to the source https://github.com/browserslist/caniuse-lite), and state if the data was modified (it is not). The data is used at build time; little or none of it ships to browsers, but the attribution is kept wherever the package is redistributed (for example inside the web image).",
    ],
  },
];
const COPYLEFT = /(^|[^L])GPL|AGPL|MPL|EPL|CDDL|EUPL|OSL|SSPL|BUSL|CC-BY-SA|CC-BY-NC|UNKNOWN|UNLICENSED|SEE LICENSE/i;

// --- render -------------------------------------------------------------------------
const records = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
const byLicence = new Map();
for (const r of records) byLicence.set(r.licence, (byLicence.get(r.licence) ?? 0) + 1);
const flagged = OBLIGATIONS.map((o) => ({ ...o, packages: records.filter(o.test) }));
const others = records.filter((r) => COPYLEFT.test(r.licence) && !OBLIGATIONS.some((o) => o.test(r)));
const lgplMissing = [...declaredMissing].filter(([name]) => /^@img\/sharp-libvips-/.test(name));
const anchor = (r) => `${r.name}@${r.version}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const out = [];
out.push("# Third-party notices", "");
out.push("This file lists the third-party open-source packages in the production dependency tree of this repository (the game server, the web app and the workspace packages they use), with their licences and the licence and notice texts they ship. Our own code is proprietary (UNLICENSED) and is not listed.", "");
out.push("Generated by `node scripts/generate-third-party-notices.mjs` from `package-lock.json` (entries that are not dev-only), cross-checked with `npm ls --omit=dev --all --json`. Do not edit by hand; re-run the script after any dependency change.", "");
out.push(`- Lockfile SHA-256: \`${createHash("sha256").update(lockText.replace(/\r\n/g, "\n")).digest("hex")}\``);
out.push(`- Packages: ${records.length} (${records.filter((r) => r.optional).length} optional, ${records.filter((r) => !r.installed).length} not installed where this file was generated, so listed with the lockfile's licence only)`, "");
out.push("## Licences with obligations beyond keeping this notice", "");
for (const f of flagged) {
  out.push(`### ${f.title}`, "");
  out.push(`Packages: ${f.packages.length ? f.packages.map((r) => `[\`${r.name}@${r.version}\`](#${anchor(r)}) (${r.licence}${r.platform ? `, ${r.platform}` : ""})`).join(", ") : "none in the lockfile"}`, "");
  if (f === flagged[0] && lgplMissing.length) {
    out.push(`Also declared by sharp for other platforms but missing from package-lock.json (they WILL be in a Linux image once the lockfile lists them): ${lgplMissing.map(([name, info]) => `\`${name}@${info.range}\``).join(", ")}. Same obligations.`, "");
  }
  for (const line of f.text) out.push(line);
  out.push("");
}
if (others.length) {
  out.push("### Other licences to review", "");
  for (const r of others) out.push(`- [\`${r.name}@${r.version}\`](#${anchor(r)}): ${r.licence}`);
  out.push("");
}
out.push("## Licence summary", "", "| Licence | Packages |", "| --- | ---: |");
for (const [licence, count] of [...byLicence].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out.push(`| ${licence} | ${count} |`);
out.push("");
if (declaredMissing.size) {
  out.push("## Optional platform packages declared but absent from package-lock.json", "");
  out.push("Production packages declare these per-platform optional dependencies; the lockfile records only the platforms it was generated on. They are installed on a matching platform only after the lockfile is regenerated (or by `.github/workflows/support/platform-binaries.mjs` in CI). Their licences match their parent package's platform siblings listed below.", "");
  out.push("| Package | Range | Declared by |", "| --- | --- | --- |");
  for (const [name, info] of [...declaredMissing].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`| \`${name}\` | ${info.range} | \`${info.by}\` |`);
  out.push("");
}
out.push("## Packages", "", "| Package | Version | Licence | Notes |", "| --- | --- | --- | --- |");
for (const r of records) {
  const notes = [r.optional ? "optional" : null, r.platform ? `platform ${r.platform}` : null, r.installed ? null : "not installed here", r.inferredFrom ? `licence as ${r.inferredFrom}` : null, r.installed && r.files.length === 0 ? "ships no licence file" : null].filter(Boolean).join("; ");
  out.push(`| [${r.name}](#${anchor(r)}) | ${r.version} | ${r.licence} | ${notes} |`);
}
out.push("", "## Licence texts", "");
for (const r of records) {
  out.push(`### ${r.name}@${r.version}`, "");
  out.push(`<a id="${anchor(r)}"></a>`, "");
  out.push(`- Licence: ${r.licence}${r.inferredFrom ? ` (not in the lockfile; as declared by its installed sibling ${r.inferredFrom}@${r.version})` : ""}`);
  if (r.repository || r.homepage) out.push(`- Source: ${r.repository ?? r.homepage}`);
  if (!r.installed) out.push("- Licence text: not available (optional package for another platform, not installed where this file was generated); see the package on npm.");
  else if (r.files.length === 0) out.push(`- Licence text: the package ships no licence file; the ${r.licence} licence applies as declared in its package.json.`);
  out.push("");
  for (const f of r.files) {
    const fence = f.text.includes("```") ? "~~~~" : "```";
    out.push(`${f.file}:`, "", `${fence}text`, f.text, fence, "");
  }
}
const content = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== content) { console.error("THIRD_PARTY_NOTICES.md is out of date: run node scripts/generate-third-party-notices.mjs"); process.exit(1); }
  console.log("THIRD_PARTY_NOTICES.md is up to date");
} else {
  writeFileSync(OUTPUT, content);
  console.log(`[notices] wrote ${OUTPUT}: ${records.length} packages, ${records.reduce((n, r) => n + r.files.length, 0)} licence/notice files; flagged: ${flagged.map((f) => `${f.packages.length} ${f.title.split(":")[0]}`).join(", ")}${others.length ? `; ${others.length} other to review` : ""}`);
}
