import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-sapi-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const F = await import('./fixture-boot.js');
const fx = F.makeBootFixture(CLAUDE);
const { CtxServer } = await import('../src/server.js');

let srv, port, token;
const log = console.log;
before(async () => {
  console.log = () => {};
  srv = new CtxServer({ port: 41000 + Math.floor(Math.random() * 8000) });
  ({ port } = await srv.start());
  console.log = log;
  token = srv.token;
});
after(() => srv.stop());

function api(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      Host: `localhost:${port}`, 'X-Ctxtree-Token': token,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let buf = ''; res.on('data', c => { buf += c; });
      res.on('end', () => { let json; try { json = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('the new endpoints need the token like every other', async () => {
  for (const p of [`/api/map?sid=${fx.sid}`, `/api/block?sid=${fx.sid}&id=x`, `/api/boot?sid=${fx.sid}`, `/api/node-plan?sid=${fx.sid}&cat=boot`, `/api/structure?sid=${fx.sid}`]) {
    const r = await api('GET', p, undefined, { 'X-Ctxtree-Token': 'nope' });
    assert.equal(r.status, 403, p);
  }
  const w = await api('POST', '/api/fork', { sid: fx.sid, boot: ['mcp:beta'] }, { 'X-Ctxtree-Token': 'x'.repeat(48) });
  assert.equal(w.status, 403);
});

test('/api/map returns both trees; the page is served with its token', async () => {
  const r = await api('GET', `/api/map?sid=${fx.sid}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.tree.id, 'root');
  assert.equal(r.json.grey.id, 'grey');
  const page = await api('GET', '/');
  assert.match(page.text, /<meta name="ctxtree-token" content="[0-9a-f]+">/);
  assert.match(page.text, /src="app.js"/);
  const classic = await api('GET', '/classic/');
  assert.match(classic.text, /Context Surgeon/);
});

test('boot view lists removable items with how long each removal lasts', async () => {
  const r = await api('GET', `/api/boot?sid=${fx.sid}`);
  assert.equal(r.status, 200);
  const beta = r.json.items.find(i => i.id === 'mcp:beta');
  assert.ok(beta && beta.removable && beta.lasts && beta.needsProfile);
  const plan = r.json.items.find(i => i.id === 'agent:Plan');
  assert.equal(plan.needsProfile, false);
});

test('node plan: a boot node resolves to its items, a tools node to live results', async () => {
  const b = await api('GET', `/api/node-plan?sid=${fx.sid}&cat=boot&sub=${encodeURIComponent('MCP servers')}`);
  assert.equal(b.json.kind, 'boot');
  assert.deepEqual(b.json.items.map(i => i.id).sort(), ['mcp:alpha', 'mcp:beta']);
  const t = await api('GET', `/api/node-plan?sid=${fx.sid}&cat=tools&sub=Read`);
  assert.equal(t.json.kind, 'blocks');
  assert.equal(t.json.items.length, 0, 'every Read result is before the compaction');
  assert.equal(t.json.skipped.dead, 2);
  assert.match(t.json.note, /uncompact/);
  const c = await api('GET', `/api/node-plan?sid=${fx.sid}&cat=conversation`);
  assert.equal(c.json.kind, 'none');
  const all = await api('GET', '/api/node-plan?sid=all&cat=boot');
  assert.equal(all.status, 400);
});

test('structure view reports the restorable compaction and the branch', async () => {
  const r = await api('GET', `/api/structure?sid=${fx.sid}`);
  assert.ok(r.json.compaction.restorable);
  assert.equal(r.json.branches[0].tip, 'x2');
});

test('/api/fork: a dry run writes nothing; a real run writes the fork and its profile', async () => {
  const n = fs.readdirSync(fx.dir).length;
  const dry = await api('POST', '/api/fork', { sid: fx.sid, boot: ['mcp:beta'], structure: [{ op: 'uncompact' }], dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(dry.json.ok && dry.json.dryRun);
  assert.equal(fs.readdirSync(fx.dir).length, n);
  assert.ok(!fs.existsSync(dry.json.profileFile));

  const real = await api('POST', '/api/fork', { sid: fx.sid, boot: ['mcp:beta'], structure: [{ op: 'uncompact' }] });
  assert.equal(real.status, 200, real.text);
  assert.ok(fs.existsSync(real.json.forkFile) && fs.existsSync(real.json.profileFile));
  const forks = await api('GET', '/api/forks');
  const entry = forks.json.find(f => f.forkSid === real.json.forkSid);
  assert.match(entry.resumeCmd, /--settings/);
});

test('/api/fork: bad input is refused with the reason', async () => {
  const r = await api('POST', '/api/fork', { sid: fx.sid, structure: [{ op: 'switch', tip: 'x3' }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /already the resumed/);
  const s = await api('POST', '/api/fork', { sid: fx.sid, boot: 'mcp:beta' });
  assert.equal(s.status, 400);
});
