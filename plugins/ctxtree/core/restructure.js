// Structural fork operations: the ones that act on content OUTSIDE the resumed
// context, where deleting a block would save nothing. They change which records
// the fork holds and how they chain, never what a kept record says.
//
//   uncompact -- undo the latest compaction on the resumed conversation: drop the
//                boundary and its summary, continue the post-compaction records
//                from the last pre-compaction message, and drop the boot overhead
//                Claude Code re-announced right after the compaction (it is
//                already announced earlier in the restored history; anything that
//                changed since is re-announced on resume by Claude Code itself).
//   switch    -- make a rewind branch you left the resumed one, by dropping the
//                branches that compete with it.
//   slim      -- drop every record `claude --resume` never loads. The resumed
//                request is byte-identical; the file is smaller and parses faster.
// All three were checked against the real CLI: see test/cc-e2e.js.
import { ForkError } from './fork-error.js';
import { groupDigits } from './text.js';

const MSG = (o) => o && (o.type === 'user' || o.type === 'assistant') && !o.isSidechain;
const parentOf = (o) => (o.parentUuid || (o.subtype === 'compact_boundary' ? o.logicalParentUuid : null) || null);

// Attachment types Claude Code writes as the post-compaction re-announcement.
const REANNOUNCED = new Set([
  'agent_listing_delta', 'mcp_instructions_delta', 'deferred_tools_delta', 'skill_listing',
  'instructions', 'nested_memory', 'environment', 'model', 'session_context', 'date',
  'remote_session_change', 'credential_org', 'auto_mode',
]);
// Re-injected by the compaction itself (recent files, skills in use). Only before
// your first prompt after it: a file attached to that prompt is yours.
const COMPACTION_REINJECTED = new Set(['invoked_skills', 'compact_file_reference', 'file', 'edited_text_file', 'plan_file_reference', 'todo']);
const isCompactCommand = (o) => {
  if (!o || o.type !== 'user' || !o.message) return false;
  const c = o.message.content;
  const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => (x && x.text) || '').join('') : '');
  return /^<local-command-caveat>/.test(t) || /<command-name>\/compact<\/command-name>/.test(t) ||
    (/^<local-command-stdout>/.test(t) && /Compacted/.test(t));
};

// rows -> { byUuid, idx: uuid -> row index }
function index(rows) {
  const byUuid = new Map(), idx = new Map();
  rows.forEach((r, i) => { if (r.rec && r.rec.uuid) { byUuid.set(r.rec.uuid, r.rec); idx.set(r.rec.uuid, i); } });
  return { byUuid, idx };
}

// Re-parent every kept record whose parent is dropped onto the nearest kept
// ancestor; `redirect` overrides where a dropped record leads.
function relink(rows, drop, redirect = new Map()) {
  const { byUuid } = index(rows);
  const reparent = new Map();
  const resolve = (u) => {
    const seen = new Set();
    while (u && drop.has(u) && !seen.has(u)) {
      seen.add(u);
      u = redirect.has(u) ? redirect.get(u) : (byUuid.get(u) || {}).parentUuid || null;
    }
    return u || null;
  };
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || drop.has(o.uuid) || !o.parentUuid || !drop.has(o.parentUuid)) continue;
    reparent.set(o.uuid, resolve(o.parentUuid));
  }
  return reparent;
}

export function compactionInfo(parsed) {
  const root = parsed.order && parsed.order.length ? parsed.byUuid.get(parsed.order[0]) : null;
  if (!root || root.subtype !== 'compact_boundary') return null;
  const lp = root.logicalParentUuid;
  return { boundary: root.uuid, logicalParent: lp, restorable: !!(lp && parsed.byUuid.has(lp)), meta: root.compactMetadata || {} };
}

