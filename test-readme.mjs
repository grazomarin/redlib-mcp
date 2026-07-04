import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const md = readFileSync('README.md', 'utf8');
const HOOK = 'A private, self-hosted window into public Reddit for your AI agent — no account, no API key, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.';

assert.ok(md.includes(HOOK), 'README must contain the exact master hook');
assert.ok(/not affiliated with (or endorsed by )?Reddit, Inc\./i.test(md), 'must carry the Reddit trademark disclaimer');
// the four REAL tools (index.ts), not the stale "3 tools" / get_subreddit_hot
for (const t of ['search_reddit', 'get_subreddit_posts', 'get_post', 'get_user_activity'])
  assert.ok(md.includes(t), `README must document tool ${t}`);
assert.ok(!/get_subreddit_hot|3 Powerful Tools|alfafadock/i.test(md), 'stale upstream content (get_subreddit_hot / "3 tools" / alfafadock image) must be gone');
// honest platform labels (§6.5)
assert.ok(/Linux[\s\S]{0,40}Tested/i.test(md) && /Experimental/i.test(md), 'must carry the honest platform table');
assert.ok(md.includes('127.0.0.1'), 'must show the loopback default, not localhost-only');
// no emojis anywhere (Kamran rule) — reject the common emoji ranges
assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(md), 'README must contain no emoji');
// framing gate (Plan 1) must pass on the README
execFileSync('node', ['scripts/check-forbidden-words.mjs', 'README.md']); // throws on a forbidden word
console.log('ALL PASS');
