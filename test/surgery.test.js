import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox: nothing in these tests can reach your real ~/.claude.
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-surgery-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;

const F = await import('./fixture-boot.js');
const { parseSession } = await import('../src/session.js');
const { forkSession, revertFork, ForkError } = await import('../src/fork.js');
const { bootInventory, launchProfile } = await import('../src/boot.js');
const { structureInfo } = await import('../src/restructure.js');

const read = (f) => fs.readFileSync(f, 'utf8');
const recs = (f) => read(f).split('\n').filter(Boolean).map(l => JSON.parse(l));
const byUuid = (f) => new Map(recs(f).filter(o => o.uuid).map(o => [o.uuid, o]));
const rendered = (o) => (o.rendered || []).map(x => x.content).join('\n');
const liveText = (file) => {
  const p = parseSession(read(file));
  return p.rows.filter(r => r.rec && r.rec.uuid && p.live.has(r.rec.uuid)).map(r => JSON.stringify(r.rec)).join('\n');
};

// ------------------------------------------------------------------ liveness
test('live chain: preserved segment, parallel-call results and the trailing snapshot are all resumed', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const p = parseSession(read(fx.file));
  assert.equal(p.leafUuid, 'x3');
  assert.ok(p.live.has('x1'), 'the preserved segment is spliced in after the summary');
  assert.ok(p.live.has('s1') && p.live.has('cb'));
  assert.ok(!p.live.has('u1') && !p.live.has('tu1'), 'the rest of the pre-compaction history is not resumed');
  const snap = p.rows.map(r => r.rec).filter(o => o && o.attachment && o.attachment.type === 'prompt_snapshot').pop();
  assert.ok(p.live.has(snap.uuid), 'the snapshot written after the last message is part of what resumes');
  // order: the preserved head comes right after the summary
  assert.ok(p.order.indexOf('x1') === p.order.indexOf('s1') + 1);
});

test('grey content is classified by what can act on it', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const p = parseSession(read(fx.file));
  const kind = (u) => p.blocks.find(b => b.uuid === u).deadKind;
  assert.equal(kind('u1'), 'compacted');
  assert.equal(kind('tu1'), 'compacted');
  assert.equal(kind('u2'), 'branch');
  assert.equal(p.blocks.find(b => b.uuid === 'u2').branchTip, 'x2');
  const si = structureInfo(p);
  assert.ok(si.compaction && si.compaction.restorable);
  assert.deepEqual(si.branches.map(b => b.tip), ['x2']);
});

// ---------------------------------------------------------------- inventory
test('boot inventory itemises what resumes, with plugin skill names intact', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const ids = new Set(bootInventory(parseSession(read(fx.file))).map(i => i.id));
  for (const id of ['mcp:alpha', 'mcp:beta', 'skill:keep-skill', 'skill:drop-skill', 'skill:plug:inner-skill',
    'agent:general', 'agent:Plan', 'md:/home/u/.claude/CLAUDE.md', 'md:/home/u/.claude/projects/x/memory/MEMORY.md',
    'tool:Bash', 'tool:WebFetch', 'tool:CronCreate'])
    assert.ok(ids.has(id), `${id} is inventoried`);
  assert.ok([...ids].some(i => i.startsWith('sys:')));
});

