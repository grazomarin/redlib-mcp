import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const mkt = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
const plg = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
const mcp = JSON.parse(readFileSync('.mcp.json', 'utf8'));

// marketplace.json — single-repo marketplace
assert.equal(mkt.name, 'redlib-mcp', 'marketplace name');
assert.equal(mkt.owner?.name, 'grazomarin', 'marketplace owner.name');
assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length === 1, 'exactly one plugin entry');
assert.equal(mkt.plugins[0].name, 'redlib-mcp', 'plugin entry name');
assert.equal(mkt.plugins[0].source, './', 'plugin entry source is the repo root');

// plugin.json — manifest
assert.equal(plg.name, 'redlib-mcp', 'plugin name');
assert.ok(!('defaultEnabled' in plg), 'no defaultEnabled key -> installs enabled (setup gates function, not enablement)');

// .mcp.json — auto-discovered MCP server: npx + serve + pinned, NO hardcoded env
assert.equal(mcp.mcpServers?.redlib?.command, 'npx', 'server command is npx');
assert.ok(mcp.mcpServers.redlib.args.includes('serve'), 'args include serve');
assert.ok(mcp.mcpServers.redlib.args.some(a => /^redlib-mcp@/.test(a)), 'args pin redlib-mcp@<v>');
assert.ok(!mcp.mcpServers.redlib.env, 'no hardcoded env (serve inherits the REDLIB_URL default)');

console.log('ALL PASS');
