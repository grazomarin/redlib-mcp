import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOOK = 'A private, self-hosted window into public Reddit for your AI agent — no login, no tracking, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.';

const readme = readFileSync('README.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const skill = readFileSync('skills/setup-redlib/SKILL.md', 'utf8');

// the SAME hook string across all four public surfaces
assert.ok(readme.includes(HOOK), 'README hook');
assert.equal(pkg.description, HOOK, 'package.json description');
assert.ok(server.description.startsWith(HOOK), 'server.json description (hook + trademark disclaimer)');
assert.ok(skill.includes(HOOK), 'SKILL.md frontmatter description');

// copy-tone check over EVERY public surface at once
execFileSync('node', ['scripts/check-forbidden-words.mjs',
  'README.md', 'package.json', 'server.json', 'skills/setup-redlib/SKILL.md', 'NOTICE',
  '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']);
console.log('ALL PASS');
