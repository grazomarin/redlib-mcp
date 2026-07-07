import assert from 'node:assert';
import { join } from 'node:path';
import { cloneAtPin, buildImage, hostArch } from './dist/engine.js';
import { REDLIB_PIN } from './dist/pin.js';

// Assert the EXACT argv the engine/git receives — the value is that no `sh -c` and the pinned SHA
// (not a moving ref) and Dockerfile.ubuntu (not the default/alpine) are what actually run.
function recorder(results = {}) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    assert.ok(Array.isArray(args), 'argv array only (no sh -c)');
    const key = `${file} ${args.join(' ')}`;
    for (const [pat, res] of Object.entries(results)) if (key.includes(pat)) return res;
    return { stdout: '', stderr: '', code: 0 };
  };
  return { run, calls };
}

// clone: fetches the pinned SHA and detaches onto it; rev-parse HEAD must equal the pin or it throws.
{
  const { run, calls } = recorder({ 'rev-parse HEAD': { stdout: REDLIB_PIN.sha + '\n', stderr: '', code: 0 } });
  await cloneAtPin('/tmp/redlib-src', run);
  const argvs = calls.map(c => `${c.file} ${c.args.join(' ')}`);
  assert.ok(argvs.some(a => a.startsWith('git') && a.includes('fetch') && a.includes(REDLIB_PIN.sha)), 'must fetch the pinned SHA: ' + argvs.join(' | '));
  assert.ok(argvs.some(a => a.includes('checkout') && a.includes(REDLIB_PIN.sha)), 'must checkout the pinned SHA');
  // network fetches must carry a timeout so a stalled network can't hang while holding the build lock
  const fetchCall = calls.find(c => c.args.includes('fetch'));
  assert.ok(fetchCall && fetchCall.opts && fetchCall.opts.timeoutMs > 0, 'git fetch must pass a network timeoutMs');
}
// clone: a HEAD that does NOT match the pin is refused (immutability guarantee).
{
  const { run } = recorder({ 'rev-parse HEAD': { stdout: 'deadbeef\n', stderr: '', code: 0 } });
  await assert.rejects(() => cloneAtPin('/tmp/redlib-src', run), /!=|pinned/i, 'HEAD != pin must throw');
}
// build: Dockerfile.ubuntu ONLY, tagged, from the clone dir.
{
  const { run, calls } = recorder();
  await buildImage('/tmp/redlib-src', 'localhost/redlib:building', { bin: 'docker', kind: 'docker' }, run);
  const build = calls.find(c => c.args[0] === 'build');
  assert.ok(build, 'must call build');
  // -f must be the Dockerfile.ubuntu INSIDE the clone dir, not a bare relative name: BuildKit resolves
  // -f relative to the CLI's CWD (not the context), so a bare "Dockerfile.ubuntu" fails for real users.
  const fi = build.args.indexOf('-f');
  assert.ok(fi >= 0 && build.args[fi + 1] === join('/tmp/redlib-src', 'Dockerfile.ubuntu'),
    'must pass -f as the Dockerfile.ubuntu resolved against the clone dir, got: ' + build.args[fi + 1]);
  assert.ok(!build.args.some(a => a === 'Dockerfile' || a === 'Dockerfile.alpine' || a.endsWith('/Dockerfile') || a.endsWith('/Dockerfile.alpine')), 'never the default/alpine Dockerfile');
  assert.ok(build.args.includes('-t') && build.args.includes('localhost/redlib:building'), 'must tag the temp image');
  assert.ok((build.opts?.timeoutMs ?? 0) >= 600000, 'first-build timeout must be generous (>=10min)');
}
assert.equal(hostArch('x64'), 'amd64');
assert.equal(hostArch('arm64'), 'arm64');
console.log('ALL PASS');
