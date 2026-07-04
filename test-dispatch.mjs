import assert from 'node:assert';
import { spawn } from 'node:child_process';

// Send a REAL MCP initialize over stdin and assert the FIRST stdout byte is '{'.
// Fail on early child exit or empty stdout — a crashed serve must NOT pass. (initialize
// is answered by the server itself; it does not touch the Redlib backend, so this runs
// without a live Redlib.)
function serveProbe() {
  return new Promise((res) => {
    const c = spawn('node', ['dist/entry.js', 'serve'], { env: { ...process.env, REDLIB_URL: 'http://127.0.0.1:8080' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', exited = null;
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('exit', (code) => { exited = code; });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    setTimeout(() => { c.kill(); res({ out, err, exited }); }, 1500);
  });
}
function runCmd(args) {
  return new Promise((res) => {
    const c = spawn('node', ['dist/entry.js', ...args], { env: { ...process.env, REDLIB_URL: 'http://127.0.0.1:8080' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.stdin.end(''); setTimeout(() => { c.kill(); res({ out, err }); }, 800);
  });
}

const server = await serveProbe();
assert.equal(server.exited, null, `serve must not exit early (exited=${server.exited}, stderr=${server.err.slice(0,200)})`);
assert.ok(server.out.length > 0, 'serve must emit a JSON-RPC response to initialize (empty stdout is NOT a pass)');
assert.equal(server.out[0], '{', `first stdout byte must be '{' (got ${JSON.stringify(server.out.slice(0, 40))})`);

const doctor = await runCmd(['doctor']);
// doctor now runs for real; with no engine/daemon in CI it still prints a diagnostic and exits non-zero.
assert.ok(/engine|container|docker|daemon/i.test(doctor.out + doctor.err), 'doctor should print a real diagnostic line');
console.log('ALL PASS');