export function planUncompact(parsed) {
  const info = compactionInfo(parsed);
  if (!info) throw new ForkError('The resumed context does not start at a compaction; there is nothing to uncompact.');
  if (!info.restorable) throw new ForkError('The history before this compaction is not in the session file, so it cannot be restored.');
  const { rows } = parsed;
  const { byUuid, idx } = index(rows);
  const B = byUuid.get(info.boundary);
  const S = rows.map(r => r.rec).find(o => o && o.parentUuid === B.uuid && o.isCompactSummary);
  const drop = new Set([B.uuid]);
  if (S) drop.add(S.uuid);
  // The re-announcement burst: live records after the boundary, before the first
  // live assistant message written after it.
  const bIdx = idx.get(B.uuid);
  let prompted = false;
  for (let i = bIdx + 1; i < rows.length; i++) {
    const o = rows[i].rec;
    if (!o || !o.uuid || !parsed.live.has(o.uuid) || o.uuid === (S && S.uuid)) continue;
    if (o.type === 'assistant' && !o.isSidechain) break;
    const t = o.type === 'attachment' ? (o.attachment || {}).type : '';
    if (t && (REANNOUNCED.has(t) || (!prompted && COMPACTION_REINJECTED.has(t)))) drop.add(o.uuid);
    else if (isCompactCommand(o)) drop.add(o.uuid);
    else if (o.type === 'user' && !o.isMeta) prompted = true;
  }
  const redirect = new Map([[B.uuid, info.logicalParent]]);
  if (S) redirect.set(S.uuid, info.logicalParent);
  const reparent = relink(rows, drop, redirect);
  // A session that ended right after compacting has only the compaction's own
  // records after it; then the restored history itself is what resumes.
  const expectLeaf = drop.has(parsed.leafUuid) ? null : parsed.leafUuid;
  return { op: 'uncompact', drop, reparent, expectLeaf, mustBeLive: [info.logicalParent],
    note: `Uncompacted: restored the history before the latest compaction (${groupDigits(info.meta.preTokens || 0)} tokens before it compacted).` };
}

export function planSwitch(parsed, tip) {
  const { rows } = parsed;
  const { byUuid } = index(rows);
  const T = byUuid.get(tip);
  if (!T || !MSG(T)) throw new ForkError('That branch tip is not a message in this session.');
  if (tip === parsed.leafUuid) throw new ForkError('That branch is already the resumed one.');
  // The branch's own history, across compactions.
  const path = new Set();
  for (let u = tip, seen = new Set(); u && !seen.has(u); ) { seen.add(u); path.add(u); const o = byUuid.get(u); u = o ? parentOf(o) : null; }
  // For each record, the first record of that history it descends from. Hanging
  // off the tip = the branch itself (kept); off anything earlier = a branch that
  // competes with it (dropped).
  const hit = new Map();
  const firstOnPath = (u) => {
    const trail = [];
    let h = null;
    for (let p = u, seen = new Set(); p && !seen.has(p); ) {
      seen.add(p);
      if (path.has(p)) { h = p; break; }
      if (hit.has(p)) { h = hit.get(p); break; }
      trail.push(p);
      const q = byUuid.get(p); p = q ? parentOf(q) : null;
    }
    for (const t of trail) hit.set(t, h);
    return h;
  };
  // Results of parallel tool calls hang off their own call, beside the path; they
  // belong to it (Claude Code merges them into the turn).
  const pathUses = new Set(), pathAnswered = new Set();
  for (const u of path) {
    const o = byUuid.get(u);
    const c = o && o.message && o.message.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b && b.type === 'tool_use') pathUses.add(b.id);
      if (b && b.type === 'tool_result') pathAnswered.add(b.tool_use_id);
    }
  }
  const companion = (o) => {
    const c = o.message && o.message.content;
    return o.type === 'user' && path.has(o.parentUuid) && Array.isArray(c) && c.length > 0 &&
      c.every(b => b && b.type === 'tool_result' && pathUses.has(b.tool_use_id) && !pathAnswered.has(b.tool_use_id));
  };
  const drop = new Set();
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || path.has(o.uuid) || o.isSidechain || companion(o)) continue;
    const h = firstOnPath(parentOf(o));
    if (h && h !== tip) drop.add(o.uuid);
  }
  const lastMsg = [...rows].reverse().map(r => r.rec).find(o => MSG(o) && !drop.has(o.uuid));
  if (!lastMsg || (lastMsg.uuid !== tip && firstOnPath(parentOf(lastMsg)) !== tip))
    throw new ForkError('Another conversation in this file would still be resumed instead of that branch.');
  return { op: 'switch', drop, reparent: new Map(), expectLeaf: null, mustBeLive: [tip], tip,
    note: `Switched to the rewind branch ending at ${tip.slice(0, 8)}; the branch you were on stays in the parent session.` };
}

