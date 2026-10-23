import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// HTTP transport (USE_HTTP=true): one server process must serve several MCP clients at once —
// a shared local instance is the point of HTTP mode. initialize/tools/list are answered by the
// server itself, so this runs without a live Redlib backend.
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const TOKEN = 'test-token';
const URL = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn('node', ['dist/entry.js', 'serve'], {
  env: { ...process.env, USE_HTTP: 'true', PORT: String(PORT), REDLIB_MCP_TOKEN: TOKEN, REDLIB_URL: 'http://127.0.0.1:8080' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start: ${stderr.slice(0, 300)}`)), 8000);
  child.stderr.on('data', (d) => { stderr += d; if (stderr.includes(`127.0.0.1:${PORT}/mcp`)) { clearTimeout(t); res(); } });
  child.on('exit', (code) => { clearTimeout(t); rej(new Error(`server exited early (${code}): ${stderr.slice(0, 300)}`)); });
});

// The transport may answer as JSON or as a one-event SSE stream depending on Accept.
async function rpc(body, { token = TOKEN, method = 'POST', url = URL } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  let json = null;
  try { json = JSON.parse(line ? line.slice(6) : text); } catch {}
  return { status: r.status, json };
}
const init = (name) => rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } } });

try {
  const a = await init('client-a');
  assert.equal(a.status, 200, `first client initialize: ${JSON.stringify(a.json)}`);
  assert.equal(a.json?.result?.serverInfo?.name, 'redlib-mcp');

  const b = await init('client-b');
  assert.equal(b.status, 200, `a second client must also initialize, got ${b.status}: ${JSON.stringify(b.json)}`);
  assert.equal(b.json?.result?.serverInfo?.name, 'redlib-mcp');

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(tools.status, 200, `tools/list: ${JSON.stringify(tools.json)}`);
  assert.deepEqual(tools.json.result.tools.map((t) => t.name).sort(), ['get_post', 'get_subreddit_posts', 'get_user_activity', 'search_reddit']);

  assert.equal((await rpc({}, { token: '' })).status, 401, 'missing bearer must be rejected');
  assert.equal((await rpc({}, { url: `http://127.0.0.1:${PORT}/other` })).status, 404, 'only /mcp is served');
  assert.equal((await rpc(null, { method: 'GET' })).status, 405, 'GET (server-push stream) is not offered');
  console.log('ALL PASS');
} finally {
  child.kill();
}