// ------------------------------------------------------------------- boot
test('boot removal: text gone from what is sent, names kept so nothing is re-announced, profile covers the rest', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const before = read(fx.file);
  const inv = bootInventory(parseSession(before));
  const sys = inv.find(i => i.kind === 'sys' && i.name === 'Tone and style');
  const remove = ['mcp:beta', 'skill:drop-skill', 'skill:plug:inner-skill', 'agent:Plan', 'md:/home/u/.claude/CLAUDE.md',
    'md:/home/u/.claude/projects/x/memory/MEMORY.md', 'tool:WebFetch', sys.id];
  const res = forkSession(fx.session, [], { boot: remove, kind: 'boot' });
  assert.equal(read(fx.file), before, 'parent untouched');

  const live = liveText(res.forkFile);
  for (const gone of [F.MCP_B.slice(0, 40), 'drop-skill: Drops', 'TRIGGER when dropping', 'inner-skill: A plugin', '- Plan: Plans', 'USER MD', 'MEMORY pref', '"name":"WebFetch"', 'mcp__beta__do', 'Be concise.'])
    assert.ok(!live.includes(gone), `removed: ${gone}`);
  for (const kept of [F.MCP_A.slice(0, 40), 'keep-skill: Keeps', '- general:', 'PROJECT MD', '"name":"Bash"', 'mcp__alpha__search'])
    assert.ok(live.includes(kept), `kept: ${kept}`);

  // The recorded names stay, so Claude Code's resume diff sees them as announced.
  // (Only the resumed records are rewritten; the pre-compaction copies are not sent.)
  const liveSet = parseSession(read(res.forkFile)).live;
  const out = recs(res.forkFile).filter(o => o.attachment && liveSet.has(o.uuid));
  assert.ok(out.some(o => o.attachment.type === 'mcp_instructions_delta'));
  const skills = out.filter(o => o.attachment.type === 'skill_listing');
  assert.ok(skills.every(o => o.attachment.names.includes('drop-skill')));
  const mcp = out.filter(o => o.attachment.type === 'mcp_instructions_delta');
  assert.ok(mcp.every(o => o.attachment.addedNames.includes('beta') && o.attachment.addedBlocks[1] === ''));
  const agents = out.filter(o => o.attachment.type === 'agent_listing_delta');
  assert.ok(agents.every(o => o.attachment.addedTypes.includes('Plan')));

  // ...and what Claude Code would re-announce anyway goes into the launch profile.
  assert.deepEqual([...res.profile.permissions.deny].sort(), ['WebFetch', 'mcp__beta'].sort());
  assert.deepEqual(res.profile.claudeMdExcludes, ['/home/u/.claude/CLAUDE.md']);
  assert.equal(res.profile.autoMemoryEnabled, false);
  assert.deepEqual(res.profile.skillOverrides, { 'drop-skill': 'user-invocable-only' });
  assert.ok(fs.existsSync(res.profileFile));
  assert.deepEqual(JSON.parse(read(res.profileFile)), res.profile);
  assert.match(res.resumeCmd, /claude --resume [0-9a-f-]{36} --settings ".*profiles.*\.json"/);
  assert.ok(res.resume.after < res.resume.before);
});

test('boot removal: every record it did not rewrite comes out identical', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const res = forkSession(fx.session, [], { boot: ['mcp:alpha'] });
  const a = recs(fx.file), b = recs(res.forkFile);
  assert.equal(a.length, b.length);
  let rewritten = 0;
  for (let i = 0; i < a.length; i++) {
    const want = { ...a[i] }; if (want.sessionId === fx.sid) want.sessionId = res.forkSid;
    if (JSON.stringify(want) === JSON.stringify(b[i])) continue;
    rewritten++;
    assert.equal(b[i].type, 'attachment', 'only attachment records change');
    const strip = (o) => { const c = { ...o }; delete c.attachment; delete c.rendered; delete c.sessionId; return JSON.stringify(c); };
    assert.equal(strip(a[i]), strip(b[i]));
  }
  assert.ok(rewritten >= 2, 'the announced tool names and the instructions record');
});

test('boot removal: text the renderer did not produce verbatim falls back to a re-render from edited data', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const lines = read(fx.file).split('\n');
  const i = lines.findLastIndex(l => l.includes('"skill_listing"'));   // the resumed copy
  const o = JSON.parse(lines[i]); o.rendered[0].content = o.rendered[0].content.replace('Drops things.', 'Drops  things.');
  lines[i] = JSON.stringify(o);
  fs.writeFileSync(fx.file, lines.join('\n'));
  const res = forkSession(fx.session, [], { boot: ['skill:drop-skill'] });
  const out = recs(res.forkFile).filter(r => r.attachment && r.attachment.type === 'skill_listing');
  const touched = out.find(r => r.uuid === o.uuid);
  assert.equal(touched.rendered, undefined, 'rendered dropped, so Claude Code rebuilds it from attachment data');
  assert.ok(!touched.attachment.content.includes('drop-skill:'));
});

test('boot removal: unknown or unremovable items are refused, nothing written', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const n = fs.readdirSync(fx.dir).length;
  assert.throws(() => forkSession(fx.session, [], { boot: ['mcp:nope'] }), (e) => e instanceof ForkError && /rejected/.test(e.message));
  assert.equal(fs.readdirSync(fx.dir).length, n);
});

test('launch profile: nothing needed -> no profile, plain resume command', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const res = forkSession(fx.session, [], { boot: ['agent:Plan'] });
  assert.equal(res.profile, null);
  assert.equal(res.profileFile, null);
  assert.doesNotMatch(res.resumeCmd, /--settings/);
  assert.equal(launchProfile([]), null);
});

