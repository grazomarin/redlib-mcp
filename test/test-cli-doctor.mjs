import assert from 'node:assert';
import { formatDoctor, runDoctor, cmdDoctor, run } from '../dist/cli.js';

// formatDoctor: any failing check -> non-zero exit + the fix text is shown.
{
  const { text, exitCode } = formatDoctor([
    { check: 'engine', ok: true, detail: 'docker' },
    { check: 'daemon', ok: false, detail: 'unreachable', fix: 'Start Docker Desktop' },
  ]);
  assert.equal(exitCode, 1, 'a failed check -> exit 1');
  assert.ok(text.includes('Start Docker Desktop'), 'remediation shown');
}
{
  const { exitCode } = formatDoctor([{ check: 'engine', ok: true, detail: 'docker' }]);
  assert.equal(exitCode, 0, 'all green -> exit 0');
}
// runDoctor with injected deps: no engine -> the FIRST result fails and short-circuits (no crash).
{
  const deps = {
    locateBackend: async () => { throw new Error('No working container engine found'); },
    daemonReachable: async () => false,
    waitHealthy: async () => false,
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'REDLIB_DOWN', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64', url: 'http://127.0.0.1:8080',
  };
  const results = await runDoctor(deps);
  assert.equal(results[0].ok, false, 'engine check fails');
  assert.ok(/engine/i.test(results[0].check));
}
// runDoctor: engine + daemon ok but container down -> reports the container check with a remediation.
{
  const deps = {
    locateBackend: async () => ({ engine: { bin: 'docker', kind: 'docker' }, id: null }),
    daemonReachable: async () => true,
    waitHealthy: async () => false,
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'REDLIB_DOWN', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64', url: 'http://127.0.0.1:8080',
  };
  const results = await runDoctor(deps);
  const container = results.find(r => /container/i.test(r.check));
  assert.ok(container && container.ok === false, 'container-down reported');
  assert.ok(container.fix && /setup/i.test(container.fix), 'fix points at setup');
}
// cross-engine: locateBackend finds the backend on the NON-preferred engine -> engine check notes it
// hosts the backend and everything is green (the exact dogfood scenario: podman backend, docker installed).
{
  const deps = {
    locateBackend: async () => ({ engine: { bin: '/usr/bin/podman', kind: 'podman' }, id: '7640f3bd' }),
    daemonReachable: async () => true,
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64', url: 'http://127.0.0.1:8080',
  };
  const results = await runDoctor(deps);
  assert.ok(results.every(r => r.ok), `all checks green, failing: ${results.filter(r => !r.ok).map(r => r.check)}`);
  assert.ok(results[0].detail.includes('podman') && /hosts the backend/.test(results[0].detail), 'engine check notes podman hosts the backend');
}
// runDoctor threads deps.port into locateBackend + the container label, and the container-down
// fix hints about --port.
{
  let seenPort = null;
  const deps = {
    port: 9000,
    locateBackend: async (p) => { seenPort = p; return { engine: { bin: 'podman', kind: 'podman' }, id: null }; },
    daemonReachable: async () => true,
    waitHealthy: async () => false,
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'REDLIB_DOWN', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64', url: 'http://127.0.0.1:9000',
  };
  const results = await runDoctor(deps);
  assert.equal(seenPort, 9000, 'locateBackend called with the injected port');
  const container = results.find(r => /container/i.test(r.check));
  assert.ok(container.check.includes(':9000'), 'container label shows the custom port');
  assert.ok(/--port/.test(container.fix), 'container-down fix hints about --port');
}
// cmdDoctor parses --port and threads it into BOTH locateBackend and the health URL.
{
  let seenPort = null, seenUrl = null;
  const rc = await cmdDoctor(['--port', '9000'], {
    locateBackend: async (p) => { seenPort = p; return { engine: { bin: 'podman', kind: 'podman' }, id: 'abc' }; },
    daemonReachable: async () => true,
    waitHealthy: async (u) => { seenUrl = u; return true; },
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64',
  });
  assert.equal(seenPort, 9000, 'cmdDoctor threads --port into locateBackend');
  assert.equal(seenUrl, 'http://127.0.0.1:9000', 'cmdDoctor threads --port into the health URL');
  assert.equal(rc, 0, 'all-green doctor exits 0');
}
// invalid --port -> exit 2 before touching the backend.
{
  assert.equal(await cmdDoctor(['--port', 'abc']), 2, 'invalid --port -> exit 2');
}
// hardened --port: out of range / bare value -> exit 2 (before touching the backend).
{
  assert.equal(await cmdDoctor(['--port', '999999']), 2, '--port > 65535 -> exit 2');
  assert.equal(await cmdDoctor(['--port', '0']), 2, '--port 0 -> exit 2');
  assert.equal(await cmdDoctor(['--port']), 2, 'bare --port (no value) -> exit 2, not a silent default');
}
// no --port -> health URL is the default local port (single source: always :8080, never a stale REDLIB_URL).
{
  let seenUrl = null;
  await cmdDoctor([], {
    locateBackend: async () => ({ engine: { bin: 'docker', kind: 'docker' }, id: 'abc' }),
    daemonReachable: async () => true,
    waitHealthy: async (u) => { seenUrl = u; return true; },
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64',
  });
  assert.equal(seenUrl, 'http://127.0.0.1:8080', 'no --port -> health URL is the default local port');
}
// doctor --help advertises --port
{
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (s) => { out += s; return true; };
  try { await run(['doctor', '--help']); } finally { process.stderr.write = orig; }
  assert.ok(/--port/.test(out), 'doctor --help lists --port');
}
console.log('ALL PASS');