export function planSlim(parsed) {
  const { rows, live } = parsed;
  const { byUuid } = index(rows);
  const keep = new Set(live);
  // What hangs off the leaf (turn_duration and friends) is after the resumed chain.
  let grew = true;
  const tail = new Set(parsed.leafUuid ? [parsed.leafUuid] : []);
  while (grew) {
    grew = false;
    for (const r of rows) { const o = r.rec; if (o && o.uuid && !tail.has(o.uuid) && o.parentUuid && tail.has(o.parentUuid)) { tail.add(o.uuid); keep.add(o.uuid); grew = true; } }
  }
  // Claude Code merges records that share a message id into one message, even off
  // the chain. Keep any such record together with its whole history, so nothing
  // it merges with changes and nothing is left dangling.
  const liveIds = new Set();
  for (const u of live) { const o = byUuid.get(u); if (o && o.message && o.message.id) liveIds.add(o.message.id); }
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || keep.has(o.uuid) || !(o.message && o.message.id && liveIds.has(o.message.id))) continue;
    for (let u = o.uuid, seen = new Set(); u && !seen.has(u); ) { seen.add(u); keep.add(u); const q = byUuid.get(u); u = q ? q.parentUuid : null; }
  }
  const drop = new Set();
  for (const r of rows) {
    const o = r.rec;
    if (o && o.uuid && !keep.has(o.uuid) && !o.isSidechain) drop.add(o.uuid);
  }
  if (!drop.size) throw new ForkError('Every record in this session is part of the resumed context; there is nothing to slim.');
  return { op: 'slim', drop, reparent: relink(rows, drop), expectLeaf: parsed.leafUuid, sameLive: true,
    note: `Slimmed: dropped ${groupDigits(drop.size)} record(s) that resume never loads.` };
}

// Hard delete: drop whole records from the resumed conversation (a task, a
// tool step, an attachment) and continue what follows from what came before.
// Whole API messages only: every record sharing a dropped record's message id
// goes too, a dropped call takes its results and a dropped result its call,
// and records Claude Code wrote about a dropped call (hook output, progress)
// go with it. So the conversation still alternates and every call still pairs;
// verifyStructure checks both on the result.
const TOOL_REF = ['toolUseID', 'sourceToolUseID', 'parentToolUseID'];
const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
export function planDrop(parsed, recs) {
  const { rows } = parsed;
  const { byUuid } = index(rows);
  const want = [...new Set(recs || [])];
  if (!want.length) throw new ForkError('Nothing to delete.');
  const gone = want.filter(u => !byUuid.has(u));
  if (gone.length) throw new ForkError(`${gone.length} of the records to delete are no longer in this session. Reload it and mark them again.`);
  const byMsg = new Map(), callRec = new Map(), resultRecs = new Map(), refRecs = new Map();
  const add = (m, k, u) => { const l = m.get(k); if (l) l.push(u); else m.set(k, [u]); };
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || o.isSidechain) continue;
    if (o.type === 'assistant' && o.message && o.message.id) add(byMsg, o.message.id, o.uuid);
    const c = o.message && o.message.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b && b.type === 'tool_use' && b.id) callRec.set(b.id, o.uuid);
      if (b && b.type === 'tool_result' && b.tool_use_id) add(resultRecs, b.tool_use_id, o.uuid);
    }
    for (const k of TOOL_REF) if (typeof o[k] === 'string' && o[k]) add(refRecs, o[k], o.uuid);
  }
  const drop = new Set(), queue = [...want];
  while (queue.length) {
    const u = queue.pop();
    if (drop.has(u)) continue;
    drop.add(u);
    const o = byUuid.get(u);
    if (o.type === 'assistant' && o.message && o.message.id) queue.push(...(byMsg.get(o.message.id) || []));
    const c = o.message && o.message.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b && b.type === 'tool_use' && b.id) queue.push(...(resultRecs.get(b.id) || []), ...(refRecs.get(b.id) || []));
      if (b && b.type === 'tool_result' && callRec.has(b.tool_use_id)) queue.push(callRec.get(b.tool_use_id));
    }
  }
  // The fork resumes where the conversation was, less what went: the last
  // message of the resumed chain that stays. Resume follows the last message
  // in the file, so a rewound branch written after that point would take over;
  // it leaves the fork (it stays in the parent), with what hangs off it.
  const leafAfter = [...parsed.order].reverse().find(u => !drop.has(u) && MSG(byUuid.get(u))) || null;
  const lineOf = new Map();
  rows.forEach((r, i) => { if (r.rec && r.rec.uuid) lineOf.set(r.rec.uuid, i); });
  if (leafAfter) {
    const cut = lineOf.get(leafAfter);
    const stray = new Set();
    rows.forEach((r, i) => {
      const o = r.rec;
      if (!o || !o.uuid || o.isSidechain || drop.has(o.uuid) || i <= cut) return;
      if (MSG(o) || (o.parentUuid && stray.has(o.parentUuid))) stray.add(o.uuid);
    });
    for (const u of stray) drop.add(u);
  }
  // What the resume picker shows as your last prompt, when that prompt goes.
  const said = new Set();
  for (const u of drop) {
    const o = byUuid.get(u);
    if (o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '');
    if (t.trim()) said.add(squash(t));
  }
  // ... and the copies Claude Code keeps beside the conversation: the resume
  // picker's last prompt (maybe only its start) and the queue a prompt waited in.
  const copy = (rec) => (rec.type === 'last-prompt' ? rec.lastPrompt : rec.type === 'queue-operation' ? rec.content : null);
  const extra = (rec) => {
    const t = copy(rec);
    if (typeof t !== 'string') return false;
    const lp = squash(t).replace(/[.…]+$/, '');
    return lp.length > 0 && [...said].some(x => x.startsWith(lp));
  };
  const live = [...drop].filter(u => parsed.live.has(u)).length;
  return { op: 'drop', drop, extra, reparent: relink(rows, drop), expectLeaf: drop.has(parsed.leafUuid) ? null : parsed.leafUuid, leafAfter,
    note: `Deleted ${groupDigits(live)} record(s) from the conversation.` };
}

