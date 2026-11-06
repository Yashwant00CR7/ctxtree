// A fork, built and checked in memory: the pure half of the fork writer, shared
// by the web server (src/fork.js, which writes it with Node) and the Claude Code
// mod (which writes it with $.fs). Nothing here reads or writes a file.
//
// A fork is a copy of the parent transcript under a new session id, built in two
// verified layers:
//   1. structure: records dropped or re-chained by a hard delete, an uncompact,
//      a branch switch or a slim (restructure.js). No kept record changes except
//      its parentUuid, and only where the plan says. The request journal never
//      comes along.
//   2. content: message blocks rewritten (edits, an image taken out of your
//      message) and boot overhead removed from attachment records (boot.js). No
//      record is added, dropped or reordered; every record not edited is
//      reproduced exactly, byte-for-byte when possible, except for its session id.
// Each layer is checked against its invariants; a fork that fails is refused.
import { parseSession, resumedChars, UUID_RE } from './session.js';
import { ForkError } from './fork-error.js';
import { bootInventory, applyBootToRecord, launchProfile } from './boot.js';
import { planFor, dropsRow, hasJournal, turnBreaks } from './restructure.js';
import { resolveEdits } from './edits.js';

function restamp(rec, parentSid, forkSid) {
  // Only records carrying the parent's id are re-stamped. Records inherited from
  // further up a resume chain keep their original id, exactly as Claude Code
  // writes them itself.
  if (rec.sessionId === parentSid) rec.sessionId = forkSid;
  if (rec.session_id === parentSid) rec.session_id = forkSid;
}

function applyEdit(rec, { block, newText, input, remove }) {
  const m = rec.message;
  if (remove) { m.content.splice(block.cIdx, 1); return; }
  if (block.form === 'string') { m.content = newText; return; }
  const item = m.content[block.cIdx];
  switch (block.blockType) {
    case 'text': item.text = newText; break;
    case 'tool_use': item.input = input; break;
    case 'image': m.content[block.cIdx] = { type: 'text', text: newText }; break;
    case 'tool_result':
      item.content = newText;
      // Claude Code keeps a structured copy of every tool result beside the
      // message. Left alone it still holds the full original (no disk reclaimed)
      // and disagrees with what the model now sees. A string is a shape Claude
      // Code already writes itself (e.g. "User rejected tool use").
      if (rec.toolUseResult !== undefined) rec.toolUseResult = newText;
      break;
    default: throw new ForkError(`Refusing to rewrite a ${block.blockType} block.`);
  }
}

export function buildFork(parsed, resolved, parentSid, forkSid, bootEdits = new Map()) {
  const byLine = new Map();
  for (const r of resolved) {
    const list = byLine.get(r.block.line) || [];
    list.push(r); byLine.set(r.block.line, list);
  }
  // removals last and from the end, so the blocks before them keep their place
  for (const list of byLine.values()) list.sort((a, b) => (!!a.remove - !!b.remove) || (b.remove ? b.block.cIdx - a.block.cIdx : 0));
  const sidRe = new RegExp(`"(sessionId|session_id)"(\\s*):(\\s*)"${parentSid}"`, 'g');
  const out = [];
  let modifiedRecords = 0;

  for (const row of parsed.rows) {
    if (!row.rec) { out.push(row.text); continue; }
    const boot = bootEdits.get(row.line);
    const expected = structuredClone(boot ? boot.rec : row.rec);
    restamp(expected, parentSid, forkSid);

    const lineEdits = byLine.get(row.line);
    if (lineEdits || boot) {
      for (const e of lineEdits || []) applyEdit(expected, e);
      out.push(JSON.stringify(expected));
      modifiedRecords++;
      continue;
    }
    // Unedited: keep the original bytes and swap only the id. Accept the fast
    // path only if it decodes to exactly the intended record.
    const fast = row.text.replace(sidRe, `"$1"$2:$3"${forkSid}"`);
    let same = false;
    try { same = JSON.stringify(JSON.parse(fast)) === JSON.stringify(expected); } catch { same = false; }
    out.push(same ? fast : JSON.stringify(expected));
  }
  return { lines: out, modifiedRecords };
}

const toolIds = (rows) => {
  const uses = [], results = [];
  for (const r of rows) {
    const c = r.rec && r.rec.message && r.rec.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use') uses.push(b.id);
      if (b && b.type === 'tool_result') results.push(b.tool_use_id);
    }
  }
  return { uses: uses.join('|'), results: results.join('|') };
};

