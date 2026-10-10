// The only code in ctxtree that writes session data.
//
// A fork is a copy of the parent transcript under a new session id, built in two
// verified layers:
//   1. structure (optional): records dropped or re-chained by an uncompact,
//      branch switch or slim (restructure.js). No kept record changes except its
//      parentUuid, and only where the plan says.
//   2. content: message blocks rewritten (edits, tombstones) and boot overhead
//      removed from attachment records (boot.js). No record is added, dropped or
//      reordered; every record not edited is reproduced exactly, byte-for-byte
//      when possible, except for its session id.
// Each layer is checked against its invariants in memory, the file is written to
// a hidden temp file, read back, and only then renamed into place -- so a
// half-written or malformed fork never shows up in `claude --resume`.
// Boot removals that Claude Code would otherwise re-announce come with a launch
// profile (a --settings overlay) that the resume command passes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECTS_DIR, FILE_HISTORY_DIR, CTXTREE_DIR, LINEAGE_FILE, PROFILES_DIR, prettyProject } from './paths.js';
import { parseSession, resumedChars, UUID_RE } from './session.js';
import { ForkError } from './fork-error.js';
import { bootInventory, applyBootToRecord, launchProfile } from './boot.js';
import { planFor, dropsRow } from './restructure.js';

export { ForkError };

const MAX_NEW_TEXT = 4_000_000;

export function tombstoneText(block, tok) {
  const what = block.tool ? `${block.tool} result` : (block.kind === 'image' ? 'image' : `${block.role} ${block.kind}`);
  const where = block.target ? ` for ${block.target.slice(0, 100)}` : '';
  const size = tok ? ` (~${tok.toLocaleString()} tokens)` : '';
  return `[ctxtree: removed ${what}${where}${size} to reclaim context. Re-run it if you need it again.]`;
}

// A tool call cannot be dropped (its result would lose its pair), but what
// made it big can: the file contents a Write sent, the strings an Edit swapped.
// Long strings keep their first words and say how much went.
export const SHRINK_MIN = 400;
export function shrinkInput(input) {
  let changed = false;
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length < SHRINK_MIN) return v;
      changed = true;
      return `${v.slice(0, 120).trimEnd()}\n[ctxtree: removed ${(v.length - 120).toLocaleString()} more characters to reclaim context]`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(input);
  return changed ? out : null;
}

// Edits arrive from a browser; nothing about them is trusted. Each one is
// re-resolved against a fresh parse of the file and checked for staleness.
export function resolveEdits(parsed, edits, { tok = () => 0 } = {}) {
  const byId = new Map(parsed.blocks.map(b => [b.id, b]));
  const resolved = [], problems = [], seen = new Set();

  for (const e of edits || []) {
    const b = e && byId.get(e.id);
    const fail = (error) => problems.push({ id: e && e.id, error });
    if (!b) { fail('No such block in this session. Reload the session and try again.'); continue; }
    if (seen.has(b.id)) { fail('More than one edit for the same block.'); continue; }
    seen.add(b.id);
    if (!b.editable) { fail(b.lock); continue; }
    if (e.fp && e.fp !== b.fp) { fail('This block changed after you loaded it. Reload the session and re-apply the edit.'); continue; }

    const tombstone = e.op === 'tombstone';
    let newText = tombstone ? tombstoneText(b, tok(b.chars, b.kind)) : e.newText;
    if (e.op === 'shrink') {
      if (b.blockType !== 'tool_use') { fail('Only a tool call can be shrunk; delete a result or message instead.'); continue; }
      let small = null;
      try { small = shrinkInput(JSON.parse(b.text)); } catch { /* fall through */ }
      if (!small) { fail('Nothing in this tool call is large enough to shrink.'); continue; }
      newText = JSON.stringify(small, null, 2);
    }
    if (typeof newText !== 'string') { fail('Edit has no text.'); continue; }
    if (newText.length > MAX_NEW_TEXT) { fail('Replacement text is too large.'); continue; }

    let input;
    if (b.blockType === 'tool_use') {
      if (tombstone) { fail('A tool call cannot be tombstoned; tombstone its result instead.'); continue; }
      try { input = JSON.parse(newText); } catch (err) { fail(`Tool call input must be valid JSON: ${err.message}`); continue; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { fail('Tool call input must be a JSON object.'); continue; }
      newText = JSON.stringify(input, null, 2);
    } else if (!newText.trim()) {
      // The API rejects empty text blocks; an emptied block becomes a tombstone.
      newText = tombstoneText(b, tok(b.chars, b.kind));
    }
    if (newText === b.text) continue; // no-op, not an error

    resolved.push({ block: b, newText, input, tombstone: tombstone || newText.startsWith('[ctxtree: removed') });
  }
  return { resolved, problems };
}

function restamp(rec, parentSid, forkSid) {
  // Only records carrying the parent's id are re-stamped. Records inherited from
  // further up a resume chain keep their original id, exactly as Claude Code
  // writes them itself.
  if (rec.sessionId === parentSid) rec.sessionId = forkSid;
  if (rec.session_id === parentSid) rec.session_id = forkSid;
}

function applyEdit(rec, { block, newText, input }) {
  const m = rec.message;
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
    if (Array.isArray(ac) && (!Array.isArray(bc) || ac.length !== bc.length)) v.push(`line ${i}: content block count changed`);
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

  const outById = new Map(outParsed.blocks.map(x => [x.id, x]));
  for (const src of parsed.blocks) {
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
    const text = [], orig = [];
    parsed.rows.forEach((r, i) => {
      const o = r.rec;
      if (dropsRow(o, plan.drop)) { dropped.add(origOf[i]); return; }
      if (o && o.uuid && plan.reparent.has(o.uuid)) {
        const rec = structuredClone(o);
        rec.parentUuid = plan.reparent.get(o.uuid);
        parentNow.set(origOf[i], rec.parentUuid);
        text.push(JSON.stringify(rec));
      } else text.push(r.text);
      orig.push(origOf[i]);
    });
    parsed = parseSession(text.join('\n') + (parsed0.trailingNewline ? '\n' : ''));
    origOf = orig;
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
  v.push(...pairingProblems(parsed));
  return v;
}

function cloneHistory(parentSid, forkSid) {
  const src = path.join(FILE_HISTORY_DIR, parentSid);
  const dst = path.join(FILE_HISTORY_DIR, forkSid);
  if (!fs.existsSync(src)) return 'none';
  try { execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'ignore' }); return 'cloned'; }
  catch {
    try { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); return 'copied'; }
    catch { return 'failed'; }
  }
}

