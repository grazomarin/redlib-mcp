import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// HTTP transport (USE_HTTP=true): one server process must serve several MCP clients at once —
// a shared local instance is the point of HTTP mode. initialize/tools/list are answered by the
// server itself, so this runs without a live Redlib backend.
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(token) {
  const port = await freePort();
  const env = { ...process.env, USE_HTTP: 'true', PORT: String(port), REDLIB_URL: 'http://127.0.0.1:8080' };
  delete env.REDLIB_MCP_TOKEN;
  if (token) env.REDLIB_MCP_TOKEN = token;
  const child = spawn('node', ['dist/entry.js', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`server did not start: ${stderr.slice(0, 300)}`)), 8000);
      child.stderr.on('data', (d) => { stderr += d; if (stderr.includes(`127.0.0.1:${port}/mcp`)) { clearTimeout(t); res(); } });
      child.on('exit', (code) => { clearTimeout(t); rej(new Error(`server exited early (${code}): ${stderr.slice(0, 300)}`)); });
    });
  } catch (e) { child.kill(); throw e; }
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

// The transport may answer as JSON or as a one-event SSE stream depending on Accept.
async function rpc(url, body, { token, method = 'POST', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  const r = await fetch(url, { method, headers: h, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  let json = null;
  try { json = JSON.parse(line ? line.slice(6) : text); } catch {}
  return { status: r.status, json };
}
const initialize = (name) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } } });
const toolsList = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
const TOOLS = ['get_post', 'get_subreddit_posts', 'get_user_activity', 'search_reddit'];

const TOKEN = 'test-token';
const servers = [];
try {
  const shared = await startServer(TOKEN); servers.push(shared);
  const open = await startServer(null); servers.push(open);
  const call = (body, opts = {}) => rpc(shared.url, body, { token: TOKEN, ...opts });

  // Concurrent clients reusing the same JSON-RPC id must each complete their own handshake.
  const inits = await Promise.all(['a', 'b', 'c'].map((n) => call(initialize(`client-${n}`))));
  for (const r of inits) {
    assert.equal(r.status, 200, `every concurrent client must initialize, got ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json?.id, 1);
    assert.equal(r.json?.result?.serverInfo?.name, 'redlib-mcp');
    assert.equal(r.json?.result?.protocolVersion, '2025-06-18');
    assert.ok(r.json?.result?.capabilities?.tools, 'initialize must advertise tools');
  }
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202, 'notifications/initialized is accepted');

  const ids = [7, 7, 8];
  const lists = await Promise.all(ids.map((id) => call(toolsList(id))));
  lists.forEach((r, i) => {
    assert.equal(r.status, 200, `tools/list: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.id, ids[i], 'each response answers its own request');
    assert.deepEqual(r.json.result.tools.map((t) => t.name).sort(), TOOLS);
  });

  assert.equal((await rpc(shared.url, toolsList(2))).status, 401, 'missing bearer must be rejected');
  assert.equal((await call(toolsList(2), { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'wrong bearer must be rejected');
  assert.equal((await rpc(shared.url.replace('/mcp', '/other'), {}, { token: TOKEN })).status, 404, 'only /mcp is served');
  assert.equal((await call(null, { method: 'GET' })).status, 405, 'GET (server-push stream) is not offered');

  // A web page can POST with a CORS-safelisted Content-Type (no preflight) that still contains
  // "application/json"; without a token, only the Origin check stands between it and the tools.
  const attack = await rpc(open.url, toolsList(3), { headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain; x=application/json' } });
  assert.equal(attack.status, 403, `a foreign browser Origin must be rejected, got ${attack.status}: ${JSON.stringify(attack.json)}`);
  assert.equal((await rpc(open.url, toolsList(4))).status, 200, 'clients that send no Origin (agents, CLIs) are unaffected');
  console.log('ALL PASS');
} finally {
  for (const s of servers) s.child.kill();
}
