import assert from 'node:assert';
import { existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBuildLock } from './dist/redlib.js';

const dir = mkdtempSync(join(tmpdir(), 'lock-'));
const lock = join(dir, 'build.lock');

// runs fn, releases the lock after (success path).
{
  let ran = false;
  const out = await withBuildLock(lock, async () => { ran = true; assert.ok(existsSync(lock), 'lock held during fn'); return 42; });
  assert.equal(out, 42); assert.ok(ran); assert.ok(!existsSync(lock), 'lock released after fn');
}
// releases the lock even if fn throws.
{
  await assert.rejects(() => withBuildLock(lock, async () => { throw new Error('boom'); }));
  assert.ok(!existsSync(lock), 'lock released after throw');
}
// a FRESH concurrent lock is refused (does not stack a second build).
{
  writeFileSync(lock, String(process.pid));            // simulate another build holding it
  await assert.rejects(() => withBuildLock(lock, async () => 1), /in progress|lock/i, 'fresh lock blocks a second build');
  rmSync(lock, { force: true });
}
// a STALE lock (older than staleMs) is reclaimed.
{
  writeFileSync(lock, 'old');
  let ran = false;
  await withBuildLock(lock, async () => { ran = true; }, { staleMs: 0 }); // staleMs:0 -> any existing lock is stale
  assert.ok(ran, 'stale lock reclaimed');
}
console.log('ALL PASS');
