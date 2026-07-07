#!/usr/bin/env node
// Offline unit-test runner: runs every test-*.mjs EXCEPT the live end-to-end (test-mcp.mjs, which
// needs a running Redlib backend on REDLIB_URL — run that one manually with `npm run test:e2e`).
// Exits non-zero if any file fails, so `npm test` and CI actually gate the suite.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE = new Set(["test-mcp.mjs"]); // needs a live Redlib backend serving real data
const files = readdirSync(".").filter((f) => /^test-.*\.mjs$/.test(f) && !LIVE.has(f)).sort();

let failed = 0;
for (const f of files) {
  process.stderr.write(`\n--- ${f} ---\n`);
  try {
    execFileSync("node", [f], { stdio: "inherit" });
  } catch {
    console.error(`FAILED: ${f}`);
    failed++;
  }
}
console.error(`\n${files.length - failed}/${files.length} offline test files passed${failed ? ` (${failed} FAILED)` : ""}. (test-mcp.mjs is a live E2E — run \`npm run test:e2e\` with a backend up.)`);
process.exit(failed ? 1 : 0);