// Every invariant the content layer must hold. Returns a list of violations;
// empty = valid. `bootEdits` (row line -> { gone }) are the attachment records a
// boot removal rewrote; `removeIds` the boot items that must be gone.
export function verifyFork(parsed, outLines, resolved, parentSid, forkSid, { bootEdits = new Map(), removeIds = null } = {}) {
  const v = [];
  if (outLines.length !== parsed.rows.length) {
    v.push(`record count changed: ${parsed.rows.length} -> ${outLines.length}`);
    return v;
  }
  const outParsed = parseSession(outLines.join('\n') + '\n');
  const editedIds = new Map(resolved.map(r => [r.block.id, r]));
  const editedLines = new Set(resolved.map(r => r.block.line));
  // lines an image was taken out of: line -> content indexes removed
  const removed = new Map();
  for (const r of resolved) if (r.remove) { const s = removed.get(r.block.line) || new Set(); s.add(r.block.cIdx); removed.set(r.block.line, s); }

  for (let i = 0; i < parsed.rows.length; i++) {
    const a = parsed.rows[i].rec, b = outParsed.rows[i].rec;
    if (!a) { if (outLines[i] !== parsed.rows[i].text) v.push(`line ${i}: unparseable source line was altered`); continue; }
    if (!b) { v.push(`line ${i}: output is not valid JSON`); continue; }
    for (const k of ['uuid', 'parentUuid', 'type', 'isSidechain', 'logicalParentUuid'])
      if (a[k] !== b[k]) v.push(`line ${i}: ${k} changed`);
    for (const k of ['sessionId', 'session_id']) {
      if (b[k] === parentSid) v.push(`line ${i}: ${k} still points at the parent`);
      if (a[k] === parentSid && b[k] !== forkSid) v.push(`line ${i}: ${k} not re-stamped`);
      if (a[k] !== parentSid && a[k] !== b[k]) v.push(`line ${i}: ${k} changed unexpectedly`);
    }
    // A record nobody edited must come out exactly as it went in (bar the id).
    const edited = editedLines.has(i) || bootEdits.has(i);
    if (!edited) {
      const want = structuredClone(a); restamp(want, parentSid, forkSid);
      if (JSON.stringify(want) !== JSON.stringify(b)) v.push(`line ${i}: record changed without an edit`);
    }
    const gone = removed.get(i);
    if (gone) {
      // exactly the removed blocks are missing, everything else as it was
      const want = structuredClone(a); restamp(want, parentSid, forkSid);
      want.message.content = want.message.content.filter((_, k) => !gone.has(k));
      if (!want.message.content.length) v.push(`line ${i}: a message would be left empty`);
      const others = resolved.filter(r => r.block.line === i && !r.remove);
      if (!others.length && JSON.stringify(want) !== JSON.stringify(b)) v.push(`line ${i}: more than the image changed`);
    }
    const be = bootEdits.get(i);
    if (be) {
      const strip = (o) => { const c = structuredClone(o); delete c.attachment; delete c.rendered; restamp(c, parentSid, forkSid); return JSON.stringify(c); };
      if (strip(a) !== strip(b)) v.push(`line ${i}: boot removal touched more than the attachment`);
      const rt = '\n' + (Array.isArray(b.rendered) ? b.rendered.map(x => (x && x.content) || '').join('\n') : '') + '\n';
      const data = JSON.stringify(b.attachment || {});
      for (const g of be.gone) {
        if (g.startsWith('"name":') ? data.includes(g) : rt.includes(g)) v.push(`line ${i}: removed boot text is still there`);
      }
    }
    const ac = a.message && a.message.content, bc = b.message && b.message.content;
    if (Array.isArray(ac) && (!Array.isArray(bc) || ac.length - (gone ? gone.size : 0) !== bc.length)) v.push(`line ${i}: content block count changed`);
    if (Array.isArray(bc)) for (const blk of bc) {
      if (blk && blk.type === 'text' && !(blk.text || '').trim()) v.push(`line ${i}: empty text block`);
      if (blk && blk.type === 'tool_use' && (!blk.input || typeof blk.input !== 'object' || Array.isArray(blk.input))) v.push(`line ${i}: tool_use input is not an object`);
    }
  }

  const ti = toolIds(parsed.rows), to = toolIds(outParsed.rows);
  if (ti.uses !== to.uses) v.push('tool_use ids changed');
  if (ti.results !== to.results) v.push('tool_result pairing changed');

  if (outParsed.leafUuid !== parsed.leafUuid) v.push('resume leaf changed');
  if (outParsed.live.size !== parsed.live.size) v.push('resumed chain changed');

  // Block ids carry their position in the record, so a record an image left
  // is compared above as a whole; every other block keeps its id and text.
  const outById = new Map(outParsed.blocks.map(x => [x.id, x]));
  for (const src of parsed.blocks) {
    if (removed.has(src.line)) continue;
    const got = outById.get(src.id);
    if (!got) { v.push(`block ${src.id} missing`); continue; }
    const e = editedIds.get(src.id);
    if (e) { if (got.text !== e.newText) v.push(`block ${src.id}: edit did not land`); }
    else if (got.fp !== src.fp) v.push(`block ${src.id}: changed without an edit`);
  }
  if (removeIds && removeIds.size) {
    const left = bootInventory(outParsed).filter(it => removeIds.has(it.id));
    for (const it of left) v.push(`boot item ${it.id} is still in the resumed context`);
  }
  return v;
}

