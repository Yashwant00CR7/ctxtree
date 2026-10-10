// One parser for a session transcript, shared by the editor and the fork writer
// so the two can never disagree about what lives at an address.
//
// Facts this module is built on (verified against real transcripts):
//  - Every message record carries a unique `uuid`; blocks are addressed by it,
//    never by line number, so a stray blank line cannot shift an edit.
//  - The context `claude --resume` loads is the chain from the newest message
//    back through `parentUuid`. `compact_boundary` records have parentUuid:null,
//    so the walk stops at the last compaction on its own; abandoned rewind
//    branches are simply not on the chain.
//  - One API response is written as several records sharing `message.id`, each
//    repeating `usage`. A turn is a distinct message.id, not a record.
//  - Thinking blocks are signed. Finished-turn thinking is dropped from what the
//    API sees (editing it saves nothing); an unfinished tool loop needs it intact.
import crypto from 'node:crypto';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fingerprint = (s) => crypto.createHash('sha1').update(s ?? '').digest('hex').slice(0, 16);

export const LOCKS = {
  // Verified: a fork with edited earlier-turn thinking still resumes, because
  // thinking from finished turns is dropped from what the API sees. So editing
  // it reclaims nothing -- and if a session stopped mid tool-call, the API does
  // require the latest signed thinking block unchanged. Leave it alone.
  thinking: 'Signed thinking block. Thinking from finished turns is dropped from the context the API sees, so editing it saves nothing; if the session stopped mid tool-call, the API requires it unchanged.',
  redacted: 'Redacted thinking is opaque and signed; it cannot be edited.',
  unsupported: 'This block type is not safe to rewrite.',
  sidechain: 'Sidechain record; it is not part of the main conversation.',
};

// Lines exactly as written. The final newline is remembered so output can match it.
export function splitLines(raw) {
  const lines = raw.split('\n');
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

export function parseRows(lines) {
  return lines.map((text, line) => {
    if (!text.trim()) return { line, text, rec: null, blank: true };
    try { return { line, text, rec: JSON.parse(text) }; }
    catch { return { line, text, rec: null, bad: true }; }
  });
}

// A compaction can keep its last turn verbatim: compactMetadata.preservedSegment
// names a head..tail run of pre-compaction records and the summary (anchor) they
// follow. Claude Code relinks them on load -- the record after the anchor
// continues from the tail, the head continues from the anchor -- so they are sent
// even though a plain parentUuid walk stops at the boundary before reaching them.
// Verified by resuming a real compacted session against a recording API.
function preservedSegments(rows, byUuid) {
  const seg = new Map();   // anchorUuid -> { head, tail }
  for (const r of rows) {
    const o = r.rec;
    const ps = o && o.subtype === 'compact_boundary' && o.compactMetadata && o.compactMetadata.preservedSegment;
    if (ps && ps.anchorUuid && byUuid.has(ps.headUuid) && byUuid.has(ps.tailUuid)) seg.set(ps.anchorUuid, { head: ps.headUuid, tail: ps.tailUuid });
  }
  return seg;
}

export function liveChain(rows) {
  const byUuid = new Map();
  let leaf = null;
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid) continue;
    byUuid.set(o.uuid, o);
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) leaf = o;
  }
  const seg = preservedSegments(rows, byUuid);
  const live = new Set(), order = [];
  const spliced = new Set();
  let resumeAt = null;     // anchor to return to once the preserved head is reached
  let cur = leaf;
  while (cur && !live.has(cur.uuid)) {
    live.add(cur.uuid); order.push(cur.uuid);
    let next = cur.parentUuid || null;
    if (resumeAt && cur.uuid === resumeAt.head) { next = resumeAt.anchor; resumeAt = null; }
    else if (next && seg.has(next) && !spliced.has(next) && cur.uuid !== seg.get(next).head) {
      const s = seg.get(next);
      spliced.add(next); resumeAt = { head: s.head, anchor: next }; next = s.tail;
    }
    cur = next ? byUuid.get(next) : null;
  }
  order.reverse();
  // Parallel tool calls: the call records chain one after another, but each
  // result is written as a child of ITS call, so all but the last hang off the
  // chain. Claude Code merges them back into the turn (verified by resuming a
  // real session): a result answering a live call, hanging off a live record,
  // is live.
  const liveUses = new Set();
  for (const u of live) {
    const c = byUuid.get(u).message && byUuid.get(u).message.content;
    if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && b.id) liveUses.add(b.id);
  }
  const companions = [];
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || live.has(o.uuid) || o.isSidechain || !o.parentUuid || !live.has(o.parentUuid)) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    const res = c.filter(b => b && b.type === 'tool_result');
    if (res.length && res.length === c.length && res.every(b => liveUses.has(b.tool_use_id))) companions.push(o);
  }
  for (const o of companions) {
    live.add(o.uuid);
    order.splice(order.indexOf(o.parentUuid) + 1, 0, o.uuid);
  }
  // Records written after the last message and chained to it -- the latest
  // prompt_snapshot, turn_duration, ... -- are part of what resume loads too;
  // Claude Code's own leaf pointer (last-prompt.leafUuid) usually names one.
  if (leaf) {
    const tail = new Set([leaf.uuid]);
    for (const r of rows) {
      const o = r.rec;
      if (!o || !o.uuid || live.has(o.uuid) || o.isSidechain || !tail.has(o.parentUuid)) continue;
      if (o.type === 'user' || o.type === 'assistant') continue;
      tail.add(o.uuid); live.add(o.uuid); order.push(o.uuid);
    }
  }
  return { live, leafUuid: leaf ? leaf.uuid : null, order, byUuid };
}

