// Golden-file classifier test. Fixtures are captured from a built Redlib image
// (see spec §6.3); update them on every Redlib pin bump.
import assert from 'node:assert';
import { classifyRedlib } from './dist/errors.js';

const cases = [
  [404, '<div class="error"><h1>Too many requests.</h1></div>', 'RATE_LIMITED'],
  [404, '<div class="error">OAuth token has expired. Please refresh.</div>', 'UPSTREAM_TOKEN_STALE'],
  [404, '<div class="error">Reddit is having issues, check status.reddit.com</div>', 'REDLIB_DOWN'],
  [404, '<div class="error"><h1>Nothing here</h1><p>Post not found</p></div>', 'CONTENT_UNAVAILABLE'],
  [403, '<div class="nsfw_landing">This post is NSFW</div>', 'CONTENT_UNAVAILABLE'],
  [500, '<h1>500 Internal Server Error</h1>', 'REDLIB_DOWN'],
  [200, '<div class="post">ok</div>', null],
];
let pass = 0, fail = 0;
for (const [status, body, want] of cases) {
  const got = classifyRedlib(status, body);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${status} -> ${got} (want ${want})`);
  ok ? pass++ : fail++;
}
assert.equal(fail, 0, `${fail} classifier cases failed`);
console.log(`\nALL PASS (${pass})`);
