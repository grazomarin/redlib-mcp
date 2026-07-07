import assert from 'node:assert';
import { REDLIB_PIN } from '../dist/pin.js';
import { dataDir, cloneDir } from '../dist/paths.js';

// Pin is a 40-char immutable SHA (a reviewed main commit, not a tag) — spec §6.1.
assert.match(REDLIB_PIN.sha, /^[0-9a-f]{40}$/, 'pin.sha must be a full 40-hex commit SHA');
assert.ok(REDLIB_PIN.repo.includes('redlib-org/redlib'), 'pin.repo points at upstream Redlib');

// Per-OS data dir (spec §14 open question). Env + platform injectable so this is testable off-host.
const lin = dataDir({ XDG_DATA_HOME: '/x/share' }, 'linux');
assert.equal(lin, '/x/share/redlib-mcp', 'linux honors XDG_DATA_HOME');
const linDefault = dataDir({ HOME: '/home/u' }, 'linux');
assert.ok(linDefault.endsWith('/.local/share/redlib-mcp'), `linux default, got ${linDefault}`);
const mac = dataDir({ HOME: '/Users/u' }, 'darwin');
assert.equal(mac, '/Users/u/Library/Application Support/redlib-mcp', `mac, got ${mac}`);
const win = dataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32');
assert.ok(win.includes('redlib-mcp'), `win, got ${win}`);
assert.ok(cloneDir({ XDG_DATA_HOME: '/x/share' }, 'linux').endsWith('/redlib-mcp/redlib-src'), 'cloneDir under dataDir');
console.log('ALL PASS');
