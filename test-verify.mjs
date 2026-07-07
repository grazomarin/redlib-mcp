import assert from 'node:assert';
import { verifyCandidate } from './dist/verify.js';
import { RedlibError } from './dist/errors.js';

// Inject a fake backend so we test the DECISION logic (spec §6.7) without a container:
// valid data -> promote; persistent PARSE_ERROR -> discard; persistent transient -> defer.
// A valid page has the #column_one shell AND at least one real .post node (index.ts's selector).
const validHtml = '<html><body><div id="column_one"><div class="post"><a class="post_title" href="/r/x/comments/ab/t">hi</a></div></div></body></html>';
const backendReturning = (html) => () => ({ fetch: async () => html });
const backendThrowing = (kind) => () => ({ fetch: async () => { throw new RedlibError(kind, kind); } });
const backendThrowingPlain = () => ({ fetch: async () => { throw new Error('unexpected non-RedlibError (e.g. cheerio blew up)'); } });

// valid (shell + a real post) -> promote
{
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 2, backoffMs: 1 }, backendReturning(validHtml));
  assert.equal(r.decision, 'promote', `valid data should promote, got ${r.decision} (${r.detail})`);
}
// a 200 error/info page (#error, no #column_one) -> assertRedlibContent throws PARSE_ERROR -> discard
{
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 2, backoffMs: 1 }, backendReturning('<div id="error">nope</div>'));
  assert.equal(r.decision, 'discard', `persistent PARSE_ERROR should discard, got ${r.decision}`);
}
// #column_one shell but ZERO parseable posts (stale-spoofing / drift empty listing) -> must NOT
// promote. The shell alone would false-pass a shell-only check; the .post parser catches it. (spec §5.2 step 5)
{
  const emptyShell = '<html><body><div id="column_one"><div id="posts"></div></div></body></html>';
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 2, backoffMs: 1 }, backendReturning(emptyShell));
  assert.equal(r.decision, 'discard', `empty #column_one (0 posts) must NOT promote, got ${r.decision}`);
}
// persistent transient (RATE_LIMITED) -> defer (keep old serving), NOT discard
{
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 2, backoffMs: 1 }, backendThrowing('RATE_LIMITED'));
  assert.equal(r.decision, 'defer', `transient should defer, got ${r.decision}`);
}
// an UNEXPECTED non-RedlibError throw must NOT discard a good build -> defer (keep old serving)
{
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 2, backoffMs: 1 }, backendThrowingPlain);
  assert.equal(r.decision, 'defer', `unexpected non-RedlibError should defer, not discard, got ${r.decision}`);
}
// recovers on retry -> promote (first attempt down, second valid)
{
  let n = 0;
  const flaky = () => ({ fetch: async () => { if (n++ === 0) { const e = new Error('REDLIB_DOWN'); e.kind = 'REDLIB_DOWN'; throw e; } return validHtml; } });
  const r = await verifyCandidate('http://127.0.0.1:8099', { retries: 3, backoffMs: 1 }, flaky);
  assert.equal(r.decision, 'promote', `recovery should promote, got ${r.decision}`);
}
console.log('ALL PASS');