// ------------------------------------------------------------- structure
// Plans run in sequence, each against the result of the one before. Returns the
// intermediate parse plus what happened to every ORIGINAL row, for the verifier.
export function applyStructure(parsed0, ops) {
  let parsed = parsed0;
  let origOf = parsed0.rows.map((_, i) => i);
  const dropped = new Set(), parentNow = new Map(), plans = [];
  for (const op of ops) {
    const plan = planFor(parsed, op);
    plans.push(plan);
    const before = plan.op === 'drop' ? turnBreaks(parsed) : 0;
    const text = [], orig = [];
    parsed.rows.forEach((r, i) => {
      const o = r.rec;
      if (dropsRow(o, plan.drop, plan.extra)) { dropped.add(origOf[i]); return; }
      if (o && o.uuid && plan.reparent.has(o.uuid)) {
        const rec = structuredClone(o);
        rec.parentUuid = plan.reparent.get(o.uuid);
        parentNow.set(origOf[i], rec.parentUuid);
        text.push(JSON.stringify(rec));
      } else text.push(r.text);
      orig.push(origOf[i]);
    });
    parsed = parseSession(text.length ? text.join('\n') + (parsed0.trailingNewline ? '\n' : '') : '');
    origOf = orig;
    if (plan.op === 'drop') plan.breaks = [before, turnBreaks(parsed)];
  }
  return { parsed, origOf, dropped, parentNow, plans };
}

// Tool calls on the resumed chain must still pair up: every result follows its
// call, and every call but the last turn's has a result.
function pairingProblems(parsed) {
  const v = [];
  const uses = new Map(), results = new Set();
  const liveRows = parsed.order.map(u => parsed.byUuid.get(u));
  let lastAssistantIdx = -1;
  liveRows.forEach((o, i) => { if (o && o.type === 'assistant') lastAssistantIdx = i; });
  liveRows.forEach((o, i) => {
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (b && b.type === 'tool_use') uses.set(b.id, i);
      if (b && b.type === 'tool_result') {
        if (!uses.has(b.tool_use_id)) v.push(`tool_result ${b.tool_use_id} has no call before it on the resumed chain`);
        results.add(b.tool_use_id);
      }
    }
  });
  for (const [id, i] of uses) if (!results.has(id) && i < lastAssistantIdx) v.push(`tool_use ${id} has no result on the resumed chain`);
  return v;
}