// What a record outside the resumed chain is, so the UI can offer the action that
// actually works on it instead of a delete that saves nothing:
//   'compacted' -- behind a compaction on the resumed conversation's own history
//                  (an uncompact brings it back); depth = compactions to undo
//   'branch'    -- on a rewind branch you left; tip = its newest message, the leaf
//                  a branch switch would resume from
export function classifyDead(rows, { live, leafUuid, byUuid }) {
  const info = new Map();
  if (!leafUuid) return info;
  // History of the resumed conversation across compactions.
  const lineage = new Map();   // uuid -> compactions crossed to reach it
  let depth = 0, cur = byUuid.get(leafUuid);
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    if (!live.has(cur.uuid)) lineage.set(cur.uuid, depth);
    let next = cur.parentUuid;
    if (!next && cur.subtype === 'compact_boundary' && cur.logicalParentUuid) { next = cur.logicalParentUuid; depth++; }
    cur = next ? byUuid.get(next) : null;
  }
  // Newest message descending from each record: later records assign first.
  const tip = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = rows[i].rec;
    if (!o || !o.uuid || o.isSidechain) continue;
    if (!tip.has(o.uuid) && (o.type === 'user' || o.type === 'assistant')) tip.set(o.uuid, o.uuid);
    const p = o.parentUuid || (o.subtype === 'compact_boundary' ? o.logicalParentUuid : null);
    if (p && tip.has(o.uuid) && !tip.has(p)) tip.set(p, tip.get(o.uuid));
  }
  for (const r of rows) {
    const o = r.rec;
    if (!o || !o.uuid || live.has(o.uuid) || o.isSidechain) continue;
    if (lineage.has(o.uuid)) info.set(o.uuid, { kind: 'compacted', depth: Math.max(1, lineage.get(o.uuid)) });
    else info.set(o.uuid, { kind: 'branch', tip: tip.get(o.uuid) || o.uuid });
  }
  return info;
}

function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k]; return ''; };
  const t = pick('file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt');
  return t.replace(/\s+/g, ' ').slice(0, 120);
}

function resultText(content) {
  if (typeof content === 'string') return { text: content, hasImage: false };
  if (Array.isArray(content)) {
    let hasImage = false;
    const text = content.map(x => {
      if (x && x.type === 'text') return x.text || '';
      if (x && x.type === 'image') { hasImage = true; return '[image]'; }
      return JSON.stringify(x);
    }).join('\n');
    return { text, hasImage };
  }
  return { text: content == null ? '' : JSON.stringify(content), hasImage: false };
}

export const blockId = (uuid, line, cIdx) => (uuid ? `b_${uuid}_${cIdx}` : `l_${line}_${cIdx}`);

