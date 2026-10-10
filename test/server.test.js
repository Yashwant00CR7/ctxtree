import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-srv-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const { makeFixture, bid } = await import('./fixture.js');
const fx = makeFixture(CLAUDE);
const { CtxServer } = await import('../src/server.js');

let srv, port, token;
const log = console.log;
before(async () => {
  console.log = () => {};
  srv = new CtxServer({ port: 40000 + Math.floor(Math.random() * 9000) });
  ({ port } = await srv.start());
  console.log = log;
  token = srv.token;
});
after(() => srv.stop());

function req(method, p, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { Host: host || `localhost:${port}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let buf = ''; res.on('data', c => { buf += c; });
      res.on('end', () => { let json; try { json = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text: buf, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const api = (method, p, body, extra = {}) => req(method, p, {
  body, headers: { 'X-Ctxtree-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra } });

test('binds to loopback only', () => {
  assert.equal(srv.server.address().address, '127.0.0.1');
});

test('the page carries the token and a script-locking CSP', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`<meta name="ctxtree-token" content="${token}">`));
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('API refuses callers without the token', async () => {
  assert.equal((await req('GET', '/api/stats')).status, 403);
  assert.equal((await req('GET', '/api/stats', { headers: { 'X-Ctxtree-Token': 'x'.repeat(48) } })).status, 403);
  assert.equal((await api('GET', '/api/stats')).status, 200);
});

test('DNS rebinding: a foreign Host header is refused', async () => {
  const r = await req('GET', '/api/stats', { host: 'evil.example:80', headers: { 'X-Ctxtree-Token': token } });
  assert.equal(r.status, 421);
});

test('cross-origin writes are refused, and preflight never succeeds', async () => {
  assert.equal((await req('OPTIONS', '/api/context/save')).status, 405);
  const r = await api('POST', '/api/revert', { forkSid: fx.sid }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('POST must be JSON; bad sids are rejected', async () => {
  const r = await req('POST', '/api/refresh', { body: 'x', headers: { 'X-Ctxtree-Token': token, 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
  assert.equal((await api('GET', '/api/context?sid=../../etc')).status, 400);
});

test('static files cannot escape the ui directory', async () => {
  const r = await req('GET', '/..%2F..%2F..%2F..%2Fetc%2Fpasswd');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('root:'), 'must not serve /etc/passwd');
  assert.ok(r.text.includes('<html') || r.text.includes('<!DOCTYPE'));
});

test('full flow: load, edit, fork, reject a locked edit, revert', async () => {
  const ctx = (await api('GET', `/api/context?sid=${fx.sid}`)).json;
  assert.ok(ctx.blocks.length > 0);
  const r3 = ctx.blocks.find(b => b.uuid === 'r3');
  assert.equal(r3.live, true);
  assert.equal(r3.editable, true);
  assert.ok(r3.fp);
  assert.ok(ctx.deadBlocks > 0, 'pre-compaction and abandoned-branch blocks are flagged');

  const locked = await api('POST', '/api/context/save', { sid: fx.sid, edits: [{ id: bid('t1'), newText: 'x' }] });
  assert.equal(locked.status, 400);
  assert.match(locked.json.problems[0].error, /Signed thinking/);

  const saved = await api('POST', '/api/context/save', { sid: fx.sid, edits: [{ id: r3.id, fp: r3.fp, newText: '[big.js: 4000 lines of `const x = 1;`]', tokBefore: 1, tokAfter: 999999 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.ok(saved.json.savedTok > 10000, 'savings are computed server-side, not taken from the client');
  assert.ok(fs.existsSync(saved.json.forkFile));

  const forks = (await api('GET', '/api/forks')).json;
  assert.ok(forks.some(f => f.forkSid === saved.json.forkSid && f.grown === false));

  const rv = await api('POST', '/api/revert', { forkSid: saved.json.forkSid });
  assert.equal(rv.status, 200);
  assert.ok(!fs.existsSync(saved.json.forkFile));
});

test('prune endpoint tombstones by tool_use_id', async () => {
  const r = await api('POST', '/api/prune', { sid: fx.sid, tuids: ['toolu_read2'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const missing = await api('POST', '/api/prune', { sid: fx.sid, tuids: ['toolu_nope'] });
  assert.equal(missing.status, 400);
});
