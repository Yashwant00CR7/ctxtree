import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox: nothing in these tests can reach your real ~/.claude.
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-test-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;

const { makeFixture, bid, BIG } = await import('./fixture.js');
const { parseSession } = await import('../src/session.js');
const { forkSession, verifyFork, buildFork, resolveEdits, revertFork, listForks, ForkError } = await import('../src/fork.js');

const read = (f) => fs.readFileSync(f, 'utf8');
const recs = (f) => read(f).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } });
const jsonlIn = (dir) => fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'));

test('parser: the resumed chain skips pre-compaction and abandoned-branch content', () => {
  const fx = makeFixture(CLAUDE);
  const p = parseSession(read(fx.file));
  const live = new Set(p.blocks.filter(b => b.live).map(b => b.uuid));
  assert.equal(p.leafUuid, 'x3');
  for (const u of ['s1', 'u3', 'tu3', 'r3', 'x3']) assert.ok(live.has(u), `${u} should be live`);
  for (const u of ['u1', 't1', 'tu1', 'r1', 'x1']) assert.ok(!live.has(u), `${u} is before the compaction`);
  for (const u of ['tu2', 'r2', 'x2']) assert.ok(!live.has(u), `${u} is on an abandoned branch`);
});

test('parser: a turn is a distinct API call, not a record', () => {
  const fx = makeFixture(CLAUDE);
  // 7 assistant records; msg_1 spans two of them -> 6 distinct calls
  assert.equal(parseSession(read(fx.file)).turns, 6);
});

test('parser: signed thinking is locked; ids are uuid-based', () => {
  const fx = makeFixture(CLAUDE);
  const p = parseSession(read(fx.file));
  const t = p.blocks.find(b => b.blockType === 'thinking');
  assert.equal(t.editable, false);
  assert.match(t.lock, /Signed thinking/);
  assert.equal(t.id, bid('t1'));
});

test('fork: tombstone lands, pairing holds, parent untouched, only session ids change elsewhere', () => {
  const fx = makeFixture(CLAUDE);
  const parentBefore = read(fx.file);
  const p = parseSession(parentBefore);
  const r3 = p.blocks.find(b => b.uuid === 'r3');
  const res = forkSession(fx.session, [{ id: r3.id, fp: r3.fp, op: 'tombstone' }]);

  assert.equal(read(fx.file), parentBefore, 'parent must be byte-identical');
  assert.ok(fs.existsSync(res.forkFile));
  assert.equal(fs.statSync(res.forkFile).mode & 0o777, 0o600, 'fork keeps the parent file mode');

  const a = parentBefore.split('\n'), b = read(res.forkFile).split('\n');
  assert.equal(a.length, b.length);
  const rows = recs(res.forkFile);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    const src = JSON.parse(a[i]);
    if (src.uuid === 'r3') continue;
    // unedited lines: identical bytes once the id swap is undone
    assert.equal(b[i].split(res.forkSid).join(fx.sid), a[i], `line ${i} changed beyond its session id`);
  }
  const out = rows.find(r => r && r.uuid === 'r3');
  assert.match(out.message.content[0].content, /^\[ctxtree: removed Read result for \/tmp\/big\.js/);
  assert.equal(out.toolUseResult, out.message.content[0].content, 'sidecar copy must match what the model sees');
  assert.equal(out.message.content[0].tool_use_id, 'toolu_read2');

  // session ids: parent's re-stamped, inherited ones preserved
  for (const r of rows) if (r && r.sessionId) assert.notEqual(r.sessionId, fx.sid);
  assert.equal(rows.find(r => r && r.uuid === 'x1').sessionId, fx.other);

  assert.ok(res.savedTok > 10000, 'a live 52k-char read should reclaim >10k tokens');
  assert.equal(res.deadEdits, 0);
  assert.equal(res.history, fs.existsSync(path.join(CLAUDE, 'file-history', res.forkSid)) ? res.history : 'missing');
  assert.ok(fs.existsSync(path.join(CLAUDE, 'file-history', res.forkSid, 'abc123@v1')));
  assert.match(res.resumeCmd, /^cd "\/tmp\/ctxtree-fixture" && claude --resume [0-9a-f-]{36}$/);
});

