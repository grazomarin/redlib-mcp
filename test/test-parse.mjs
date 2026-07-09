import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parsePostDetails, pruneBFS, nextAfter } from '../dist/parse.js';
import { parsePortFlag } from '../dist/cli.js';

// Exercise the REAL parser (index.ts's core, now in parse.ts) against the captured fixture —
// not a hand-rolled copy. A parser regression now fails offline instead of only in the live E2E.
const html = readFileSync(new URL('./sample-post.html', import.meta.url), 'utf8');

// --- real parser against the fixture ---
const full = parsePostDetails(html, 10_000, 'http://127.0.0.1:8080');
assert.ok(typeof full.title === 'string' && full.title.length > 0, 'post has a non-empty title');
assert.ok(typeof full.comments_in_page === 'number' && full.comments_in_page > 0, 'fixture has comments in the DOM');
assert.ok(Array.isArray(full.comments), 'comments is an array');
const countNodes = (ns) => ns.reduce((s, n) => s + 1 + (n.replies ? countNodes(n.replies) : 0), 0);
assert.equal(full.comments_returned, countNodes(full.comments), 'comments_returned equals the real serialized node count (self-consistent)');
assert.ok(full.comments_returned > 0 && full.comments_returned <= full.comments_in_page, 'returned in (0, in_page]');

// --- budget cap: a small budget truncates to exactly the budget ---
const capped = parsePostDetails(html, 3, 'http://127.0.0.1:8080');
assert.equal(capped.comments_returned, Math.min(3, full.comments_in_page), 'budget 3 caps the returned count');

// --- pruneBFS unit: breadth-first fairness + the truncated flag ---
const mk = (id, replies = []) => ({ author: id, score: 0, body: id, replies });
const shape = () => [mk('a', [mk('a1', [mk('a1a')]), mk('a2')]), mk('b'), mk('c')]; // 6 nodes total
{
  const { count } = pruneBFS(shape(), 100);
  assert.equal(count, 6, 'no budget pressure -> all 6 nodes kept');
}
{
  const { kept, count } = pruneBFS(shape(), 3);
  assert.equal(count, 3, 'budget 3 -> exactly 3 nodes kept');
  assert.deepEqual(kept.map((n) => n.author).sort(), ['a', 'b', 'c'], 'BFS keeps ALL top-levels before any deep reply');
  const a = kept.find((n) => n.author === 'a');
  assert.equal(a.truncated, true, 'a had its replies cut by the budget -> truncated=true');
  assert.equal(a.replies.length, 0, 'a keeps no replies under the tight budget');
}

// --- nextAfter cursor ---
assert.equal(nextAfter('foo?after=t3_abc123&x=1'), 't3_abc123', 'extracts the after cursor');
assert.equal(nextAfter('no cursor here'), null, 'no cursor -> null');

// --- parsePortFlag: shared --port validation for setup/restart/update/doctor ---
assert.equal(parsePortFlag({}).port, 8080, 'absent --port -> default 8080');
assert.ok(parsePortFlag({ port: true }).err, 'bare --port (no value) -> error, not a silent default');
assert.equal(parsePortFlag({ port: '9000' }).port, 9000, 'valid port parses');
assert.ok(parsePortFlag({ port: '0' }).err, 'port 0 -> error');
assert.ok(parsePortFlag({ port: '65536' }).err, 'port > 65535 -> error');
assert.ok(parsePortFlag({ port: '80.5' }).err, 'non-integer -> error');
assert.ok(parsePortFlag({ port: 'abc' }).err, 'non-numeric -> error');
assert.equal(parsePortFlag({ port: '65535' }).port, 65535, 'ceiling port 65535 is valid');

console.log('ALL PASS');