// -------------------------------------------------------------- structure
test('uncompact: history restored, summary and re-announcement dropped, chain re-linked', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const res = forkSession(fx.session, [], { structure: [{ op: 'uncompact' }] });
  const p = parseSession(read(res.forkFile));
  const m = byUuid(res.forkFile);
  assert.ok(!m.has('cb') && !m.has('s1'), 'boundary and summary gone');
  for (const u of ['c1', 'c2', 'c3']) assert.ok(!m.has(u), 'the /compact command records are gone');
  for (const u of ['u1', 'tu1', 'tu2', 'ra', 'rb', 'x1', 'u3', 'x3']) assert.ok(p.live.has(u), `${u} resumes`);
  // the post-compaction boot burst is gone: each boot text is announced once
  const live = liveText(res.forkFile);
  assert.equal(live.split('INSTRUCTIONS FOR alpha').length - 1, 2, 'once in attachment data, once in rendered');
  assert.equal(p.leafUuid, 'x3');
  assert.ok(res.resume.after > res.resume.before, 'the context grows: real history replaces the summary');
});

test('uncompact then tombstone the restored history in the same fork', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const ra = parseSession(read(fx.file)).blocks.find(b => b.uuid === 'ra');
  assert.equal(ra.live, false, 'before: outside the resumed context');
  const res = forkSession(fx.session, [{ id: ra.id, fp: ra.fp, op: 'tombstone' }], { structure: [{ op: 'uncompact' }] });
  const got = parseSession(read(res.forkFile)).blocks.find(b => b.uuid === 'ra');
  assert.ok(got.live && got.text.startsWith('[ctxtree: removed'));
  assert.equal(res.deadEdits, 0, 'after the uncompact the edit lands in the resumed context');
});

test('switch: the branch you left becomes the resumed one; the other stays only in the parent', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const res = forkSession(fx.session, [], { structure: [{ op: 'switch', tip: 'x2' }] });
  const p = parseSession(read(res.forkFile));
  const m = byUuid(res.forkFile);
  assert.equal(p.leafUuid, 'x2');
  assert.ok(!m.has('u3') && !m.has('x3'), 'the competing branch is dropped');
  assert.ok(recs(res.forkFile).filter(o => o.type === 'last-prompt').every(o => o.leafUuid !== 'x3' && !o.leafUuid?.startsWith('r')), 'no pointer to a dropped leaf');
  assert.ok(byUuid(fx.file).has('x3'), 'parent keeps it');
});

test('switch refuses the resumed branch and non-messages', () => {
  const fx = F.makeBootFixture(CLAUDE);
  assert.throws(() => forkSession(fx.session, [], { structure: [{ op: 'switch', tip: 'x3' }] }), /already the resumed/);
  assert.throws(() => forkSession(fx.session, [], { structure: [{ op: 'switch', tip: 'cb' }] }), /not a message/);
});

test('slim: drops what resume never loads; what it loads is untouched', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const before = parseSession(read(fx.file));
  const res = forkSession(fx.session, [], { structure: [{ op: 'slim' }] });
  const after = parseSession(read(res.forkFile));
  assert.deepEqual([...after.live].sort(), [...before.live].sort());
  assert.equal(after.blocks.filter(b => b.live).map(b => b.fp).join(), before.blocks.filter(b => b.live).map(b => b.fp).join());
  assert.ok(!byUuid(res.forkFile).has('u2'), 'abandoned branch dropped');
  assert.ok(!byUuid(res.forkFile).has('tu1'), 'pre-compaction history dropped');
  assert.ok(byUuid(res.forkFile).has('x1'), 'the preserved segment is resumed, so it stays');
  assert.ok(res.bytes.after < res.bytes.before);
});

test('one fork can combine a branch switch, boot removal and a tombstone', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const x2 = parseSession(read(fx.file)).blocks.find(b => b.uuid === 'x2');
  const res = forkSession(fx.session, [{ id: x2.id, fp: x2.fp, newText: 'Summary A (edited).' }], { boot: ['mcp:beta'], structure: [{ op: 'switch', tip: 'x2' }, { op: 'slim' }] });
  const p = parseSession(read(res.forkFile));
  assert.equal(p.leafUuid, 'x2');
  assert.equal(p.blocks.find(b => b.uuid === 'x2').text, 'Summary A (edited).');
  assert.ok(!liveText(res.forkFile).includes('mcp__beta__do'));
  assert.deepEqual(res.structure.map(s => s.op), ['switch', 'slim']);
});

test('revert removes the fork, its history and its launch profile', () => {
  const fx = F.makeBootFixture(CLAUDE);
  const res = forkSession(fx.session, [], { boot: ['mcp:beta'] });
  assert.ok(fs.existsSync(res.profileFile));
  const r = revertFork(res.forkSid);
  assert.ok(r.paths.includes(res.profileFile));
  assert.ok(!fs.existsSync(res.profileFile) && !fs.existsSync(res.forkFile));
});
