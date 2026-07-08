import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const HOOK = 'A private, self-hosted window into public Reddit for your AI agent — no login, no tracking, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.';

assert.equal(pkg.name, 'redlib-mcp', 'name is the renamed package (Plan 1)');
assert.equal(pkg.description, HOOK, 'npm description IS the master hook (verbatim)');
assert.equal(pkg.mcpName, 'io.github.grazomarin/redlib-mcp', 'mcpName matches server.json for registry ownership');
assert.ok(/grazomarin\/redlib-mcp/.test(pkg.repository?.url || ''), 'repository points at grazomarin');
for (const f of ['dist', 'skills', 'server.json', 'NOTICE'])
  assert.ok((pkg.files || []).includes(f), `files[] must ship ${f} (npm does NOT auto-include NOTICE)`);
assert.equal(pkg.publishConfig?.access, 'public', 'scoped/registry publish is public');
assert.ok(!(pkg.keywords || []).some(k => /bypass|evade|circumvent|scrape|harvest|dataset/i.test(k)), 'keywords carry no forbidden framing word');
// what actually gets packed. npm force-includes README + LICENSE but NOT NOTICE (verified: npm 11.6.2
// packlist) — so NOTICE must be in files[] or the AGPL/trademark notice ships nowhere.
// execSync runs a shell command string, which resolves npm -> npm.cmd on Windows natively (a bare
// execFileSync('npm') hits ENOENT, and execFileSync('npm.cmd') throws EINVAL post-CVE-2024-27980).
// The command is a static literal — no interpolation, no injection surface.
const packed = execSync('npm pack --dry-run --json', { encoding: 'utf8' });
const names = JSON.parse(packed)[0].files.map(f => f.path);
assert.ok(names.some(n => n.startsWith('skills/')), 'packed tarball includes the skill');
assert.ok(names.includes('server.json'), 'packed tarball includes server.json');
assert.ok(names.some(n => n === 'LICENSE') && names.some(n => n === 'NOTICE'), 'packed tarball includes LICENSE + NOTICE');
console.log('ALL PASS');
