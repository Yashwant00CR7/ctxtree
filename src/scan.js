import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './paths.js';
import { extractAttachment } from './attach.js';

// Cheap, collision-safe-enough content fingerprint: length + both edges.
// Full hashing of ~98MB would cost more than the entire scan budget.
function fingerprint(s) {
  const n = s.length;
  const head = s.slice(0, 256);
  const tail = n > 512 ? s.slice(-256) : '';
  let h = 0x811c9dc5;
  const probe = head + tail;
  for (let i = 0; i < probe.length; i++) {
    h ^= probe.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${n.toString(36)}.${h.toString(36)}`;
}

// A session is <project>/<sid>.jsonl. Every Task/Agent call also writes its own
// transcript at <project>/<sid>/subagents/agent-*.jsonl -- a SEPARATE context
// window whose cost is invisible to the parent, which only sees the final report.
export function listSessionFiles(root = PROJECTS_DIR) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(root, d.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sid = e.name.slice(0, -6);
      out.push({ project: d.name, sid, file: path.join(pdir, e.name),
                 subagents: collectSub(path.join(pdir, sid)) });
    }
  }
  return out;
}

// Short human label for what a tool call was actually operating on.
function targetOf(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k]; return ''; };
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Bash':
      return pick('command').replace(/\s+/g, ' ').slice(0, 90);
    case 'Grep': case 'Glob':
      return pick('pattern', 'glob');
    case 'WebFetch': case 'WebSearch':
      return pick('url', 'query');
    case 'Task': case 'Agent':
      return pick('description', 'subagent_type');
    default: {
      const s = pick('path', 'file_path', 'query', 'url', 'name', 'description', 'prompt');
      return s.slice(0, 90);
    }
  }
}

const isRealPrompt = (text) => {
  const t = (text || '').trim();
  if (!t) return false;
  if (/^\[Request interrupted/i.test(t)) return false;
  if (/^(continue|go on|go ahead|proceed|yes|yep|ok|okay|k|y|next|more)\b[.!\s]*$/i.test(t)) return false;
  return true;
};

// Everything under <project>/<sid>/ is a sub-context of that session: subagent
// runs, workflow runs, and whatever shape ships next. Collected recursively so a
// new layout is picked up rather than silently dropped.
function collectSub(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSub(p, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) {
      const rel = p.split(`${path.sep}subagents${path.sep}`).pop();
      const type = rel.includes('workflows') ? 'workflow' : 'subagent';
      const label = e.name.replace(/^agent-|\.jsonl$/g, '').slice(0, 18);
      out.push({ agent: label, type, rel, file: p });
    }
  }
  return out;
}

export function scanSession({ project, sid, file, subagents = [] }) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const chunks = [];
  const samples = [];          // calibration observations
  const prompts = [];          // region boundaries
  const toolNameById = new Map();
  const targetById = new Map();

  let cwd = '', gitBranch = '', version = '', firstTs = '', lastTs = '';
  let prevTotal = null, prevCum = null, compacts = 0, records = 0;
  let turn = 0;                 // index of the next assistant API turn
  let thinkTokens = 0, outTokens = 0, shipped = 0;
  // One API response is written as several records sharing message.id, each
  // repeating usage. A turn is a distinct call; counting records inflated turns,
  // residency and the "measured" shipped total by ~2.3x.
  const seenCalls = new Set();
  const callOut = new Map(), callThink = new Map();
  const compactTurns = [];      // turns at which context was wiped
  const snapParts = new Map();  // resident snapshots, deduped by node key
  let residentChars = 0;        // size of the always-resident prefix
  const deltaCovered = new Set(); // node keys already authoritative via snapshot
  let cum = { text: 0, thinking: 0, tool_use: 0, tool_result: 0, image: 0, attach: 0 };
  let bootAnchor = null;       // {total, priorChars} at first assistant turn
  let idx = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    records++;
    idx++;
    // The input of a call is everything written before its first record.
    const preCum = (o.type === 'assistant' && o.message && o.message.usage && !o.isSidechain) ? { ...cum } : null;

    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.gitBranch && !gitBranch) gitBranch = o.gitBranch;
    if (o.version) version = o.version;
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    if (o.subtype === 'compact_boundary') { compacts++; prevTotal = null; prevCum = null; compactTurns.push(turn); }

    if (o.type === 'attachment') {
      const sidechainAttach = !!o.isSidechain;
      const r = extractAttachment(o.attachment);
      if (r) for (const part of r.parts) {
        if (!part.chars) continue;
        if (!sidechainAttach && !r.resident) cum.attach = (cum.attach || 0) + part.chars;
        const key = `${part.cat}|${part.sub}|${part.leaf || ''}|${part.part || ''}`;
        if (r.resident) {
          // The resident prefix is present from the first request. A snapshot is a
          // RECORD of it, not new content -- counting it where it was written makes
          // 745k chars appear mid-session for no tokens. Pin it to turn 0, keep the
          // largest statement per node, and let a snapshot supersede deltas.
          const prev = snapParts.get(key);
          const isSnap = !!r.snapshot;
          if (isSnap) deltaCovered.add(key);
          if (!prev) snapParts.set(key, { ...part, turn: 0, chars: part.chars, snap: isSnap });
          else if (isSnap && !prev.snap) { prev.chars = part.chars; prev.snap = true; if (part.n) prev.n = part.n; }
          else if (isSnap === prev.snap) {
            prev.chars = Math.max(prev.chars, isSnap ? part.chars : prev.chars + part.chars);
            if (part.n) prev.n = Math.max(prev.n || 0, part.n);
          }
        } else {
          chunks.push({ i: idx, turn, kind: 'attach', cat: part.cat, sub: part.sub,
            leaf: part.leaf || '', role: 'attachment', tool: '', target: part.leaf || '',
            tuid: '', chars: part.chars, fp: `a.${key}.${part.chars}`, uuid: o.uuid,
            ts: o.timestamp, side: 0, exact: part.exact !== false });
        }
      }
      continue;
    }

    const sidechain = !!o.isSidechain;
    const m = o.message;
    if (!m || typeof m !== 'object') continue;

    const content = m.content;
    const blocks = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : (Array.isArray(content) ? content : []);

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      let kind = b.type, chars = 0, tool = '', target = '', tuid = '', body = '';

      if (kind === 'text') { body = b.text || ''; chars = body.length; }
      else if (kind === 'thinking') { body = b.thinking || b.text || ''; chars = body.length; }
      else if (kind === 'tool_use') {
        tool = b.name || '?';
        target = targetOf(tool, b.input);
        body = JSON.stringify(b.input || {});
        chars = body.length + tool.length + 24;
        if (b.id) { toolNameById.set(b.id, tool); targetById.set(b.id, target); }
        tuid = b.id || '';
      } else if (kind === 'tool_result') {
        tuid = b.tool_use_id || '';
        tool = toolNameById.get(tuid) || '?';
        target = targetById.get(tuid) || '';
        const c = b.content;
        if (typeof c === 'string') body = c;
        else if (Array.isArray(c)) {
          body = c.map(x => (x && x.type === 'text') ? (x.text || '') : JSON.stringify(x)).join('');
          if (c.some(x => x && x.type === 'image')) kind = 'image';
        } else body = JSON.stringify(c ?? '');
        chars = body.length;
      } else { body = JSON.stringify(b); chars = body.length; }

      if (kind === 'image') chars = Math.max(chars, 0);
      if (!cum[kind] && cum[kind] !== 0) cum[kind] = 0;
      if (!sidechain) cum[kind] += chars;

      // Region boundary: a real user prompt, not a tool result wearing a user costume.
      if (o.type === 'user' && kind === 'text' && !o.isMeta && !sidechain) {
        prompts.push({ idx, uuid: o.uuid, ts: o.timestamp, text: body, real: isRealPrompt(body) });
      }

      let cat = 'conversation', sub = 'assistant replies', leaf = '';
      if (kind === 'tool_use' || kind === 'tool_result' || kind === 'image') {
        cat = 'tools'; sub = tool || '?'; leaf = target || '';
      } else if (kind === 'thinking') { sub = 'thinking'; }
      else if (o.type === 'user') { sub = 'your prompts'; }

      chunks.push({
        i: idx, turn, kind, cat, sub, leaf, role: o.type, tool, target, tuid,
        chars, fp: fingerprint(body), uuid: o.uuid, ts: o.timestamp,
        side: sidechain ? 1 : 0, exact: true,
      });
    }

    // Calibration + boot anchor from measured usage.
    if (o.type === 'assistant' && m.usage && !sidechain) {
      const u = m.usage;
      const call = m.id || o.uuid;
      const think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
      callOut.set(call, Math.max(callOut.get(call) || 0, u.output_tokens || 0));
      callThink.set(call, Math.max(callThink.get(call) || 0, think));
      if (seenCalls.has(call)) continue;          // same call, repeated usage
      seenCalls.add(call);
      const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      shipped += total;   // every call re-ships the whole context: this IS Allocated
      if (total > 0) {
        const snap = preCum;
        if (bootAnchor === null) {
          bootAnchor = { total, chars: Object.values(snap).reduce((a, b) => a + b, 0), cum: snap };
        }
        if (prevTotal !== null && total > prevTotal) {
          const d = {};
          let any = false;
          for (const k of Object.keys(snap)) {
            d[k] = snap[k] - (prevCum[k] || 0);
            if (d[k] > 0) any = true;
            if (d[k] < 0) { any = false; break; }
          }
          if (any) samples.push({ d, y: total - prevTotal });
        }
        prevTotal = total; prevCum = snap;
      }
      turn++;
    }
  }

  for (const v of callOut.values()) outTokens += v;
  for (const v of callThink.values()) thinkTokens += v;

  // Resident snapshots become one chunk each, introduced at their first sighting.
  for (const [key, part] of snapParts) {
    if (!part.snap && deltaCovered.has(key)) continue; // snapshot already authoritative
    residentChars += part.chars;
    chunks.push({ i: 0, turn: 0, kind: 'attach', cat: part.cat, sub: part.sub,
      leaf: part.leaf || '', role: 'attachment', tool: '', target: part.leaf || '',
      tuid: '', chars: part.chars, n: part.n, part: part.part || '', fp: `r.${key}`, uuid: '', ts: firstTs,
      side: 0, resident: 1, exact: part.exact !== false });
  }

  // Allocated = size x turns resident. Residency ends at the next compaction.
  const T = Math.max(turn, 1);
  for (const c of chunks) {
    const nextCompact = compactTurns.find(ct => ct > c.turn);
    c.live = Math.max(1, (nextCompact ?? T) - c.turn);
  }

  // Subagent transcripts: separate context windows, folded in as their own branch.
  const agents = [];
  for (const sa of subagents) {
    const r = scanAgent(sa, idx);
    if (!r) continue;
    idx = r.nextIdx;
    agents.push(r.agent);
    for (const c of r.chunks) chunks.push(c);
    for (const smp of r.samples) samples.push(smp);
  }

  const session = {
    sid, project, file, cwd, gitBranch, version,
    firstTs, lastTs, records, compacts,
    peak: prevTotal || (bootAnchor ? bootAnchor.total : 0),
    boot: bootAnchor,
    bytes: raw.length,
    nChunks: chunks.length,
    turns: turn,
    thinkTokens, outTokens, residentChars, shipped,
    prompts,
    compactTurns,
    agents,
  };
  return { session, chunks, samples, prompts };
}

// A subagent transcript is a full context window of its own. We measure it the
// same way, but tag every chunk so it is never mixed into the parent's window.
function scanAgent({ agent, type = 'subagent', file }, startIdx) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const chunks = [], samples = [];
  const toolNameById = new Map(), targetById = new Map();
  let idx = startIdx, peak = 0, records = 0, prevTotal = null, prevCum = null, aturn = 0, ashipped = 0;
  let cum = { text: 0, thinking: 0, tool_use: 0, tool_result: 0, image: 0 };
  const seenCalls = new Set();

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    records++; idx++;
    const preCum = (o.type === 'assistant' && o.message && o.message.usage) ? { ...cum } : null;
    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    const content = m.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }]
      : (Array.isArray(content) ? content : []);

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      let kind = b.type, chars = 0, tool = '', target = '', tuid = '', body = '';
      if (kind === 'text') { body = b.text || ''; chars = body.length; }
      else if (kind === 'thinking') { body = b.thinking || b.text || ''; chars = body.length; }
      else if (kind === 'tool_use') {
        tool = b.name || '?'; target = targetOf(tool, b.input);
        body = JSON.stringify(b.input || {}); chars = body.length + tool.length + 24;
        if (b.id) { toolNameById.set(b.id, tool); targetById.set(b.id, target); }
        tuid = b.id || '';
      } else if (kind === 'tool_result') {
        tuid = b.tool_use_id || ''; tool = toolNameById.get(tuid) || '?'; target = targetById.get(tuid) || '';
        const c = b.content;
        if (typeof c === 'string') body = c;
        else if (Array.isArray(c)) {
          body = c.map(x => (x && x.type === 'text') ? (x.text || '') : JSON.stringify(x)).join('');
          if (c.some(x => x && x.type === 'image')) kind = 'image';
        } else body = JSON.stringify(c ?? '');
        chars = body.length;
      } else { body = JSON.stringify(b); chars = body.length; }

      if (cum[kind] === undefined) cum[kind] = 0;
      cum[kind] += chars;
      chunks.push({ i: idx, turn: aturn, kind, cat: 'subcontext', sub: `${type}: ${agent}`,
        leaf: kind === 'tool_result' || kind === 'tool_use' ? (tool || '') : '',
        role: o.type, tool, target, tuid, chars, live: 1,
        fp: fingerprint(body), uuid: o.uuid, ts: o.timestamp, side: 0, agent, exact: true });
    }

    if (o.type === 'assistant' && m.usage) {
      const call = m.id || o.uuid;
      if (seenCalls.has(call)) continue;
      seenCalls.add(call);
      const u = m.usage;
      const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (total > 0) {
        const snap = preCum;
        if (prevTotal !== null && total > prevTotal) {
          const d = {}; let any = false;
          for (const k of Object.keys(snap)) {
            d[k] = snap[k] - (prevCum[k] || 0);
            if (d[k] > 0) any = true;
            if (d[k] < 0) { any = false; break; }
          }
          if (any) samples.push({ d, y: total - prevTotal });
        }
        prevTotal = total; prevCum = snap; peak = Math.max(peak, total); ashipped += total;
      }
      aturn++;
    }
  }
  return { agent: { agent, type, file, records, peak, shipped: ashipped, bytes: raw.length, nChunks: chunks.length },
           chunks, samples, nextIdx: idx };
}

export function scanAll(root = PROJECTS_DIR) {
  const t0 = Date.now();
  const files = listSessionFiles(root);
  const sessions = [], allSamples = [], byId = new Map();
  for (const f of files) {
    const r = scanSession(f);
    if (!r) continue;
    sessions.push(r.session);
    byId.set(r.session.sid, r);
    for (const s of r.samples) allSamples.push(s);
  }
  return { sessions, byId, samples: allSamples, ms: Date.now() - t0, nFiles: files.length };
}