// Every content block in the file, with its address and whether it may be edited.
export function extractBlocks(rows, live) {
  const blocks = [];
  const nameById = new Map(), targetById = new Map();
  const seenCalls = new Set();
  let turn = 0;

  for (const r of rows) {
    const o = r.rec;
    if (!o) continue;
    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    const role = m.role || o.type;
    const isLive = !!(o.uuid && live.has(o.uuid));
    const side = !!o.isSidechain;

    const form = typeof m.content === 'string' ? 'string' : (Array.isArray(m.content) ? 'array' : null);
    if (!form) continue;
    const content = form === 'string' ? [{ type: 'text', text: m.content }] : m.content;

    content.forEach((b, cIdx) => {
      if (!b || typeof b !== 'object') return;
      let kind = b.type, text = '', tool = '', target = '', tuid = '', lock = null;

      switch (b.type) {
        case 'text': text = b.text || ''; break;
        case 'thinking': text = b.thinking || ''; lock = LOCKS.thinking; break;
        case 'redacted_thinking': text = '[redacted thinking]'; lock = LOCKS.redacted; break;
        case 'tool_use':
          tool = b.name || '?'; tuid = b.id || '';
          target = toolTarget(tool, b.input);
          text = JSON.stringify(b.input ?? {}, null, 2);
          if (b.id) { nameById.set(b.id, tool); targetById.set(b.id, target); }
          break;
        case 'tool_result': {
          tuid = b.tool_use_id || '';
          tool = nameById.get(tuid) || '';
          target = targetById.get(tuid) || '';
          const rt = resultText(b.content);
          text = rt.text;
          if (rt.hasImage) kind = 'image';
          break;
        }
        case 'image': text = '[image]'; break;
        default: text = JSON.stringify(b); lock = LOCKS.unsupported;
      }
      if (side) lock = lock || LOCKS.sidechain;

      blocks.push({
        id: blockId(o.uuid, r.line, cIdx),
        uuid: o.uuid || '', line: r.line, cIdx, form, blockType: b.type,
        role, kind, tool, target, tuid, text,
        chars: text.length, fp: fingerprint(text),
        turn, live: isLive, side,
        editable: !lock, lock,
        isError: b.type === 'tool_result' ? !!b.is_error : false,
        ts: o.timestamp || '',
      });
    });

    if (o.type === 'assistant' && m.usage && !side) {
      const call = m.id || o.uuid;
      if (!seenCalls.has(call)) { seenCalls.add(call); turn++; }
    }
  }
  return { blocks, turns: turn };
}

export function parseSession(raw) {
  const { lines, trailingNewline } = splitLines(raw);
  const rows = parseRows(lines);
  const chain = liveChain(rows);
  const { live, leafUuid, order, byUuid } = chain;
  const { blocks, turns } = extractBlocks(rows, live);
  const dead = classifyDead(rows, chain);
  for (const b of blocks) {
    const d = !b.live && b.uuid ? dead.get(b.uuid) : null;
    if (d) { b.deadKind = d.kind; if (d.tip) b.branchTip = d.tip; if (d.depth) b.compactDepth = d.depth; }
  }
  return { lines, trailingNewline, rows, live, leafUuid, order, byUuid, dead, blocks, turns };
}

// Characters of everything the resumed request carries from this transcript:
// live message blocks, the rendered text of live attachments, and the latest
// recorded system prompt and tool list. One number, so a fork's before/after can
// be compared however it was made.
export function resumedChars(parsed) {
  let msg = 0, attach = 0, snapshot = 0;
  for (const b of parsed.blocks) if (b.live && !b.side && b.blockType !== 'thinking' && b.blockType !== 'redacted_thinking') msg += b.chars;
  let snap = null;
  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || o.type !== 'attachment' || !o.uuid || !parsed.live.has(o.uuid)) continue;
    const a = o.attachment || {};
    if (a.type === 'prompt_snapshot') { snap = a; continue; }
    if (Array.isArray(o.rendered)) attach += o.rendered.reduce((n, x) => n + (typeof (x && x.content) === 'string' ? x.content.length : 0), 0);
  }
  if (snap) snapshot = JSON.stringify(snap.systemPrompt || []).length + JSON.stringify(snap.tools || []).length;
  return { msg, attach, snapshot, total: msg + attach + snapshot };
}
