import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export default async function restoreNextEnv() {
  // Next rewrites this tracked reference when the isolated browser build uses
  // its own distDir. Restore only that exact generated line after the suite.
  const path = resolve(__dirname, "../../next-env.d.ts");
  const contents = await readFile(path, "utf8");
  const restored = contents.replace(
    '/// <reference path="./.next-browser-test/types/routes.d.ts" />',
    '/// <reference path="./.next/types/routes.d.ts" />',
  );
  if (restored !== contents) await writeFile(path, restored);
}
