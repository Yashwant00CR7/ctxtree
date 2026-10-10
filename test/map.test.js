import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-map-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const F = await import('./fixture-boot.js');
const fx = F.makeBootFixture(CLAUDE);
const { build } = await import('../src/model.js');
const { contextMap, blockPreview } = await import('../src/map.js');
const { applySurgery } = await import('../src/surgery.js');
const { shrinkInput } = await import('../src/fork.js');
const { parseSession } = await import('../src/session.js');

const model = () => build(path.join(CLAUDE, 'projects'));
const leaves = (n, out = []) => { if (n.kids) n.kids.forEach(k => leaves(k, out)); else out.push(n); return out; };
const find = (n, pred) => { if (pred(n)) return n; for (const k of n.kids || []) { const f = find(k, pred); if (f) return f; } return null; };

test('map: one tree of the resumed context, sized, every group the sum of its parts', () => {
  const m = contextMap(model(), fx.sid);
  assert.deepEqual(m.tree.kids.map(k => k.name).sort(), ['Conversation', 'Setup']);
  const check = (n) => { if (!n.kids) return; assert.equal(n.tok, n.kids.reduce((a, k) => a + k.tok, 0), n.name); n.kids.forEach(check); };
  check(m.tree); check(m.grey);
  // ids are unique across both trees (the UI indexes by id)
  const ids = [...leaves(m.tree), ...leaves(m.grey)].map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
  // nothing outside the resumed context is offered as a deletion
  assert.ok(leaves(m.grey).every(l => !l.acts.length && l.lock));
});

test('map: setup items carry their boot removal; managed ones are locked', () => {
  const m = contextMap(model(), fx.sid);
  const beta = find(m.tree, n => n.id === 'boot:mcp:beta');
  assert.deepEqual(beta.acts, [{ k: 'boot', id: 'mcp:beta', save: beta.tok }]);
  assert.ok(beta.profile && beta.info);
  assert.equal(find(m.tree, n => n.id === 'g:boot:skills').kids.length, 3);
});

test('map: grey groups carry the structural ops that apply to them', () => {
  const m = contextMap(model(), fx.sid);
  const pre = find(m.grey, n => n.id === 'g:compacted');
  assert.deepEqual(pre.ops.map(o => o.op), ['uncompact', 'slim']);
  const br = m.grey.kids.find(k => k.id.startsWith('g:branch:'));
  assert.equal(br.ops[0].op, 'switch');
  assert.equal(br.ops[0].tip, 'x2');
});

test('map: every deletable leaf, marked at once, builds a verified fork', () => {
  const md = model();
  const m = contextMap(md, fx.sid);
  const edits = [], boot = [];
  for (const l of leaves(m.tree)) for (const a of l.acts) {
    if (a.k === 'block') edits.push({ id: a.id, fp: a.fp, op: a.op || 'tombstone' });
    else boot.push(a.id);
  }
  assert.ok(boot.length, 'setup items are offered');
  const r = applySurgery(md, { sid: fx.sid, edits, boot, dryRun: true });
  assert.ok(r.ok && r.resume.saved > 0);
});

