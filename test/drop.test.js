import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-drop-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const { build } = await import('../src/model.js');
const { contextMap } = await import('../src/map.js');
const { applySurgery } = await import('../src/surgery.js');
const { parseSession } = await import('../src/session.js');
const { makeFork } = await import('../plugins/ctxtree/core/fork.js');
const { turnBreaks } = await import('../plugins/ctxtree/core/restructure.js');

const PROJECT = '-tmp-drop';
const dir = path.join(CLAUDE, 'projects', PROJECT);
fs.mkdirSync(dir, { recursive: true });
const model = () => build(path.join(CLAUDE, 'projects'));
const leaves = (n, out = []) => { if (n.kids) n.kids.forEach(k => leaves(k, out)); else out.push(n); return out; };
const find = (n, pred) => { if (pred(n)) return n; for (const k of n.kids || []) { const f = find(k, pred); if (f) return f; } return null; };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Two tasks. The first reads a file, then runs two commands in one message
// (parallel calls: the second result hangs off its own call), with a hook
// record about one of them; the second asks with an image. Claude Code's
// request journal copies the first prompt.
function session() {
  const sid = crypto.randomUUID();
  const base = { sessionId: sid, cwd: '/tmp/drop', version: '2.1.312', userType: 'external', isSidechain: false };
  const recs = [];
  let parent = null, n = 0;
  const push = (r) => { const rec = { ...base, uuid: r.uuid || `r${++n}`, parentUuid: r.parentUuid !== undefined ? r.parentUuid : parent, timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, recs.length)).toISOString(), ...r }; recs.push(rec); parent = rec.uuid; return rec; };
  const usage = { input_tokens: 2000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const asst = (uuid, id, content) => push({ type: 'assistant', uuid, message: { id, role: 'assistant', model: 'claude', content, usage } });
  const result = (uuid, tuid, text, extra = {}) => push({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: text }] }, toolUseResult: text, ...extra });

  push({ type: 'user', uuid: 'p1', message: { role: 'user', content: 'Find the SECRET-ONE bug in the parser please' } });
  asst('a1', 'msg_a', [{ type: 'text', text: 'Let me look at the parser.' }]);
  asst('a2', 'msg_a', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/drop/parser.js' } }]);
  result('r1', 't1', 'parser source '.repeat(200));
  asst('b1', 'msg_b', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd /tmp/drop && npm test', description: 'Run the tests' } }]);
  asst('b2', 'msg_b', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git status' } }]);
  result('r3', 't3', 'clean');
  recs.push({ ...base, type: 'user', uuid: 'r2', parentUuid: 'b1', timestamp: recs[recs.length - 1].timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'FAIL '.repeat(400) }] }, toolUseResult: 'FAIL' });
  push({ type: 'attachment', uuid: 'h1', toolUseID: 't2', attachment: { type: 'hook_success', content: 'hook ran after npm test' }, rendered: [{ content: 'hook ran after npm test' }] });
  asst('c1', 'msg_c', [{ type: 'text', text: 'Fixed the SECRET-ONE bug.' }]);
  recs.push({ type: 'last-prompt', lastPrompt: 'Find the SECRET-ONE bug in the parser please', leafUuid: 'c1', sessionId: sid });
  recs.push({ type: 'api-request-blob', sessionId: sid, hash: 'h', message: { role: 'user', content: 'Find the SECRET-ONE bug in the parser please' } });
  recs.push({ type: 'api-request', sessionId: sid, id: 'q1', keep: 0, tail: ['h'] });
  push({ type: 'user', uuid: 'p2', message: { role: 'user', content: [{ type: 'text', text: 'Now look at this screenshot of the page' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.repeat(200) } }] } });
  asst('d1', 'msg_d', [{ type: 'text', text: 'The page looks right.' }]);
  recs.push({ type: 'last-prompt', lastPrompt: 'Now look at this screenshot of the page', leafUuid: 'd1', sessionId: sid });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  return sid;
}

const fork = (r) => fs.readFileSync(r.forkFile, 'utf8');
const uuids = (raw) => raw.split('\n').filter(Boolean).map(l => JSON.parse(l).uuid).filter(Boolean);

