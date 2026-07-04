import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync('server.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert.equal(j.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
assert.equal(j.name, 'io.github.grazomarin/redlib-mcp', 'registry id is io.github.grazomarin/redlib-mcp');
assert.ok(!/reddit/i.test(j.name), 'trademark-salient id must not contain "reddit"');
assert.equal(j.version, pkg.version, 'server.json version tracks package.json');
const p = j.packages?.[0];
assert.ok(p, 'must declare a package');
assert.equal(p.registryType, 'npm');
assert.equal(p.identifier, 'redlib-mcp', 'identifier is the RENAMED npm package (not redlib-mcp-server)');
assert.equal(p.version, pkg.version, 'package version tracks package.json');
assert.equal(p.transport?.type, 'stdio');
assert.ok(p.packageArguments?.some(a => a.value === 'serve'), 'runs the `serve` subcommand');
// REDLIB_URL is OPTIONAL for us (defaults to loopback) — never marked required/secret
const env = (p.environmentVariables || []).find(e => e.name === 'REDLIB_URL');
if (env) assert.ok(!env.isRequired, 'REDLIB_URL must not be marked required (it defaults to 127.0.0.1:8080)');
console.log('ALL PASS');
