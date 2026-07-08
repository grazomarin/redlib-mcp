import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'copy-tone-'));
const clean = join(dir, 'clean.md'); writeFileSync(clean, 'Read public Reddit via a self-hosted frontend.');
const dirty = join(dir, 'dirty.md'); writeFileSync(dirty, 'This tool helps you bypass Reddit blocks.');

const run = (f) => new Promise((res) => execFile('node', ['scripts/check-forbidden-words.mjs', f], (err) => res(err ? err.code : 0)));
assert.equal(await run(clean), 0, 'clean file should pass');
assert.notEqual(await run(dirty), 0, 'dirty file should fail');
console.log('ALL PASS');
