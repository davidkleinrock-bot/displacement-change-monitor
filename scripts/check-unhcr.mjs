// Tells whether UNHCR (or IDMC via UNHCR) has published new or revised figures since the last download.
// Usage: node scripts/check-unhcr.mjs
// Prints "changed" or "unchanged". In GitHub Actions it also sets the step output changed=true|false.

import { readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./unhcr-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  let stored = null;
  try {
    stored = JSON.parse(await readFile(join(ROOT, "data", "raw", "manifest.json"), "utf8")).fingerprint ?? null;
  } catch { /* no download yet */ }
  const current = await fingerprint();
  const changed = current !== stored;
  console.log(changed ? `changed (stored ${stored ?? "none"}, now ${current})` : `unchanged (${current})`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