// The request journal Claude Code 2.1.312+ writes beside the conversation
// (api-request: each request as a delta of the last; api-request-blob: the
// messages it added, verbatim). It describes the parent's requests, copies text
// a fork may have removed, and resume rebuilds requests from the messages (a
// session without it resumes as before), so a fork never carries it.
const JOURNAL = new Set(['api-request', 'api-request-blob', 'api-request-shape']);
export const hasJournal = (parsed) => parsed.rows.some(r => r.rec && JOURNAL.has(r.rec.type));
function planJournal(parsed) {
  return { op: 'journal', drop: new Set(), reparent: new Map(), expectLeaf: parsed.leafUuid, sameLive: true, note: '' };
}

export function planFor(parsed, op) {
  switch (op && op.op) {
    case 'uncompact': return planUncompact(parsed);
    case 'switch': return planSwitch(parsed, op.tip);
    case 'slim': return planSlim(parsed);
    case 'drop': return planDrop(parsed, op.recs);
    case 'journal': return planJournal(parsed);
    default: throw new ForkError(`Unknown structural operation: ${op && op.op}`);
  }
}

// Records without a uuid (last-prompt, file-history-snapshot, mode, ...) are kept,
// except a last-prompt that points at a dropped leaf (or names a dropped prompt)
// and the request journal.
export const dropsRow = (rec, drop, extra) => !!rec && ((rec.uuid && drop.has(rec.uuid)) ||
  (rec.type === 'last-prompt' && rec.leafUuid && drop.has(rec.leafUuid)) ||
  JOURNAL.has(rec.type) || !!(extra && extra(rec)));

// Claude's turns and yours must still alternate: two different replies of
// Claude's back to back, or a conversation that opens with one, is a request
// the API refuses. Counted, so a session that already had one is compared
// with itself.
export function turnBreaks(parsed) {
  let n = 0, prev = null;
  for (const u of parsed.order) {
    const o = parsed.byUuid.get(u);
    if (!MSG(o)) continue;
    const id = o.type === 'assistant' ? (o.message && o.message.id) || o.uuid : null;
    if (o.type === 'assistant' && (prev === null ? true : prev !== 'user' && prev !== id)) n++;
    prev = o.type === 'user' ? 'user' : id;
  }
  return n;
}

// What the resumed conversation looks like around its compaction and branches, for
// the UI to offer the operations above.
export function structureInfo(parsed) {
  const c = compactionInfo(parsed);
  const branches = new Map();
  for (const b of parsed.blocks) {
    if (b.deadKind !== 'branch' || !b.branchTip) continue;
    const e = branches.get(b.branchTip) || { tip: b.branchTip, blocks: 0, chars: 0, firstText: '', ts: b.ts, conversational: false };
    e.blocks++; e.chars += b.chars;
    if (b.blockType === 'text' && b.text.trim()) e.conversational = true;
    if (!e.firstText && b.role === 'user' && b.blockType === 'text' && b.text.trim()) e.firstText = b.text.trim().slice(0, 120);
    branches.set(b.branchTip, e);
  }
  // A dead record with no prompt or reply of its own is a stray result of an
  // interrupted or retried call, not a timeline you could switch to.
  for (const [k, e] of branches) if (!e.conversational) branches.delete(k);
  let deadChars = 0, compactedChars = 0;
  for (const b of parsed.blocks) if (!b.live) { deadChars += b.chars; if (b.deadKind === 'compacted') compactedChars += b.chars; }
  return {
    compaction: c ? { restorable: c.restorable, preTokens: c.meta.preTokens || 0, trigger: c.meta.trigger || '', compactedChars } : null,
    branches: [...branches.values()].sort((a, b) => b.chars - a.chars),
    deadChars,
  };
}
