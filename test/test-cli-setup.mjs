import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, serverEntry, cmdSetup } from '../dist/cli.js';

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
// clean install must clear any stale/stopped same-name container before the direct bind (no name-conflict crash).
{
  const calls = [];
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => null,                          // clean: nothing running on :8080
    stopContainer: async (_e, name) => { calls.push('stop:' + name); },
    runContainer: async () => { calls.push('run'); },
    tagImage: async () => {}, removeImage: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '', version: '1.0.0',
  };
  const code = await cmdSetup(['--yes', '--print-only'], deps);
  assert.equal(code, 0, 'clean install succeeds');
  const stopIdx = calls.indexOf('stop:redlib-mcp'), runIdx = calls.indexOf('run');
  assert.ok(stopIdx >= 0, 'clean install clears any stale same-name container (stopContainer redlib-mcp)');
  assert.ok(stopIdx < runIdx, 'the stale-container clear happens BEFORE the direct bind');
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
// no-cfgPath branch PRINTS a paste-ready mcpServers entry (not just "skipping").
{
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => null, runContainer: async () => {},
    tagImage: async () => {}, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '', version: '1.2.3',
  };
  let code;
  try { code = await cmdSetup(['--yes'], deps); } finally { process.stderr.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 0, 'no-cfgPath still exits 0');
  assert.ok(out.includes('"redlib-mcp"'), 'prints the mcpServers key');
  assert.ok(out.includes('redlib-mcp@1.2.3'), 'prints the exact-version pin from serverEntry');
  assert.ok(out.includes('serve'), 'prints the serve arg');
  assert.ok(/claude mcp add redlib-mcp/.test(out), 'prints the claude mcp add one-liner');
}
// hardened --port is wired into setup (behavior changed from the old parse): out-of-range / bare -> exit 2.
{
  assert.equal(await cmdSetup(['--port', '999999']), 2, 'setup --port > 65535 -> exit 2');
  assert.equal(await cmdSetup(['--port']), 2, 'setup bare --port -> exit 2');
}
// setup at the 65535 ceiling -> the re-setup candidate temp port stays IN RANGE (65534, never 65536).
{
  const order = [];
  const deps = {
    detectEngine: async () => ({ bin: 'docker', kind: 'docker' }), daemonReachable: async () => true,
    cloneAtPin: async () => {}, buildImage: async () => {},
    containerIdOnPort: async () => 'existing123',   // re-setup path -> verify the candidate on a temp port
    runContainer: async (e, o) => { order.push('run:' + o.port); },
    tagImage: async () => {}, removeImage: async () => {}, stopContainer: async () => {},
    waitHealthy: async () => true,
    verifyCandidate: async () => ({ decision: 'promote', lastKind: 'VALID', detail: '' }),
    withBuildLock: async (fn) => fn(),
    resolveClientConfig: () => '', version: '1.0.0',
  };
  const code = await cmdSetup(['--port', '65535', '--yes', '--print-only'], deps);
  assert.equal(code, 0, 'ceiling re-setup succeeds');
  assert.ok(order.includes('run:65534'), `ceiling candidate clamps to 65534: ${order}`);
  assert.ok(!order.includes('run:65536'), 'candidate never binds an invalid 65536');
}
console.log('ALL PASS');
