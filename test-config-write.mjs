import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeServer, writeAtomic } from './dist/config-write.js';

// merge preserves sibling servers (never overwrite the whole map) — spec §8.
{
  const existing = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } });
  const { obj } = mergeServer(existing, 'redlib-mcp', { command: 'npx', args: ['-y', 'redlib-mcp@1.0.0', 'serve'] });
  assert.ok(obj.mcpServers.other, 'sibling server preserved');
  assert.equal(obj.mcpServers['redlib-mcp'].args.at(-1), 'serve');
  // emitted entry is immutable-versioned, never floating (spec §7)
  assert.ok(obj.mcpServers['redlib-mcp'].args.some(a => /redlib-mcp@\d/.test(a)), 'exact version pinned');
  assert.ok(!obj.mcpServers['redlib-mcp'].args.includes('redlib-mcp'), 'no bare floating name');
}
// JSONC tolerance: a config with // comments still parses.
{
  const jsonc = '{\n  // my servers\n  "mcpServers": { "a": { "command": "x", "args": [] } }\n}';
  const { obj } = mergeServer(jsonc, 'redlib-mcp', { command: 'c', args: ['serve'] });
  assert.ok(obj.mcpServers.a && obj.mcpServers['redlib-mcp'], 'JSONC merged');
}
// empty / missing file -> a fresh config, not a crash.
{
  const { obj } = mergeServer('', 'redlib-mcp', { command: 'c', args: ['serve'] });
  assert.ok(obj.mcpServers['redlib-mcp']);
}
// atomic write leaves a .bak of the prior file.
{
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, '{"mcpServers":{"old":{"command":"o","args":[]}}}');
  writeAtomic(p, '{"mcpServers":{}}');
  assert.ok(existsSync(p + '.bak'), 'backup written');
  assert.ok(readFileSync(p + '.bak', 'utf8').includes('old'), 'backup has prior content');
}
// invalid JSON that is NOT recoverable -> refuse (never clobber an unparseable user config).
{
  assert.throws(() => mergeServer('{ this is : not json ]', 'redlib-mcp', { command: 'c', args: [] }), /valid JSON|refus/i);
}
console.log('ALL PASS');
