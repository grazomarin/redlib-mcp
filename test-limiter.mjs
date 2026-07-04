import assert from 'node:assert';
import { MinIntervalLimiter } from './dist/limiter.js';

const lim = new MinIntervalLimiter(120);
const t0 = Date.now();
for (let i = 0; i < 4; i++) { await lim.acquire(); }
const elapsed = Date.now() - t0;
assert.ok(elapsed >= 360, `4 acquires @120ms should take >=360ms, took ${elapsed}`);
console.log(`ALL PASS (${elapsed}ms)`);
