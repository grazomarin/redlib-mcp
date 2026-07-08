import assert from 'node:assert';
import { detectEngine, containerIdOnPort, restartContainer } from '../dist/engine.js';

// A mock Runner records calls and returns scripted results by binary NAME — so we test resolution
// logic without a real docker/podman. `version` is how we distinguish a working engine (spec §8).
function mockRunner(okFor) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    // never a shell string:
    assert.ok(Array.isArray(args), 'args must be an argv array (no sh -c)');
    const isVersion = args[0] === 'version';
    const name = file.includes('docker') ? 'docker' : file.includes('podman') ? 'podman' : file;
    return isVersion && name === okFor
      ? { stdout: '99.9', stderr: '', code: 0 }
      : { stdout: '', stderr: 'not found', code: 1 };
  };
  return { run, calls };
}

const existsAll = () => true; // pretend the absolute candidate paths are on disk (off-host test)

// docker available -> chosen first; and detectEngine must NEVER invoke a bare-name binary (spec §8).
{
  const { run, calls } = mockRunner('docker');
  const e = await detectEngine(run, {}, existsAll);
  assert.equal(e.kind, 'docker', `expected docker, got ${e.kind}`);
  assert.ok(calls.every(c => c.file !== 'docker' && c.file !== 'podman'), 'must never invoke a bare-name binary (PATH-hijack surface)');
  assert.ok(calls.every(c => c.file.includes('/') || c.file.includes('\\')), 'only absolute candidate paths are probed');
}
// docker absent, podman available -> fall back to podman.
{
  const { run } = mockRunner('podman');
  const e = await detectEngine(run, {}, existsAll);
  assert.equal(e.kind, 'podman', `expected podman fallback, got ${e.kind}`);
}
// neither -> a clear error, not a silent default.
{
  const { run } = mockRunner('nothing');
  await assert.rejects(() => detectEngine(run, {}, existsAll), /container engine/i, 'must reject with a clear message');
}
// explicit REDLIB_ENGINE override: an absolute path is honored; a bare name is rejected (spec §8).
{
  const { run } = mockRunner('docker');
  const e = await detectEngine(run, { REDLIB_ENGINE: '/custom/bin/docker' }, existsAll);
  assert.equal(e.bin, '/custom/bin/docker', 'absolute override honored');
  await assert.rejects(() => detectEngine(run, { REDLIB_ENGINE: 'docker' }, existsAll), /absolute/i, 'bare-name override rejected');
  await assert.rejects(() => detectEngine(run, { REDLIB_ENGINE: './docker' }, existsAll), /absolute|relative/i, 'RELATIVE override (./docker) rejected — a slash alone is not "absolute"');
}
// containerIdOnPort: a FAILED `ps` (exit != 0) must THROW, not return null — else setup's clean-install
// branch would `rm -f` a live backend + bind an unverified image on a transient engine hiccup. And it
// matches the published HOST port from the Ports column (NOT `--filter publish`, which podman rejects).
{
  const eng = { bin: 'podman', kind: 'podman' };
  await assert.rejects(() => containerIdOnPort(eng, 8080, async () => ({ stdout: '', stderr: 'daemon busy', code: 1 })), /ps.*failed/i, 'ps failure must throw, not return null');
  const ports = async () => ({ stdout: 'abc123 0.0.0.0:8080->8080/tcp\ndef456 127.0.0.1:9090->8080/tcp\n', stderr: '', code: 0 });
  assert.equal(await containerIdOnPort(eng, 8080, ports), 'abc123', 'returns the container publishing HOST :8080');
  assert.equal(await containerIdOnPort(eng, 9090, ports), 'def456', 'matches HOST port, not container port (both map to 8080 inside)');
  assert.equal(await containerIdOnPort(eng, 7000, ports), null, 'no container on the port -> null');
  assert.equal(await containerIdOnPort(eng, 8080, async () => ({ stdout: '', stderr: '', code: 0 })), null, 'no containers -> null on a CLEAN exit');
}
// --engine prefer: narrows detection to ONE kind (the `--engine docker|podman` flag).
{
  const e = await detectEngine(mockRunner('podman').run, {}, existsAll, 'podman');
  assert.equal(e.kind, 'podman', 'prefer=podman selects podman');
  // prefer=docker but only podman responds -> a clear error that NAMES the requested flag, not a silent podman fallback.
  await assert.rejects(() => detectEngine(mockRunner('podman').run, {}, existsAll, 'docker'), /--engine docker/i, 'prefer=docker with no docker rejects (no silent fallback)');
}
// restartContainer issues `restart <nameOrId>` on the resolved engine binary (argv, never a shell string).
{
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); return { stdout: '', stderr: '', code: 0 }; };
  await restartContainer({ bin: '/usr/bin/podman', kind: 'podman' }, 'redlib-mcp', run);
  assert.deepEqual(calls[0], ['/usr/bin/podman', 'restart', 'redlib-mcp'], 'restart passes `restart <name>` argv');
}
console.log('ALL PASS');
