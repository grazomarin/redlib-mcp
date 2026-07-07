import assert from 'node:assert';
import { runContainer, waitHealthy, containerIdOnPort } from '../dist/engine.js';

function recorder(results = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    assert.ok(Array.isArray(args), 'argv array only');
    const key = args.join(' ');
    for (const [pat, res] of Object.entries(results)) if (key.includes(pat)) return res;
    return { stdout: '', stderr: '', code: 0 };
  };
  return { run, calls };
}

// run: loopback bind by default (spec §6.4) + restart policy.
{
  const { run, calls } = recorder();
  await runContainer({ bin: 'docker', kind: 'docker' }, { image: 'localhost/redlib:latest', name: 'redlib-mcp', port: 8080 }, run);
  const r = calls.find(c => c.args[0] === 'run');
  assert.ok(r.args.includes('-p') && r.args.includes('127.0.0.1:8080:8080'), 'must bind loopback: ' + r.args.join(' '));
  assert.ok(r.args.includes('--restart') && r.args.includes('unless-stopped'), 'must set restart policy');
}
// run: non-loopback is opt-in and binds 0.0.0.0.
{
  const { run, calls } = recorder();
  await runContainer({ bin: 'docker', kind: 'docker' }, { image: 'x', name: 'y', port: 9000, host: '0.0.0.0' }, run);
  const r = calls.find(c => c.args[0] === 'run');
  assert.ok(r.args.includes('0.0.0.0:9000:8080'), 'explicit non-loopback bind honored');
}
// containerIdOnPort: returns an id when `ps` reports one, else null.
{
  const { run } = recorder({ 'ps': { stdout: 'abc123\n', stderr: '', code: 0 } });
  assert.equal(await containerIdOnPort({ bin: 'docker', kind: 'docker' }, 8080, run), 'abc123');
  const { run: run2 } = recorder({ 'ps': { stdout: '\n', stderr: '', code: 0 } });
  assert.equal(await containerIdOnPort({ bin: 'docker', kind: 'docker' }, 8080, run2), null);
}
// waitHealthy: succeeds once fetch returns ok; bounded by `tries`.
{
  let n = 0;
  const fetchFn = async () => (++n >= 2 ? { ok: true } : { ok: false });
  assert.equal(await waitHealthy('http://127.0.0.1:8080', { tries: 5, delayMs: 1, fetchFn }), true);
  const fail = async () => { throw new Error('refused'); };
  assert.equal(await waitHealthy('http://127.0.0.1:8080', { tries: 3, delayMs: 1, fetchFn: fail }), false);
}
console.log('ALL PASS');
