import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const V = JSON.parse(readFileSync('package.json', 'utf8')).version;

// plugin.json version field
const plg = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
assert.equal(plg.version, V, `plugin.json version ${plg.version} must equal package.json ${V}`);

// .mcp.json pinned arg
const mcp = JSON.parse(readFileSync('.mcp.json', 'utf8'));
const mcpPin = mcp.mcpServers.redlib.args.find(a => /^redlib-mcp@/.test(a));
assert.equal(mcpPin, `redlib-mcp@${V}`, `.mcp.json pin ${mcpPin} must be redlib-mcp@${V}`);

// every redlib-mcp@<semver> literal in SKILL.md and README must match V
for (const file of ['skills/setup-redlib/SKILL.md', 'README.md']) {
  const pins = [...readFileSync(file, 'utf8').matchAll(/redlib-mcp@(\d+\.\d+\.\d+)/g)];
  assert.ok(pins.length > 0, `${file} must contain at least one redlib-mcp@<version> pin`);
  for (const m of pins)
    assert.equal(m[1], V, `${file} pin redlib-mcp@${m[1]} must equal package.json ${V}`);
}

console.log('ALL PASS');
