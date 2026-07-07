// End-to-end MCP test against live Redlib. Spawns the server, does the JSON-RPC
// handshake over stdio, exercises every tool + the failure path.
import { spawn } from 'node:child_process';

const child = spawn('node', ['dist/entry.js', 'serve'], {
  env: { ...process.env, REDLIB_URL: 'http://127.0.0.1:8080' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
let idc = 1;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = idc++; waiters.set(id, res);
  setTimeout(() => rej(new Error(`timeout ${method}`)), 40000);
  send({ jsonrpc: '2.0', id, method, params });
});
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const raw = (r) => r.result?.content?.[0]?.text ?? '';
const data = (r) => JSON.parse(raw(r));
const isErr = (r) => !!r.result?.isError;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); cond ? pass++ : fail++; };

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 1. browse + cursor + reddit.com url
  const b = await call('get_subreddit_posts', { subreddit: 'selfhosted', sort: 'top', time: 'week', limit: 3 });
  const bd = data(b);
  check('browse returns posts', bd.posts?.length > 0, `${bd.posts?.length} posts`);
  check('browse: reddit.com permalink', bd.posts[0].url?.startsWith('https://www.reddit.com'));
  check('browse: next_after cursor', typeof bd.next_after === 'string', bd.next_after);
  const first = bd.posts[0];

  // 2. get_post: compact + reddit_url + comments
  const p = await call('get_post', { subreddit: first.subreddit, postId: first.id, max_comments: 30 });
  const praw = raw(p), pd = data(p);
  check('get_post: reddit_url present', !!pd.reddit_url, pd.reddit_url);
  check('get_post: post_type present', !!pd.post_type, pd.post_type);
  check('get_post: comments returned', pd.comments_returned > 0, `${pd.comments_returned}/${pd.comments_in_page}`);
  check('get_post: COMPACT (no "is_op":false)', !praw.includes('"is_op":false'));
  check('get_post: COMPACT (no empty "replies":[])', !praw.includes('"replies":[]'));
  const findMore = (ns) => ns.reduce((a, n) => a || (n.more_id ? n : findMore(n.replies || [])), null);
  const withMore = findMore(pd.comments);
  check('get_post: some node has more_id (expandable)', !!withMore, withMore?.more_id || 'none found');

  // 3. comment expansion
  if (withMore) {
    const e = await call('get_post', { subreddit: first.subreddit, postId: first.id, comment_id: withMore.more_id });
    check('get_post: comment_id expansion works', !isErr(e) && data(e).comments_returned >= 1);
  }

  // 4. link post -> outbound url + post_type=link
  const tech = data(await call('get_subreddit_posts', { subreddit: 'technology', sort: 'top', time: 'week', limit: 8 }));
  let linkFound = false;
  for (const tp of tech.posts.slice(0, 8)) {
    const tpd = data(await call('get_post', { subreddit: tp.subreddit, postId: tp.id, max_comments: 1 }));
    if (tpd.post_type === 'link' && tpd.url?.startsWith('http')) { linkFound = true; check('link post: outbound url extracted', true, tpd.url.slice(0, 50)); break; }
  }
  if (!linkFound) check('link post: outbound url extracted', false, 'no link post in sample');

  // 5. search with sort
  const s = data(await call('search_reddit', { query: 'caddy nginx', subreddit: 'selfhosted', sort: 'top' }));
  check('search returns results', s.posts?.length > 0, `${s.posts?.length}`);

  // 6. get_user_activity (use an active account for a meaningful count)
  const u = await call('get_user_activity', { username: 'spez' });
  check('get_user_activity returns posts', !isErr(u) && data(u).resultCount > 0, `${data(u).resultCount} items`);

  // 7. ERROR PATH: nonexistent subreddit must isError (not silent empty)
  const bad = await call('get_subreddit_posts', { subreddit: 'zzz_nonexistent_sub_99999x' });
  check('bad subreddit -> isError (not silent 0)', isErr(bad), raw(bad).slice(0, 70));
  const badp = await call('get_post', { subreddit: 'selfhosted', postId: 'zzzzzz' });
  check('bad postId -> isError', isErr(badp), raw(badp).slice(0, 70));

  // 8. typed error kind on a down/bad path
  const badKind = await call('get_subreddit_posts', { subreddit: 'zzz_nonexistent_sub_99999x' });
  const bk = JSON.parse(raw(badKind));
  check('bad subreddit -> typed kind present', isErr(badKind) && typeof bk.kind === 'string', bk.kind);
  check('kind is a known enum', ['RATE_LIMITED','UPSTREAM_TOKEN_STALE','REDLIB_DOWN','CONTENT_UNAVAILABLE','PARSE_ERROR'].includes(bk.kind), bk.kind);

  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('TEST HARNESS ERROR:', e.message); process.exitCode = 1;
} finally {
  child.kill();
}