export function verifyStructure(parsed0, S) {
  const v = [];
  const { parsed, origOf, dropped, parentNow, plans } = S;
  // Kept rows: the originals, in order, minus the dropped ones.
  const expectOrig = parsed0.rows.map((_, i) => i).filter(i => !dropped.has(i));
  if (expectOrig.length !== origOf.length || expectOrig.some((x, k) => x !== origOf[k])) {
    v.push('kept records are not the original records in their original order');
    return v;
  }
  const kept = new Set();
  for (const r of parsed.rows) if (r.rec && r.rec.uuid) kept.add(r.rec.uuid);
  const had = new Set();
  for (const r of parsed0.rows) if (r.rec && r.rec.uuid) had.add(r.rec.uuid);
  parsed.rows.forEach((r, k) => {
    const src = parsed0.rows[origOf[k]];
    if (!src.rec) { if (r.text !== src.text) v.push(`line ${origOf[k]}: unparseable line altered`); return; }
    const want = structuredClone(src.rec);
    if (parentNow.has(origOf[k])) want.parentUuid = parentNow.get(origOf[k]);
    if (JSON.stringify(want) !== JSON.stringify(r.rec)) v.push(`line ${origOf[k]}: changed beyond its planned parent`);
    const p = r.rec.parentUuid;
    if (p && !kept.has(p) && had.has(p)) v.push(`line ${origOf[k]}: parent ${p.slice(0, 8)} was dropped but it still points there`);
  });
  for (const plan of plans) {
    for (const u of plan.mustBeLive || []) if (!parsed.live.has(u)) v.push(`${plan.op}: ${u.slice(0, 8)} is not in the resumed context afterwards`);
    if (plan.op === 'drop') for (const u of plan.drop) if (kept.has(u)) v.push(`drop: ${u.slice(0, 8)} is still in the fork`);
    if (plan.op === 'drop' && plan === plans.filter(p => p.op !== 'journal').pop() && (plan.leafAfter || null) !== (parsed.leafUuid || null))
      v.push('the fork would resume somewhere else than where the conversation was');
  }
  const last = plans[plans.length - 1];
  if (last && last.expectLeaf === parsed0.leafUuid && plans.every(p => p.expectLeaf === parsed0.leafUuid) && parsed.leafUuid !== parsed0.leafUuid)
    v.push('resume leaf changed');
  if (plans.every(p => p.sameLive)) {
    if (parsed.live.size !== parsed0.live.size || [...parsed0.live].some(u => !parsed.live.has(u))) v.push('slim changed the resumed chain');
    const before = parsed0.blocks.filter(b => b.live).map(b => b.id + b.fp).join('|');
    const after = parsed.blocks.filter(b => b.live).map(b => b.id + b.fp).join('|');
    if (before !== after) v.push('slim changed resumed content');
  }
  if (parsed0.leafUuid && !parsed.leafUuid) v.push('nothing would be left to resume: keep at least one message');
  for (const plan of plans) if (plan.breaks && plan.breaks[1] > plan.breaks[0]) v.push('two of Claude\'s replies would sit back to back (or the conversation would open with one); delete the whole task instead');
  v.push(...pairingProblems(parsed));
  return v;
}

// The command that resumes a fork. A fork with a launch profile MUST be resumed
// through it: without the overlay Claude Code re-announces what was removed.
export function resumeCommand({ forkSid, cwd, profile }) {
  const q = (x) => JSON.stringify(x);
  const cmd = `claude --resume ${forkSid}${profile ? ` --settings ${q(profile)}` : ''}`;
  return cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
}

// What a fork did, in a line, for the Forks list.
export function forkNote(r, kind) {
  const what = [
    r.edits ? `${kind === 'prune' ? 'tombstoned' : 'edited'} ${r.edits} block(s)` : '',
    r.boot.length ? `removed ${r.boot.length} boot item(s)` : '',
    ...r.structure.map(o => (o.op === 'drop' ? `deleted ${o.dropped} record(s)` : o.op)),
  ].filter(Boolean).join(', ');
  return what.charAt(0).toUpperCase() + what.slice(1);
}

// vTower (macOS) opens a fork in a new tab from this link: the session and the
// folder it runs in, never a command (vTower runs ctxtree's own resume).
export const vtowerLink = (sid, cwd) => `vtower://resume/${sid}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`;

const estimate = (parsed, tok) => {
  let msg = 0;
  for (const b of parsed.blocks) if (b.live && !b.side && b.blockType !== 'thinking' && b.blockType !== 'redacted_thinking') msg += tok(b.chars, b.kind);
  const c = resumedChars(parsed);
  return msg + (c.attach + c.snapshot ? tok(c.attach + c.snapshot, 'attach') : 0);
};

/**
 * The whole fork, in memory.
 * @param raw        the parent transcript, as read (one consistent snapshot)
 * @param edits      [{ id, fp?, newText?, op?: 'tombstone' | 'shrink' | 'remove' }]
 * @param boot       boot item ids to remove (see boot.js bootInventory)
 * @param structure  [{ op: 'drop', recs } | { op: 'uncompact' } | { op: 'switch', tip } | { op: 'slim' }]
 * @param tok        (chars, kind) => tokens, for reporting only
 * @returns { content, profile, report } or throws ForkError
 */