test('drop: a tool step goes whole -- every call in its message, their results, and what was written about them', () => {
  const sid = session();
  const md = model();
  const m = contextMap(md, sid);
  const run = find(m.tasks, n => n.name === 'Run the tests');
  assert.ok(run, 'a Bash call is named by its description');
  assert.equal(run.acts.length, 1);
  assert.equal(run.acts[0].k, 'drop');
  // the parallel call shares the step
  const status = find(m.tasks, n => n.name === 'Ran git status');
  assert.equal(status.acts[0].id, run.acts[0].id);
  const r = applySurgery(md, { sid, drop: [run.acts[0].id] });
  const raw = fork(r);
  const got = uuids(raw);
  for (const u of ['b1', 'b2', 'r2', 'r3', 'h1']) assert.ok(!got.includes(u), `${u} is gone`);
  for (const u of ['p1', 'a1', 'a2', 'r1', 'c1', 'p2', 'd1']) assert.ok(got.includes(u), `${u} stays`);
  const p = parseSession(raw);
  assert.equal(p.byUuid.get('c1').parentUuid, 'r1', 'what followed continues from what came before');
  assert.equal(p.leafUuid, 'd1');
  assert.ok(!raw.includes('npm test') && !raw.includes('FAIL'));
  assert.ok(r.resume.saved > 0);
});

test('drop: your message takes its whole task, and leaves no trace of what you wrote', () => {
  const sid = session();
  const md = model();
  const m = contextMap(md, sid);
  const prompt = find(m.tasks, n => n.t === 'prompt' && /SECRET-ONE bug in the parser/.test(n.name));
  const last = find(m.tasks, n => n.t === 'reply' && /Fixed the/.test(n.name));
  assert.equal(prompt.acts[0].id, last.acts[0].id, 'Claude\'s last words go with the task');
  assert.equal(prompt.acts[0].task, prompt.acts[0].id);
  const task = m.tasks.kids.find(k => k.name.startsWith('Find the SECRET-ONE'));
  const keys = [...new Set(leaves(task).flatMap(l => l.acts.map(a => a.id)))];
  const r = applySurgery(md, { sid, drop: keys });
  const raw = fork(r);
  assert.ok(!raw.includes('SECRET-ONE'), 'not in a message, the journal, or the last-prompt pointer');
  const p = parseSession(raw);
  assert.equal(p.order.map(u => p.byUuid.get(u)).filter(o => o.type === 'user' || o.type === 'assistant')[0].uuid, 'p2');
  assert.equal(turnBreaks(p), 0);
  // the fork's own map has one task left
  const m2 = contextMap(model(), r.forkSid);
  assert.deepEqual(m2.tasks.kids.filter(k => k.t === 'task' && k.id.startsWith('g:task:')).map(k => k.name), ['Now look at this screenshot of the page']);
});

test('drop: an image comes out of your message and your words stay', () => {
  const sid = session();
  const md = model();
  const img = find(contextMap(md, sid).tree, n => n.t === 'image' && !n.kids);
  assert.equal(img.acts[0].k, 'img');
  const r = applySurgery(md, { sid, edits: [{ id: img.acts[0].id, fp: img.acts[0].fp, op: 'remove' }] });
  const p = parseSession(fork(r));
  assert.deepEqual(p.byUuid.get('p2').message.content, [{ type: 'text', text: 'Now look at this screenshot of the page' }]);
  assert.ok(r.resume.saved > 0);
});

test('drop: what would break the conversation is refused, and nothing is written', () => {
  const sid = session();
  const md = model();
  const raw = fs.readFileSync(path.join(dir, `${sid}.jsonl`), 'utf8');
  const fid = crypto.randomUUID();
  // your second message alone: Claude's two replies would sit back to back
  assert.throws(() => makeFork(raw, { parentSid: sid, forkSid: fid, structure: [{ op: 'drop', recs: ['p2'] }] }), (e) => e.problems.some(p => /back to back/.test(p.error)));
  // everything: nothing left to resume
  const all = raw.split('\n').filter(Boolean).map(l => JSON.parse(l).uuid).filter(Boolean);
  assert.throws(() => makeFork(raw, { parentSid: sid, forkSid: fid, structure: [{ op: 'drop', recs: all }] }), (e) => e.problems.some(p => /nothing would be left/.test(p.error)));
  // a unit the session no longer has
  assert.throws(() => applySurgery(md, { sid, drop: ['step:nope'] }), /no longer in this session/);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).length, fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).length);
});

test('drop: any fork leaves the request journal behind', () => {
  const sid = session();
  const md = model();
  const att = find(contextMap(md, sid).tree, n => n.t === 'attach' && !n.kids);
  const r = applySurgery(md, { sid, drop: [att.acts[0].id] });
  const raw = fork(r);
  assert.ok(!raw.includes('"api-request'));
  assert.ok(!uuids(raw).includes('h1'));
  assert.equal(r.journal, true);
});
