import assert from 'node:assert';
import { cmdRestart } from '../dist/cli.js';

// happy path: locateBackend finds the container (on whichever engine hosts it) -> restart it, healthy -> 0.
{
  const restarted = [];
  const code = await cmdRestart([], {
    locateBackend: async () => ({ engine: { bin: '/usr/bin/podman', kind: 'podman' }, id: 'abc123' }),
    daemonReachable: async () => true,
    restartContainer: async (_e, n) => { restarted.push(n); },
    waitHealthy: async () => true,
  });
  assert.equal(code, 0, `healthy restart -> 0, got ${code}`);
  assert.deepEqual(restarted, ['abc123'], 'restarts the located container by id (name/engine-agnostic)');
}

// nothing hosts the backend (id null) but daemon up -> exit 4, must NOT blindly restart.
{
  let restarted = false;
  const code = await cmdRestart([], {
    locateBackend: async () => ({ engine: { bin: 'd', kind: 'docker' }, id: null }),
    daemonReachable: async () => true,
    restartContainer: async () => { restarted = true; },
    waitHealthy: async () => true,
  });
  assert.equal(code, 4, `no backend on either engine -> 4, got ${code}`);
  assert.equal(restarted, false, 'must not restart when nothing is on the port');
}

// restarted but never healthy -> exit 4 (surfaces the failure, no false success).
{
  const code = await cmdRestart([], {
    locateBackend: async () => ({ engine: { bin: 'd', kind: 'docker' }, id: 'x' }),
    daemonReachable: async () => true,
    restartContainer: async () => {},
    waitHealthy: async () => false,
  });
  assert.equal(code, 4, `unhealthy after restart -> 4, got ${code}`);
}

// no backend found AND the resolved engine's daemon is down -> exit 3 (distinct from "not running").
{
  const code = await cmdRestart([], {
    locateBackend: async () => ({ engine: { bin: 'd', kind: 'docker' }, id: null }),
    daemonReachable: async () => false,
    restartContainer: async () => {},
    waitHealthy: async () => true,
  });
  assert.equal(code, 3, `daemon down -> 3, got ${code}`);
}

// invalid --engine value is rejected BEFORE locating anything (validation, exit 2).
{
  const code = await cmdRestart(['--engine', 'k8s'], {
    locateBackend: async () => { throw new Error('must not locate on invalid --engine'); },
    daemonReachable: async () => true,
    restartContainer: async () => {}, waitHealthy: async () => true,
  });
  assert.equal(code, 2, `invalid --engine -> 2, got ${code}`);
}

console.log('ALL PASS');