export function makeFork(raw, { parentSid, forkSid, edits = [], boot = [], structure = [], tok = (c) => Math.round(c / 3.6) }) {
  if (!UUID_RE.test(parentSid || '') || !UUID_RE.test(forkSid || '')) throw new ForkError('Invalid session id.');
  const parsed0 = parseSession(raw);

  // Layer 1: structure. Edits are then addressed against what the fork resumes.
  const ops = [...(structure || [])];
  if (hasJournal(parsed0)) ops.push({ op: 'journal' });
  const S = ops.length ? applyStructure(parsed0, ops) : null;
  if (S) {
    const sv = verifyStructure(parsed0, S);
    if (sv.length) throw new ForkError('Fork failed verification; nothing was written.', sv.map(error => ({ error })));
  }
  const parsed = S ? S.parsed : parsed0;

  const { resolved, problems } = resolveEdits(parsed, edits || [], { tok });
  if (problems.length) throw new ForkError(`${problems.length} edit(s) rejected.`, problems);

  // Layer 2b: boot overhead, on the attachment records of the resumed chain.
  const removeIds = new Set(boot || []);
  const bootEdits = new Map();
  let profile = null, bootItems = [];
  if (removeIds.size) {
    const inv = new Map(bootInventory(parsed).map(it => [it.id, it]));
    const bad = [];
    for (const id of removeIds) {
      const it = inv.get(id);
      if (!it) bad.push({ id, error: 'Not in the resumed context of this session (reload and try again).' });
      else if (!it.removable) bad.push({ id, error: it.reason || 'Not removable.' });
    }
    if (bad.length) throw new ForkError(`${bad.length} boot removal(s) rejected.`, bad);
    bootItems = [...removeIds].map(id => inv.get(id));
    for (const r of parsed.rows) {
      const o = r.rec;
      if (!o || o.type !== 'attachment' || !o.uuid || !parsed.live.has(o.uuid)) continue;
      const rec = structuredClone(o);
      const res = applyBootToRecord(rec, removeIds);
      if (res) bootEdits.set(r.line, { rec, gone: res.gone, rerender: res.rerender });
    }
    profile = launchProfile(bootItems);
  }
  if (!resolved.length && !bootEdits.size && !(structure && structure.length)) throw new ForkError('Nothing to change: every edit matches the current text.');

  const { lines, modifiedRecords } = buildFork(parsed, resolved, parentSid, forkSid, bootEdits);
  const violations = verifyFork(parsed, lines, resolved, parentSid, forkSid, { bootEdits, removeIds });
  if (violations.length) throw new ForkError('Fork failed verification; nothing was written.', violations.map(error => ({ error })));

  // Report what the resumed context actually loses. Content that is not on the
  // resumed chain (before the last compaction, or on an abandoned rewind branch)
  // is still rewritten but saves nothing on resume, and is counted separately.
  let deadEdits = 0;
  const blocks = resolved.map(({ block, newText }) => {
    const before = tok(block.chars, block.kind), after = tok(newText.length, 'text');
    if (!block.live) deadEdits++;
    return { id: block.id, tool: block.tool, kind: block.kind, target: block.target.slice(0, 120), live: block.live, tokBefore: before, tokAfter: after };
  });
  const outParsed = parseSession(lines.join('\n') + '\n');
  const resumeBefore = estimate(parsed0, tok), resumeAfter = estimate(outParsed, tok);
  const content = lines.join('\n') + (parsed0.trailingNewline ? '\n' : '');
  return {
    content, profile,
    report: {
      edits: resolved.length, modifiedRecords, deadEdits, blocks,
      boot: bootItems.map(it => ({ id: it.id, kind: it.kind, name: it.name, chars: it.chars, lasts: it.lasts })),
      structure: (S ? S.plans : []).filter(p => p.op !== 'journal').map(p => ({ op: p.op, note: p.note, dropped: p.drop.size, ...(p.tip ? { tip: p.tip } : {}) })),
      journal: !!(S && S.plans.some(p => p.op === 'journal')),
      resume: { before: resumeBefore, after: resumeAfter, saved: resumeBefore - resumeAfter },
    },
  };
}
