#!/usr/bin/env node
// Framing gate (spec §2). Fails if inducement language appears in public text.
import { readFileSync } from 'node:fs';

const FORBIDDEN = [
  /bypass(ing)?\s+reddit/i, /evade|circumvent/i, /get(ting)? past the 403/i,
  /for ai agents reddit blocks/i, /reddit blocks agents/i,
  /scrape at scale/i, /\bharvest\b/i, /\bdataset\b/i,
];
const files = process.argv.slice(2);
const targets = files.length ? files : ['README.md', 'package.json', 'skills/setup-redlib/SKILL.md'];

let hits = 0;
for (const f of targets) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; } // missing files skipped (not yet created)
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) { console.error(`FORBIDDEN framing in ${f}: "${m[0]}"`); hits++; }
  }
}
if (hits) { console.error(`\n${hits} forbidden-framing hit(s). See spec §2/§9.`); process.exit(1); }
console.log('framing check: clean');
