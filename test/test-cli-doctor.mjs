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
    detectEngine: async () => { throw new Error('No working container engine found'); },
    daemonReachable: async () => false,
    containerIdOnPort: async () => null,
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
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }),
    daemonReachable: async () => true,
    containerIdOnPort: async () => null,
    waitHealthy: async () => false,
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'REDLIB_DOWN', detail: '' }),
    hostArch: () => 'amd64', imageArch: async () => 'amd64', url: 'http://127.0.0.1:8080',
  };
  const results = await runDoctor(deps);
  const container = results.find(r => /container/i.test(r.check));
  assert.ok(container && container.ok === false, 'container-down reported');
  assert.ok(container.fix && /setup/i.test(container.fix), 'fix points at setup');
}
console.log('ALL PASS');
