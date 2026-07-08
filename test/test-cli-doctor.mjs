import assert from 'node:assert';
import { formatDoctor, runDoctor } from '../dist/cli.js';

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
console.log('ALL PASS');