test('fork: a blank line and a corrupt line cannot shift an edit onto the wrong record', () => {
  const fx = makeFixture(CLAUDE, { blank: true, bad: true });
  const p = parseSession(read(fx.file));
  const x3 = p.blocks.find(b => b.uuid === 'x3');
  const res = forkSession(fx.session, [{ id: x3.id, fp: x3.fp, newText: 'Four thousand lines.' }]);
  const out = read(res.forkFile).split('\n');
  assert.ok(out.includes(''), 'blank line preserved');
  assert.ok(out.includes('{this is not json'), 'corrupt line preserved verbatim');
  const rows = recs(res.forkFile).filter(Boolean);
  assert.equal(rows.find(r => r.uuid === 'x3').message.content[0].text, 'Four thousand lines.');
  assert.equal(rows.find(r => r.uuid === 'x1').message.content[0].text, 'It declares x four thousand times.');
});

test('fork: a stale edit is refused and nothing is written', () => {
  const fx = makeFixture(CLAUDE);
  const before = jsonlIn(fx.dir).length;
  const x3 = parseSession(read(fx.file)).blocks.find(b => b.uuid === 'x3');
  assert.throws(() => forkSession(fx.session, [{ id: x3.id, fp: 'deadbeefdeadbeef', newText: 'x' }]),
    (e) => e instanceof ForkError && /changed after you loaded it/.test(e.problems[0].error));
  assert.equal(jsonlIn(fx.dir).length, before);
  assert.deepEqual(fs.readdirSync(fx.dir).filter(n => n.includes('ctxtree-tmp')), []);
});

test('fork: signed thinking cannot be edited', () => {
  const fx = makeFixture(CLAUDE);
  assert.throws(() => forkSession(fx.session, [{ id: bid('t1'), newText: 'different reasoning' }]),
    (e) => e instanceof ForkError && /Signed thinking/.test(e.problems[0].error));
});

test('fork: tool_use input must stay a JSON object; a valid one is applied', () => {
  const fx = makeFixture(CLAUDE);
  const id = bid('tu3');
  assert.throws(() => forkSession(fx.session, [{ id, newText: 'not json' }]), /rejected/);
  assert.throws(() => forkSession(fx.session, [{ id, newText: '"a string"' }]), (e) => /JSON object/.test(e.problems[0].error));
  assert.throws(() => forkSession(fx.session, [{ id, op: 'tombstone' }]), (e) => /tombstone its result/.test(e.problems[0].error));
  const res = forkSession(fx.session, [{ id, newText: '{"file_path":"/tmp/big.js","limit":10}' }]);
  const tu = recs(res.forkFile).find(r => r && r.uuid === 'tu3').message.content[0];
  assert.deepEqual(tu.input, { file_path: '/tmp/big.js', limit: 10 });
  assert.equal(tu.id, 'toolu_read2');
});

