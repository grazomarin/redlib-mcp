import assert from 'node:assert';
import { RedlibBackend } from './dist/backend/redlib.js';
const b = new RedlibBackend();
assert.equal(typeof b.fetch, 'function');
// A backend is just the transport seam; a bad path surfaces a typed RedlibError.
try { await b.fetch('/r/zzz_nonexistent_sub_99999x/hot'); assert.fail('should throw'); }
catch (e) { assert.ok(e.kind, `expected RedlibError with kind, got ${e}`); }

// The backend must route its default base URL through the validated resolver:
// a poisoned REDLIB_URL fails at CONSTRUCTION, never reaching the fetch layer.
const savedEnv = process.env.REDLIB_URL;
process.env.REDLIB_URL = 'http://evil.example.com:8080';
assert.throws(() => new RedlibBackend(), /loopback|REDLIB_URL/, 'non-loopback env must fail construction');
process.env.REDLIB_URL = 'http://127.0.0.1:8080; rm -rf /';
assert.throws(() => new RedlibBackend(), /illegal|REDLIB_URL/, 'metacharacter env must fail construction');
process.env.REDLIB_URL = savedEnv;

// --- deterministic resilience tests via an INJECTED fetch (no network) ---
const LOOPBACK = 'http://127.0.0.1:8080';
const resp = (status, body, ct = 'text/html') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
  text: async () => body,
});
// each element is a function producing the response (or throwing) for that attempt; last repeats
const scripted = (...steps) => { let i = 0; return async () => steps[Math.min(i++, steps.length - 1)](); };
const mk = (fetchImpl) => new RedlibBackend(LOOPBACK, async () => {}, 15000, fetchImpl);

// retryable 5xx then success -> promotes after retry
assert.match(await mk(scripted(() => resp(503, 'err'), () => resp(200, '<html>ok</html>'))).fetch('/x'), /ok/, '503 then 200 -> retried to success');
// a proxied 429 is RETRYABLE (the classifier fix): 429 then 200 succeeds
assert.match(await mk(scripted(() => resp(429, 'Too Many Requests'), () => resp(200, '<html>ok</html>'))).fetch('/x'), /ok/, '429 -> retried (RATE_LIMITED), then 200');
// three persistent 500s -> throws REDLIB_DOWN (retries exhausted)
await assert.rejects(() => mk(() => resp(500, 'boom')).fetch('/x'), (e) => e.kind === 'REDLIB_DOWN', 'persistent 5xx -> REDLIB_DOWN');
// a timeout/abort -> REDLIB_DOWN
await assert.rejects(() => mk(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }).fetch('/x'), (e) => e.kind === 'REDLIB_DOWN', 'AbortError -> REDLIB_DOWN');
// a non-HTML 200 (a block/JSON page) never reaches the parser -> PARSE_ERROR, and NOT retried
await assert.rejects(() => mk(() => resp(200, '{}', 'application/json')).fetch('/x'), (e) => e.kind === 'PARSE_ERROR', 'non-HTML content-type -> PARSE_ERROR');
// ECONNREFUSED -> REDLIB_DOWN (container not up)
await assert.rejects(() => mk(() => { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; }).fetch('/x'), (e) => e.kind === 'REDLIB_DOWN', 'ECONNREFUSED -> REDLIB_DOWN');

console.log('ALL PASS');
