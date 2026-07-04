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
console.log('ALL PASS');
