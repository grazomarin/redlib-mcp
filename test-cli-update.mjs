import assert from 'node:assert';
import { cmdUpdate } from './dist/cli.js';

function baseDeps(overrides) {
  return {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }),
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
console.log('ALL PASS');
