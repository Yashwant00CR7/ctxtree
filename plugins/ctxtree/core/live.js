// The live conversation, as the mod sees it, parsed into the same shape a
// transcript parse has, so one map builder serves the CLI and the mod.
//
// Input is Claude Code's SessionMessage list (`$.session.messages()`, and the
// same list, in the same order, that the `session.compact` hook receives):
// one entry per transcript record, `{ role, text, toolUses, toolResults? }`. An
// assistant reply that wrote text and called a tool arrives as two entries.
import { extractBlocks } from './session.js';

export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
export const NOTE_PREFIX = '[ctxtree:';

export const liveUuid = (i) => `m${i}`;
const REMINDER = /^\s*<system-reminder>/;

// What Claude sees, from `$.session.messages({ as: 'api' })`, as a SessionMessage
// list. After a compaction the plain `$.session.messages()` still lists the
// transcript from its start (the records before the compaction too); the API
// form is the request the next turn sends. One entry per text block and per run
// of tool blocks, which matches how the transcript records them (so a text's
// fingerprint finds the same message in the compaction hook's list). Claude
// Code's own reminders are left out; images and documents are counted.
export function fromApi(api) {
  const out = [];
  for (const m of api || []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    let run = null;
    const push = (msg) => { out.push(msg); run = null; };
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') {
        const t = String(b.text ?? '');
        if (!REMINDER.test(t) && t.trim()) push({ role: m.role, text: t, toolUses: [] });
      } else if (b.type === 'tool_use') {
        if (!run || run.kind !== 'use') { run = { kind: 'use', msg: { role: m.role, text: '', toolUses: [] } }; out.push(run.msg); }
        run.msg.toolUses.push({ tool_use_id: b.id, tool: b.name, input: b.input || {} });
      } else if (b.type === 'tool_result') {
        if (!run || run.kind !== 'result') { run = { kind: 'result', msg: { role: m.role, text: '', toolUses: [], toolResults: [] } }; out.push(run.msg); }
        const c = b.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '';
        const media = Array.isArray(c) && c.some(x => x && (x.type === 'image' || x.type === 'document'));
        run.msg.toolResults.push({ tool_use_id: b.tool_use_id, text, isError: !!b.is_error, ...(media ? { media: true } : {}) });
      } else if (b.type === 'image' || b.type === 'document') {
        push({ role: m.role, text: '', toolUses: [], media: 1 });
      }
    }
  }
  return out;
}

export function parseLive(messages) {
  const rows = [];
  let reply = 0, prevRole = '';
  (messages || []).forEach((m, i) => {
    const content = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const t of m.toolUses || []) content.push({ type: 'tool_use', id: t.tool_use_id, name: t.tool, input: t.input });
    for (const r of m.toolResults || []) content.push({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.media ? [{ type: 'text', text: r.text }, { type: 'image' }] : r.text, is_error: !!r.isError });
    for (let k = 0; k < (m.media || 0); k++) content.push({ type: 'image' });
    // A reply is the run of assistant entries between two user entries; the
    // transcript parser counts turns by distinct message ids with usage.
    if (m.role === 'assistant' && prevRole !== 'assistant') reply++;
    prevRole = m.role;
    const message = { role: m.role, content };
    if (m.role === 'assistant') { message.id = `r${reply}`; message.usage = {}; }
    const rec = { type: m.role, uuid: liveUuid(i), message };
    if (m.role === 'user' && typeof m.text === 'string') {
      if (m.text.startsWith(SUMMARY_PREFIX)) rec.isCompactSummary = true;
      else if (m.text.startsWith(NOTE_PREFIX)) rec.isMeta = true;
    }
    rows.push({ line: i, rec });
  });
  const live = new Set(rows.map(r => r.rec.uuid));
  const byUuid = new Map(rows.map(r => [r.rec.uuid, r.rec]));
  const { blocks, turns } = extractBlocks(rows, live);
  // An image or document on its own can't be dropped by address, and any apply
  // removes it anyway (a rebuilt message carries text and tool calls only).
  for (const b of blocks) if (b.blockType === 'image') { b.editable = false; b.lock = 'Images and documents are removed by any Apply: a rebuilt message carries text and tool calls only.'; }
  return {
    lines: [], trailingNewline: false, rows, live, byUuid, blocks, turns,
    leafUuid: rows.length ? rows[rows.length - 1].rec.uuid : null,
    order: rows.map(r => r.rec.uuid), dead: new Map(),
  };
}

// Where a live block sits, in terms that survive the conversation growing:
// tool blocks by tool_use_id, text by position and fingerprint.
export function addressOf(block) {
  if (block.blockType === 'tool_use') return { kind: 'use', tuid: block.tuid };
  if (block.blockType === 'tool_result') return { kind: 'result', tuid: block.tuid };
  return { kind: 'text', i: block.line, role: block.role, fp: block.fp };
}