test('shrink: long strings in a tool call keep their head and say what went', () => {
  const big = 'x'.repeat(5000);
  const out = shrinkInput({ file_path: '/a/b.js', content: big, nested: { old_string: big, n: 3 } });
  assert.equal(out.file_path, '/a/b.js');
  assert.match(out.content, /^x{120}\n\[ctxtree: removed 4,880 more characters/);
  assert.match(out.nested.old_string, /ctxtree: removed/);
  assert.equal(out.nested.n, 3);
  assert.equal(shrinkInput({ file_path: '/a', content: 'short' }), null);
});

test('shrink: a big Write call is offered, shrinks in the fork, and keeps its pairing', () => {
  // a session whose live tail is a Write with a large input and its result
  const sid = crypto.randomUUID();
  const dir = path.join(CLAUDE, 'projects', F.PROJECT);
  const base = { sessionId: sid, cwd: '/tmp/x', version: '2.1.283', userType: 'external', isSidechain: false };
  const ts = (i) => new Date(Date.UTC(2026, 8, 2, 10, 0, i)).toISOString();
  const recs = [
    { ...base, type: 'user', uuid: 'w1', parentUuid: null, timestamp: ts(1), message: { role: 'user', content: 'write it' } },
    { ...base, type: 'assistant', uuid: 'w2', parentUuid: 'w1', timestamp: ts(2), message: { id: 'msg_w', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/tmp/x/a.js', content: 'line\n'.repeat(4000) } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { ...base, type: 'user', uuid: 'w3', parentUuid: 'w2', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'File created' }] }, toolUseResult: { type: 'create' } },
    { ...base, type: 'assistant', uuid: 'w4', parentUuid: 'w3', timestamp: ts(4), message: { id: 'msg_w2', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const md = model();
  const m = contextMap(md, sid);
  const call = find(m.tree, n => n.t === 'call' && !n.kids);
  const [a] = call.acts;
  assert.equal(a.op, 'shrink');
  assert.ok(a.save > call.tok * 0.9, 'nearly all of it is reclaimable');
  // in the task view the call and its result are one item with both actions
  const item = find(contextMap(md, sid).tasks, n => n.id === `s:${a.id}`);
  assert.equal(item.name, 'Wrote a.js');
  // ("File created" is already smaller than the note that would replace it)
  assert.deepEqual(item.acts.map(x => x.op || 'tombstone'), ['shrink']);
  const r = applySurgery(md, { sid, edits: [{ id: a.id, fp: a.fp, op: 'shrink' }] });
  const fork = parseSession(fs.readFileSync(r.forkFile, 'utf8'));
  const use = fork.blocks.find(b => b.blockType === 'tool_use');
  assert.ok(use.chars < 400 && /ctxtree: removed/.test(use.text));
  assert.equal(fork.blocks.find(b => b.blockType === 'tool_result').tuid, 'toolu_w');
  // the shrunk fork no longer offers it
  const m2 = contextMap(build(path.join(CLAUDE, 'projects')), r.forkSid);
  assert.ok(!find(m2.tree, n => n.t === 'call' && !n.kids && n.acts.length));
});

test('block preview: bounded, and only for blocks in this session', () => {
  const md = model();
  const m = contextMap(md, fx.sid);
  const reply = find(m.tree, n => n.t === 'reply' && !n.kids);
  const b = blockPreview(md, fx.sid, reply.id);
  assert.match(b.text, /BRANCH-B-REPLY|PRESERVED-REPLY/);
  assert.throws(() => blockPreview(md, fx.sid, 'b_nope_0'), /No such block/);
});

test('tasks: one folder per request, the same actions as the type view, nothing lost', () => {
  const md = model();
  const m = contextMap(md, fx.sid);
  const keys = (root) => { const out = []; for (const l of leaves(root)) for (const a of l.acts) out.push(a.k === 'boot' ? `boot:${a.id}` : a.id); return out.sort(); };
  assert.deepEqual(keys(m.tasks), keys(m.tree));
  assert.equal(m.tasks.tok, m.tree.tok);
  const tasks = m.tasks.kids.filter(k => k.id.startsWith('g:task:'));
  assert.deepEqual(tasks.map(t => t.name), ['Actually do it differently. BRANCH-B']);
  assert.ok(tasks[0].latest);
  // the compaction summary and the slash command land in "Before the compaction", not as tasks
  const earlier = m.tasks.kids.find(k => k.id === 'g:earlier');
  assert.ok(leaves(earlier).some(l => l.name.startsWith('Summary of everything')));
});

test('tasks: re-reads and re-runs mark the older copy out of date', () => {
  const sid = crypto.randomUUID();
  const dir = path.join(CLAUDE, 'projects', F.PROJECT);
  const base = { sessionId: sid, cwd: '/tmp/x', version: '2.1.283', userType: 'external', isSidechain: false };
  let i = 0, parent = null;
  const recs = [];
  const push = (r) => { const rec = { ...base, uuid: `q${++i}`, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 8, 3, 10, 0, i)).toISOString(), ...r }; recs.push(rec); parent = rec.uuid; };
  const call = (id, name, input) => push({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', model: 'c', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id, text) => push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  push({ type: 'user', message: { role: 'user', content: 'Look at the parser please' } });
  call('t1', 'Read', { file_path: '/tmp/x/parser.js' }); result('t1', 'v1 '.repeat(500));
  call('t2', 'Bash', { command: 'npm test' }); result('t2', 'fail '.repeat(300));
  push({ type: 'user', message: { role: 'user', content: 'Now fix the failing test' } });
  call('t3', 'Edit', { file_path: '/tmp/x/parser.js', old_string: 'a', new_string: 'b' }); result('t3', 'ok');
  call('t4', 'Bash', { command: 'npm test' }); result('t4', 'pass');
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const m = contextMap(model(), sid);
  const [t1, t2] = m.tasks.kids.filter(k => k.id.startsWith('g:task:'));
  assert.equal(t1.name, 'Look at the parser please');
  assert.match(find(t1, n => n.name === 'Read parser.js').stale, /file changed at turn/);
  assert.match(find(t1, n => n.name === 'Ran npm test').stale, /ran again/);
  assert.ok(!find(t2, n => n.name === 'Ran npm test').stale, 'the latest run is not out of date');
  assert.deepEqual(t1.files, ['parser.js']);
  assert.ok(t2.latest);
});
