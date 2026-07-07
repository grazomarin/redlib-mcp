import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const s = readFileSync('skills/setup-redlib/SKILL.md', 'utf8');
const HOOK = 'A private, self-hosted window into public Reddit for your AI agent — no login, no tracking, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.';

// frontmatter: name + description (description = the master hook)
const fm = s.match(/^---\n([\s\S]*?)\n---/);
assert.ok(fm, 'SKILL.md must open with YAML frontmatter');
assert.ok(/name:\s*setup-redlib/.test(fm[1]), 'frontmatter name: setup-redlib');
assert.ok(fm[1].includes(HOOK), 'frontmatter description is the master hook (verbatim)');

// body drives the CLI + gated self-heal + the enum
assert.ok(/redlib-mcp setup/.test(s), 'drives `redlib-mcp setup`');
assert.ok(/redlib-mcp doctor/.test(s), 'self-heal runs `redlib-mcp doctor`');
// ALL FIVE Plan 1 enum kinds must have self-heal/reporting guidance — a skill missing REDLIB_DOWN
// or CONTENT_UNAVAILABLE would otherwise false-pass.
for (const k of ['RATE_LIMITED', 'UPSTREAM_TOKEN_STALE', 'REDLIB_DOWN', 'CONTENT_UNAVAILABLE', 'PARSE_ERROR'])
  assert.ok(s.includes(k), `self-heal references the ${k} enum kind`);
assert.ok(/register/i.test(s) && /client/i.test(s), 'instructs registering the MCP into the caller client');
assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(s), 'SKILL.md must contain no emoji');
execFileSync('node', ['scripts/check-forbidden-words.mjs', 'skills/setup-redlib/SKILL.md']); // framing gate
console.log('ALL PASS');