test('fork: emptied text becomes a tombstone, never an empty block the API rejects', () => {
  const fx = makeFixture(CLAUDE);
  const res = forkSession(fx.session, [{ id: bid('x3'), newText: '   \n ' }]);
  const t = recs(res.forkFile).find(r => r && r.uuid === 'x3').message.content[0].text;
  assert.match(t, /^\[ctxtree: removed/);
});

test('fork: string-form user content and image results are rewritten in a valid shape', () => {
  const fx = makeFixture(CLAUDE);
  const res = forkSession(fx.session, [
    { id: bid('u3'), newText: 'Count the lines.' },
    { id: bid('r2'), newText: '[screenshot of a login page]' },
  ]);
  const rows = recs(res.forkFile).filter(Boolean);
  assert.equal(rows.find(r => r.uuid === 'u3').message.content, 'Count the lines.');
  assert.equal(rows.find(r => r.uuid === 'r2').message.content[0].content, '[screenshot of a login page]');
  assert.equal(res.deadEdits, 1, 'r2 is on the abandoned branch: rewritten, but saves nothing on resume');
});

test('fork: no-op edits are dropped; all-no-op is an error, not an empty fork', () => {
  const fx = makeFixture(CLAUDE);
  const x3 = parseSession(read(fx.file)).blocks.find(b => b.uuid === 'x3');
  assert.throws(() => forkSession(fx.session, [{ id: x3.id, fp: x3.fp, newText: x3.text }]), /Nothing to change/);
});

test('fork: dry run verifies and reports but writes nothing', () => {
  const fx = makeFixture(CLAUDE);
  const before = fs.readdirSync(fx.dir).length;
  const res = forkSession(fx.session, [{ id: bid('r3'), op: 'tombstone' }], { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.ok(res.savedTok > 0);
  assert.equal(fs.readdirSync(fx.dir).length, before);
});

test('verifier catches every class of damage', () => {
  const fx = makeFixture(CLAUDE);
  const p = parseSession(read(fx.file));
  const { resolved } = resolveEdits(p, [{ id: bid('x3'), newText: 'edited' }]);
  const fork = '11111111-2222-4333-8444-555555555555';
  const good = buildFork(p, resolved, fx.sid, fork).lines;
  assert.deepEqual(verifyFork(p, good, resolved, fx.sid, fork), []);

  const damaged = (fn) => { const l = [...good]; fn(l); return verifyFork(p, l, resolved, fx.sid, fork); };
  const at = (u) => good.findIndex(l => l.includes(`"uuid":"${u}"`));
  const mod = (u, f) => (l) => { const i = at(u); const o = JSON.parse(l[i]); f(o); l[i] = JSON.stringify(o); };

  assert.match(damaged(l => l.pop()).join(), /record count/);
  assert.match(damaged(mod('u3', o => { o.parentUuid = 'x2'; })).join(), /parentUuid changed/);
  assert.match(damaged(mod('u3', o => { o.sessionId = fx.sid; })).join(), /still points at the parent/);
  assert.match(damaged(mod('r3', o => { o.message.content[0].tool_use_id = 'toolu_x'; })).join(), /pairing/);
  assert.match(damaged(mod('x1', o => { o.message.content[0].text = 'tampered'; })).join(), /changed without an edit/);
  assert.match(damaged(mod('x3', o => { o.message.content[0].text = 'something else'; })).join(), /did not land/);
  assert.match(damaged(mod('x2', o => { o.message.content[0].text = ''; })).join(), /empty text block/);
  assert.match(damaged(mod('tu3', o => { o.message.content[0].input = 'str'; })).join(), /not an object/);
});

test('revert: deletes an untouched fork, refuses one you continued, never touches non-forks', () => {
  const fx = makeFixture(CLAUDE);
  const a = forkSession(fx.session, [{ id: bid('r3'), op: 'tombstone' }]);
  const b = forkSession(fx.session, [{ id: bid('x3'), newText: 'changed' }]);

  // b gets resumed and grows
  fs.appendFileSync(b.forkFile, JSON.stringify({ type: 'user', uuid: 'later', parentUuid: 'x3', sessionId: b.forkSid, message: { role: 'user', content: 'more work' } }) + '\n');

  assert.ok(listForks().find(f => f.forkSid === b.forkSid).grown);
  const ra = revertFork(a.forkSid);
  assert.ok(!fs.existsSync(a.forkFile));
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'file-history', a.forkSid)));
  assert.ok(ra.ok);

  assert.throws(() => revertFork(b.forkSid), /resumed it and kept working/);
  assert.ok(fs.existsSync(b.forkFile));
  revertFork(b.forkSid, { force: true });
  assert.ok(!fs.existsSync(b.forkFile));

  assert.throws(() => revertFork(fx.sid), /Not a ctxtree fork/);
  assert.ok(fs.existsSync(fx.file), 'the parent is never deleted');
  assert.throws(() => revertFork('../../etc/passwd'), /Invalid fork id/);
});

test('fork: refuses a session file outside the projects directory', () => {
  const fx = makeFixture(CLAUDE);
  const outside = path.join(os.tmpdir(), `${fx.sid}.jsonl`);
  fs.copyFileSync(fx.file, outside);
  assert.throws(() => forkSession({ ...fx.session, file: outside }, [{ id: bid('x3'), newText: 'y' }]), /outside/);
  fs.rmSync(outside);
});

test('fixture sanity: the big read really is big', () => {
  assert.ok(BIG.length > 50000);
});
