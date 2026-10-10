// Builds and verifies a fork of EVERY real session in ~/.claude/projects with
// realistic edits, in dry-run mode: nothing is written. Proves the engine
// handles every transcript shape you actually have, not just the fixture.
//   node test/real-dryrun.js
import fs from 'node:fs';
import { listSessionFiles } from '../src/scan.js';
import { parseSession } from '../src/session.js';
import { forkSession } from '../src/fork.js';
import { bootInventory } from '../src/boot.js';
import { structureInfo } from '../src/restructure.js';

const files = listSessionFiles();
let ok = 0, skipped = 0, failed = 0, edits = 0, ms = 0;
const failures = [];
for (const f of files) {
  const raw = fs.readFileSync(f.file, 'utf8');
  const p = parseSession(raw);
  const live = p.blocks.filter(b => b.live && b.editable);
  const pick = [];
  const biggest = live.filter(b => b.blockType === 'tool_result').sort((a, b) => b.chars - a.chars)[0];
  if (biggest) pick.push({ id: biggest.id, fp: biggest.fp, op: 'tombstone' });
  const lastText = [...live].reverse().find(b => b.role === 'assistant' && b.blockType === 'text');
  if (lastText) pick.push({ id: lastText.id, fp: lastText.fp, newText: `${lastText.text.slice(0, 40)} [edited]` });
  const prompt = live.find(b => b.role === 'user' && b.blockType === 'text');
  if (prompt) pick.push({ id: prompt.id, fp: prompt.fp, newText: `${prompt.text.slice(0, 40)} [edited]` });
  const call = live.find(b => b.blockType === 'tool_use');
  if (call) { const inp = JSON.parse(call.text); inp.__ctxtree_probe = true; pick.push({ id: call.id, fp: call.fp, newText: JSON.stringify(inp) }); }
  const dead = p.blocks.find(b => !b.live && b.editable && b.blockType === 'tool_result');
  if (dead) pick.push({ id: dead.id, fp: dead.fp, op: 'tombstone' });
  if (!pick.length) { skipped++; continue; }
  const t0 = Date.now();
  try {
    forkSession(f, pick, { dryRun: true });
    ok++; edits += pick.length;
  } catch (e) {
    failed++;
    failures.push({ sid: f.sid.slice(0, 8), error: e.message, problems: (e.problems || []).slice(0, 3) });
  }
  ms += Date.now() - t0;
}
console.log(`sessions: ${files.length}  verified: ${ok}  skipped (nothing editable): ${skipped}  FAILED: ${failed}`);
console.log(`edits built and verified: ${edits}   total ${ms}ms`);
for (const f of failures) console.log(' ', f.sid, f.error, JSON.stringify(f.problems));

// Boot removal and the structural operations, on every session they apply to.
// A refusal the engine explains (e.g. a branch another tree would out-resume) is
// reported, not failed: refusing is the correct answer there.
const ops = { boot: [0, 0], uncompact: [0, 0], switch: [0, 0], slim: [0, 0] };
const refused = [], broken = [];
const EXPECTED_REFUSAL = /would still be resumed instead|nothing to (uncompact|slim)|already the resumed|not in the session file/i;
for (const f of files) {
  const p = parseSession(fs.readFileSync(f.file, 'utf8'));
  const inv = bootInventory(p).filter(i => i.removable);
  const pick = ['mcp', 'skill', 'md', 'agent', 'sys', 'tool'].map(k => inv.find(i => i.kind === k)).filter(Boolean).map(i => i.id);
  const si = structureInfo(p);
  const tries = [];
  if (pick.length) tries.push(['boot', { boot: pick }]);
  if (si.compaction && si.compaction.restorable) tries.push(['uncompact', { structure: [{ op: 'uncompact' }] }]);
  if (si.branches.length) tries.push(['switch', { structure: [{ op: 'switch', tip: si.branches[0].tip }] }]);
  tries.push(['slim', { structure: [{ op: 'slim' }] }]);
  for (const [name, opts] of tries) {
    ops[name][0]++;
    try { forkSession(f, [], { dryRun: true, ...opts }); ops[name][1]++; }
    catch (e) {
      if (EXPECTED_REFUSAL.test(e.message)) { ops[name][0]--; refused.push(`${f.sid.slice(0, 8)} ${name}: ${e.message}`); }
      else broken.push({ sid: f.sid.slice(0, 8), name, error: e.message, problems: (e.problems || []).slice(0, 3).map(x => x.error) });
    }
  }
}
for (const [k, [n, good]] of Object.entries(ops)) console.log(`${k.padEnd(10)} attempted ${String(n).padStart(3)}  verified ${String(good).padStart(3)}  FAILED ${n - good}`);
if (refused.length) console.log(`refused as expected (${refused.length}):\n  ${refused.slice(0, 8).join('\n  ')}`);
for (const b of broken) console.log(' ', JSON.stringify(b));

// What the UI offers: mark EVERY deletable leaf of the map (each tool result,
// shrinkable call, message, image and setup item) and build the fork. If the
// map ever offers something the engine cannot verify, this fails.
const { build } = await import('../src/model.js');
const { contextMap } = await import('../src/map.js');
const { applySurgery } = await import('../src/surgery.js');
const model = build();
let mapOk = 0, mapFail = 0, mapItems = 0;
for (const s of model.sessions) {
  const m = contextMap(model, s.sid);
  const edits = [], boot = [];
  const walk = (n) => { if (n.kids) return n.kids.forEach(walk); for (const a of n.acts) { if (a.k === 'block') edits.push({ id: a.id, fp: a.fp, op: a.op || 'tombstone' }); else boot.push(a.id); } };
  walk(m.tasks);
  if (!edits.length && !boot.length) continue;
  try { applySurgery(model, { sid: s.sid, edits, boot, dryRun: true }); mapOk++; mapItems += edits.length + boot.length; }
  catch (e) { mapFail++; broken.push({ sid: s.sid.slice(0, 8), name: 'map: delete everything', error: e.message, problems: (e.problems || []).slice(0, 3).map(x => x.error) }); }
}
console.log(`map        sessions ${mapOk + mapFail}  verified ${mapOk}  FAILED ${mapFail}  (${mapItems} items marked at once)`);
for (const b of broken.filter(x => x.name.startsWith('map'))) console.log(' ', JSON.stringify(b));
process.exit(failed || broken.length ? 1 : 0);
