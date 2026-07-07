import assert from 'node:assert';
import { resolveRedlibUrl } from '../dist/config.js';

// Isolate the hardcoded fallback from ambient env — the signature's default param binds
// `raw = process.env.REDLIB_URL`, so calling with no arg would otherwise read the environment
// and pass coincidentally (or fail spuriously) instead of verifying the 127.0.0.1 fallback.
const savedDefault = process.env.REDLIB_URL;
delete process.env.REDLIB_URL;
assert.equal(resolveRedlibUrl(), 'http://127.0.0.1:8080');                     // hardcoded default
if (savedDefault !== undefined) process.env.REDLIB_URL = savedDefault;
assert.equal(resolveRedlibUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
assert.throws(() => resolveRedlibUrl('http://127.0.0.1:8080; rm -rf /'));      // metachars
assert.throws(() => resolveRedlibUrl('file:///etc/passwd'));                   // scheme
assert.throws(() => resolveRedlibUrl('http://evil.example.com:8080'));         // non-loopback host
assert.throws(() => resolveRedlibUrl('http://127.0.0.1:notaport'));            // bad port
console.log('ALL PASS');
