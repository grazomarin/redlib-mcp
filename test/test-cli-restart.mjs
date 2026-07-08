import assert from 'node:assert';
import { cmdRestart } from '../dist/cli.js';

// happy path: a container holds :8080 -> restart it, it becomes healthy -> exit 0.
{
  const restarted = [];
  const code = await cmdRestart([], {
    detectEngine: async () => ({ bin: '/usr/bin/podman', kind: 'podman' }),
    daemonReachable: async () => true,
    containerIdOnPort: async () => 'abc123',
    restartContainer: async (_e, n) => { restarted.push(n); },
    waitHealthy: async () => true,
  });
  assert.equal(code, 0, `healthy restart -> 0, got ${code}`);
  assert.deepEqual(restarted, ['abc123'], 'restarts the container found on the port (by id, name-agnostic)');
}

// nothing on the port -> exit 4, and it must NOT blindly restart.
{
  let restarted = false;
  const code = await cmdRestart([], {
    detectEngine: async () => ({ bin: 'd', kind: 'docker' }),
    daemonReachable: async () => true,
    containerIdOnPort: async () => null,
    restartContainer: async () => { restarted = true; },
    waitHealthy: async () => true,
  });
  assert.equal(code, 4, `no container -> 4, got ${code}`);
  assert.equal(restarted, false, 'must not restart when nothing is on the port');
}

// restarted but never healthy -> exit 4 (surfaces the failure, no false success).
{
  const code = await cmdRestart([], {
    detectEngine: async () => ({ bin: 'd', kind: 'docker' }),
    daemonReachable: async () => true,
    containerIdOnPort: async () => 'x',
    restartContainer: async () => {},
    waitHealthy: async () => false,
  });
  assert.equal(code, 4, `unhealthy after restart -> 4, got ${code}`);
}

// daemon down -> exit 3, never reaches the container.
{
  const code = await cmdRestart([], {
    detectEngine: async () => ({ bin: 'd', kind: 'docker' }),
    daemonReachable: async () => false,
    containerIdOnPort: async () => 'x',
    restartContainer: async () => {},
    waitHealthy: async () => true,
  });
  assert.equal(code, 3, `daemon down -> 3, got ${code}`);
}

// invalid --engine value is rejected BEFORE touching the engine (validation, exit 2).
{
  const code = await cmdRestart(['--engine', 'k8s'], {
    detectEngine: async () => { throw new Error('must not detect on invalid --engine'); },
    daemonReachable: async () => true, containerIdOnPort: async () => 'x',
    restartContainer: async () => {}, waitHealthy: async () => true,
  });
  assert.equal(code, 2, `invalid --engine -> 2, got ${code}`);
}

console.log('ALL PASS');
