import assert from 'node:assert';
import { cmdUpdate, run } from '../dist/cli.js';

function baseDeps(overrides) {
  return {
    locateBackend: async () => ({ engine: { bin: 'docker', kind: 'docker' }, id: 'x' }),
    daemonReachable: async () => true,
    cloneAtPin: async () => {},
    buildImage: async () => {},
    runContainer: async () => {},
    stopContainer: async () => {},
    waitHealthy: async () => true,
    tagImage: async () => {}, removeImage: async () => {},
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(), // pass-through in tests (real lock touches the data dir)
    ...overrides,
  };
}

// valid candidate -> promote :latest, exit 0.
{
  let promoted = false;
  const code = await cmdUpdate([], baseDeps({ tagImage: async () => { promoted = true; } }));
  assert.equal(code, 0); assert.ok(promoted, 'valid candidate promoted to :latest');
}
// persistent PARSE_ERROR -> DISCARD: never promote, REMOVE the broken candidate, non-zero.
{
  let removed = false;
  const code = await cmdUpdate([], baseDeps({
    verifyCandidate: async () => ({ decision: 'discard', lastKind: 'PARSE_ERROR', detail: 'broken' }),
    tagImage: async () => { throw new Error('must NOT promote a discard'); },
    removeImage: async () => { removed = true; },
  }));
  assert.notEqual(code, 0, 'discard is a failure exit');
  assert.ok(removed, 'discard removes the broken candidate image');
}
// persistent transient -> DEFER (inconclusive): never promote, KEEP the candidate image for
// re-verification (spec §5.2 — must NOT removeImage on defer), distinct non-zero exit.
{
  let removed = false;
  const code = await cmdUpdate([], baseDeps({
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'RATE_LIMITED', detail: 'throttled' }),
    tagImage: async () => { throw new Error('must NOT promote a defer'); },
    removeImage: async () => { removed = true; },
  }));
  assert.notEqual(code, 0, 'defer is a non-zero (inconclusive) exit');
  assert.equal(removed, false, 'defer must KEEP the candidate image for re-verification, not remove it');
}
// update always builds to a TEMP tag and runs the candidate on a TEMP port (never touches :latest first).
{
  const seen = { tags: [], ports: [] };
  await cmdUpdate([], baseDeps({
    buildImage: async (dir, tag) => { seen.tags.push(tag); },
    runContainer: async (e, o) => { seen.ports.push(o.port); },
  }));
  assert.ok(seen.tags.every(t => t.includes('building') || t.includes('candidate')), `temp build tag only: ${seen.tags}`);
  assert.ok(seen.ports.every(p => p !== 8080), `candidate never binds :8080: ${seen.ports}`);
}
// --port threads into locateBackend AND the candidate temp port (port + 1).
{
  let locatedPort = null;
  const seen = { ports: [] };
  await cmdUpdate(['--port', '9000'], baseDeps({
    locateBackend: async (p) => { locatedPort = p; return { engine: { bin: 'docker', kind: 'docker' }, id: 'x' }; },
    runContainer: async (e, o) => { seen.ports.push(o.port); },
  }));
  assert.equal(locatedPort, 9000, 'update locates the backend on --port');
  assert.ok(seen.ports.includes(9001), `candidate runs on port+1 (9001): ${seen.ports}`);
}
// invalid --port -> exit 2.
{
  assert.equal(await cmdUpdate(['--port', 'abc'], baseDeps({})), 2, 'invalid --port -> exit 2');
}
// hardened --port: out of range / bare value -> exit 2.
{
  assert.equal(await cmdUpdate(['--port', '999999'], baseDeps({})), 2, '--port > 65535 -> exit 2');
  assert.equal(await cmdUpdate(['--port', '0'], baseDeps({})), 2, '--port 0 -> exit 2');
  assert.equal(await cmdUpdate(['--port'], baseDeps({})), 2, 'bare --port -> exit 2');
}
// ceiling --port 65535 -> candidate temp port stays IN RANGE (65534, never an invalid 65536).
{
  const seen = { ports: [] };
  await cmdUpdate(['--port', '65535'], baseDeps({
    locateBackend: async () => ({ engine: { bin: 'docker', kind: 'docker' }, id: 'x' }),
    runContainer: async (e, o) => { seen.ports.push(o.port); },
  }));
  assert.ok(seen.ports.includes(65534), `ceiling --port -> candidate 65534: ${seen.ports}`);
  assert.ok(!seen.ports.includes(65536), 'candidate never binds an invalid 65536');
}
// update --help advertises --port
{
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (s) => { out += s; return true; };
  try { await run(['update', '--help']); } finally { process.stderr.write = orig; }
  assert.ok(/--port/.test(out), 'update --help lists --port');
}
console.log('ALL PASS');