// ---------------------------------------------------------------- lineage
export function readLineage() {
  let raw = '';
  try { raw = fs.readFileSync(LINEAGE_FILE, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function writeLineage(entries) {
  fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  const tmp = `${LINEAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, LINEAGE_FILE);
}
function appendLineage(entry) {
  fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  fs.appendFileSync(LINEAGE_FILE, JSON.stringify(entry) + '\n');
}

// A fork that has grown since it was written has been resumed and used.
export function forkStatus(entry) {
  const exists = !!entry.file && fs.existsSync(entry.file);
  const size = exists ? fs.statSync(entry.file).size : 0;
  const grown = exists && (entry.bytes == null ? null : size !== entry.bytes);
  return { exists, size, grown };
}

export function listForks() {
  return readLineage()
    .map(e => ({ ...e, ...forkStatus(e), resumeCmd: resumeCommand({ forkSid: e.forkSid, cwd: e.cwd, profile: e.profileFile && fs.existsSync(e.profileFile) ? e.profileFile : null }) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ------------------------------------------------------------------- fork
export const profilePath = (forkSid) => path.join(PROFILES_DIR, `${forkSid}.json`);

// The command that resumes a fork. A fork with a launch profile MUST be resumed
// through it: without the overlay Claude Code re-announces what was removed.
export function resumeCommand({ forkSid, cwd, profile }) {
  const q = (x) => JSON.stringify(x);
  const cmd = `claude --resume ${forkSid}${profile ? ` --settings ${q(profile)}` : ''}`;
  return cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
}

const estimate = (parsed, tok) => {
  let msg = 0;
  for (const b of parsed.blocks) if (b.live && !b.side && b.blockType !== 'thinking' && b.blockType !== 'redacted_thinking') msg += tok(b.chars, b.kind);
  const c = resumedChars(parsed);
  return msg + (c.attach + c.snapshot ? tok(c.attach + c.snapshot, 'attach') : 0);
};

/**
 * @param session  { sid, file, project, cwd }
 * @param edits    [{ id, fp?, newText?, op?: 'tombstone' }]   message-block edits
 * @param opts.boot       boot item ids to remove (see boot.js bootInventory)
 * @param opts.structure  [{ op: 'uncompact' } | { op: 'switch', tip } | { op: 'slim' }]
 * @param opts.tok (chars, kind) => tokens   estimate used for reporting only
 * @param opts.dryRun  build and verify, write nothing
 */
export function forkSession(session, edits, { tok = (c) => Math.round(c / 3.6), note = '', kind = 'edit', dryRun = false, boot = [], structure = [] } = {}) {
  const parentSid = session.sid;
  if (!UUID_RE.test(parentSid || '')) throw new ForkError('Invalid session id.');
  const file = path.resolve(session.file);
  if (!file.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || path.basename(file) !== `${parentSid}.jsonl`)
    throw new ForkError('Session file is outside ~/.claude/projects.');

  const raw = fs.readFileSync(file, 'utf8');       // one consistent snapshot, even if the session is live
  const parsed0 = parseSession(raw);

  // Layer 1: structure. Edits are then addressed against what the fork resumes.
  const S = structure && structure.length ? applyStructure(parsed0, structure) : null;
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
  if (!resolved.length && !bootEdits.size && !S) throw new ForkError('Nothing to change: every edit matches the current text.');

  const forkSid = crypto.randomUUID();
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
  const saved = resumeBefore - resumeAfter;

  const content = lines.join('\n') + (parsed0.trailingNewline ? '\n' : '');
  const dir = path.dirname(file);
  const forkFile = path.join(dir, `${forkSid}.jsonl`);
  const profileFile = profile ? profilePath(forkSid) : null;
  const ops = [
    ...(S ? S.plans.map(p => ({ op: p.op, note: p.note, dropped: p.drop.size, ...(p.tip ? { tip: p.tip } : {}) })) : []),
  ];
  const result = {
    ok: true, dryRun, forkSid, parentSid,
    project: session.project, projectName: prettyProject(session.project || ''),
    cwd: session.cwd || '', forkFile,
    edits: resolved.length, modifiedRecords, deadEdits, blocks,
    boot: bootItems.map(it => ({ id: it.id, kind: it.kind, name: it.name, chars: it.chars, lasts: it.lasts })),
    structure: ops,
    profile, profileFile,
    bytes: { before: Buffer.byteLength(raw), after: Buffer.byteLength(content) },
    resume: { before: resumeBefore, after: resumeAfter, saved },
    savedTok: Math.max(0, saved),
    resumeCmd: resumeCommand({ forkSid, cwd: session.cwd || '', profile: profileFile }),
  };
  if (dryRun) return result;

  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(dir, `.${forkSid}.jsonl.ctxtree-tmp`);   // hidden, not *.jsonl: never listed by Claude Code
  try {
    if (profile) {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
      fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const fd = fs.openSync(tmp, 'wx', mode);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.readFileSync(tmp, 'utf8') !== content) throw new ForkError('Read-back mismatch; nothing was written.');
    if (fs.existsSync(forkFile)) throw new ForkError('Fork target already exists.');
    fs.renameSync(tmp, forkFile);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (profileFile) try { fs.rmSync(profileFile, { force: true }); } catch { /* best effort */ }
    throw err;
  }

  result.history = cloneHistory(parentSid, forkSid);
  const stat = fs.statSync(forkFile);
  const what = [
    resolved.length ? `${kind === 'prune' ? 'tombstoned' : 'edited'} ${resolved.length} block(s)` : '',
    bootItems.length ? `removed ${bootItems.length} boot item(s)` : '',
    ...ops.map(o => o.op),
  ].filter(Boolean).join(', ');
  appendLineage({
    forkSid, parentSid, kind, project: session.project, projectName: result.projectName,
    cwd: result.cwd, file: forkFile, createdAt: new Date().toISOString(),
    bytes: stat.size, edits: result.edits, deadEdits, modifiedRecords, blocks,
    boot: result.boot, structure: ops, profileFile,
    resume: result.resume, savedTok: result.savedTok, history: result.history,
    note: note || (what.charAt(0).toUpperCase() + what.slice(1)),
  });
  return result;
}

// ----------------------------------------------------------------- revert
export function revertFork(forkSid, { force = false } = {}) {
  if (!UUID_RE.test(forkSid || '')) throw new ForkError('Invalid fork id.');
  const entries = readLineage();
  const entry = entries.find(e => e.forkSid === forkSid);
  if (!entry) throw new ForkError('Not a ctxtree fork; refusing to delete it.');

  const file = entry.file ? path.resolve(entry.file) : '';
  if (file && (!file.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || path.basename(file) !== `${forkSid}.jsonl`))
    throw new ForkError('Lineage entry points outside ~/.claude/projects; refusing.');

  const st = forkStatus(entry);
  if (st.exists && st.grown !== false && !force) {
    throw new ForkError(st.grown === null
      ? 'This fork predates size tracking, so ctxtree cannot prove you have not continued it. Revert with force to delete it anyway.'
      : 'This fork has grown since it was created: you resumed it and kept working. Reverting would delete that conversation. Revert with force to delete it anyway.');
  }

  const removed = [];
  if (st.exists) { fs.unlinkSync(file); removed.push(file); }
  const hist = path.join(FILE_HISTORY_DIR, forkSid);
  if (fs.existsSync(hist)) { fs.rmSync(hist, { recursive: true, force: true }); removed.push(hist); }
  const prof = profilePath(forkSid);
  if (fs.existsSync(prof)) { fs.unlinkSync(prof); removed.push(prof); }
  if (force && file) {
    const sub = path.join(path.dirname(file), forkSid);   // subagent runs made after resuming
    if (fs.existsSync(sub)) { fs.rmSync(sub, { recursive: true, force: true }); removed.push(sub); }
  }
  writeLineage(entries.filter(e => e.forkSid !== forkSid));
  return { ok: true, removed: forkSid, paths: removed };
}
