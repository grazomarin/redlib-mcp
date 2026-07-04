import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, serverEntry, cmdSetup } from './dist/cli.js';

// flags: --port 9000 --yes --non-loopback -> parsed; bare subcommand args ignored.
{
  const f = parseFlags(['--port', '9000', '--yes', '--non-loopback']);
  assert.equal(f.port, '9000'); assert.equal(f.yes, true); assert.equal(f['non-loopback'], true);
}
// emitted server entry is immutable-versioned (spec §7): exact version, never floating.
{
  const npx = serverEntry(null, '1.2.3');
  assert.deepEqual(npx.args, ['-y', 'redlib-mcp@1.2.3', 'serve']);
  const abs = serverEntry('/usr/local/bin/redlib-mcp', '1.2.3');
  assert.deepEqual(abs, { command: '/usr/local/bin/redlib-mcp', args: ['serve'] });
}
// setup orchestration with mock deps + a clean :8080 (nothing running) binds directly, verifies,
// and reaches the config step. --print-only stops before writing (never writes in a test).
{
  const order = [];
  const deps = {
    detectEngine: async () => { order.push('engine'); return { bin: 'docker', kind: 'docker' }; },
    daemonReachable: async () => true,
    cloneAtPin: async () => { order.push('clone'); },
    buildImage: async () => { order.push('build'); },
    containerIdOnPort: async () => null,           // clean install
    runContainer: async () => { order.push('run'); },
    tagImage: async () => {}, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => { order.push('verify'); return { decision: 'promote', lastKind: 'VALID', detail: '' }; },
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '/tmp/does-not-exist/config.json',
    version: '1.0.0',
  };
  const code = await cmdSetup(['--yes', '--print-only'], deps);
  assert.equal(code, 0, `clean setup should succeed, got ${code}`);
  assert.deepEqual(order, ['engine', 'clone', 'build', 'run', 'verify'], `clean path order: ${order}`);
}
// setup when :8080 is ALREADY running -> verify-before-swap on a temp port, not a direct bind.
{
  const order = [];
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }),
    daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => { order.push('build'); },
    containerIdOnPort: async () => 'existing123',  // already running
    runContainer: async (e, o) => { order.push('run:' + o.port); },
    tagImage: async () => { order.push('promote'); }, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '/tmp/does-not-exist/config.json', version: '1.0.0',
  };
  const code = await cmdSetup(['--yes', '--print-only'], deps);
  assert.equal(code, 0);
  assert.ok(order.some(o => o.startsWith('run:') && o !== 'run:8080'), `must run candidate on a TEMP port, order: ${order}`);
  assert.ok(order.includes('promote'), 'a verified candidate is promoted');
}
// a discarded candidate (broken build) -> removeImage the candidate, exit 5, live service untouched.
{
  let removedBuilding = false;
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => 'existing123',
    runContainer: async () => {}, tagImage: async () => { throw new Error('must NOT promote a discard'); },
    removeImage: async (_e, tag) => { removedBuilding = (removedBuilding || String(tag).includes('building')); }, stopContainer: async () => {}, waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'discard', lastKind: 'PARSE_ERROR', detail: 'broken' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '/tmp/x/config.json', version: '1.0.0',
  };
  const code = await cmdSetup(['--yes', '--print-only'], deps);
  assert.ok(removedBuilding, 'discard must removeImage the candidate (building) tag');
  assert.equal(code, 5, 'discard returns 5');
}
// re-setup, verify DEFER (inconclusive) -> KEEP candidate image (not removed), never promote, non-zero.
{
  let removedBuilding = false, promoted = false;
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => 'existing123',
    runContainer: async () => {}, stopContainer: async () => {},
    tagImage: async () => { promoted = true; },
    removeImage: async (_e, tag) => { if (String(tag).includes('building')) removedBuilding = true; },
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'defer', lastKind: 'RATE_LIMITED', detail: 'throttled' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '', version: '1.0.0',
  };
  const code = await cmdSetup(['--yes', '--print-only'], deps);
  assert.notEqual(code, 0, 'defer is a non-zero (inconclusive) exit');
  assert.equal(removedBuilding, false, 'defer must KEEP the candidate image (must NOT removeImage the building tag)');
  assert.equal(promoted, false, 'defer must not promote');
}
// config-WRITE branch (NO --print-only): merges into an existing config atomically, keeps siblings,
// leaves a .bak. This exercises the Task-8 headline deliverable end-to-end (the --print-only tests
// above return BEFORE writeAtomic, so without this the write path is untested).
{
  const cfgDir = mkdtempSync(join(tmpdir(), 'setup-cfg-'));
  const cfg = join(cfgDir, 'mcp.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => null, runContainer: async () => {},
    tagImage: async () => {}, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => cfg, version: '1.0.0',
  };
  const code = await cmdSetup(['--yes'], deps); // NOT --print-only -> actually writes
  assert.equal(code, 0, `write-branch setup should succeed, got ${code}`);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(written.mcpServers.other, 'sibling server preserved through the merge');
  assert.ok(written.mcpServers['redlib-mcp'].args.includes('serve'), 'redlib-mcp entry written');
  assert.ok(existsSync(cfg + '.bak'), 'prior config backed up');
}
// empty client-config path (env unset) -> must NOT crash after a good build; skip registration.
{
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => null, runContainer: async () => {},
    tagImage: async () => {}, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '', version: '1.0.0',
  };
  const code = await cmdSetup(['--yes'], deps); // no cfg path, no --print-only -> must not writeAtomic("")
  assert.equal(code, 0, 'empty cfg path must skip registration, not crash setup');
}
console.log('ALL PASS');
