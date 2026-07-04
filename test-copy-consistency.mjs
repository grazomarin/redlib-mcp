import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOOK = 'A private, self-hosted window into public Reddit for your AI agent — no account, no API key, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.';

const readme = readFileSync('README.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const skill = readFileSync('skills/setup-redlib/SKILL.md', 'utf8');

// the SAME string in all four framing chokepoints (spec §2)
assert.ok(readme.includes(HOOK), 'README hook');
assert.equal(pkg.description, HOOK, 'package.json description');
assert.equal(server.description, HOOK, 'server.json description');
assert.ok(skill.includes(HOOK), 'SKILL.md frontmatter description');

// framing blocklist over EVERY public surface at once (Plan 1 gate)
execFileSync('node', ['scripts/check-forbidden-words.mjs',
  'README.md', 'package.json', 'server.json', 'skills/setup-redlib/SKILL.md', 'NOTICE',
  'PUBLISHING.md', 'linux/README.md', 'linux/redlib.container']);
console.log('ALL PASS');
