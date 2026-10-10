// What the UI can delete, and the one call that deletes it.
//
// A tree node or treemap rectangle is a set of things with very different
// deletion mechanics. This module resolves a node to the operations that
// actually shrink what `claude --resume` sends:
//   tool results   -> tombstones (live, editable blocks only)
//   boot overhead  -> boot removals + a launch profile (boot.js)
//   grey content   -> structural ops (restructure.js): uncompact, switch, slim
// and says plainly what it skipped and why.
import fs from 'node:fs';
import { parseSession } from './session.js';
import { forkSession, ForkError } from './fork.js';
import { bootInventory } from './boot.js';
import { structureInfo } from './restructure.js';
import { tokFor } from './model.js';
import { anchoredTok } from './map.js';

const TOMBSTONED = '[ctxtree: removed';

function load(model, sid) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError('Session not found.');
  return { s, parsed: parseSession(fs.readFileSync(s.file, 'utf8')), tok: tokFor(model, s) };
}

export function bootView(model, sid) {
  const { parsed, tok } = load(model, sid);
  const items = bootInventory(parsed).map(it => ({
    id: it.id, kind: it.kind, name: it.name, display: it.display, sub: it.sub, leaf: it.leaf,
    source: it.source, mdType: it.mdType, tools: (it.tools || []).length,
    chars: it.chars, tok: tok(it.chars, 'attach'), parts: it.parts,
    removable: it.removable, reason: it.reason, how: it.how, lasts: it.lasts, warn: it.warn,
    needsProfile: !!(it.needs && Object.keys(it.needs).length),
  }));
  return { sid, items, total: items.reduce((a, i) => a + i.tok, 0) };
}

export function structureView(model, sid) {
  const { parsed, tok } = load(model, sid);
  const si = structureInfo(parsed);
  const deadBlocks = parsed.blocks.filter(b => !b.live && !b.side);
  const stray = deadBlocks.filter(b => b.deadKind === 'branch' && !si.branches.some(x => x.tip === b.branchTip));
  return {
    sid,
    compaction: si.compaction && { ...si.compaction, compactedTok: tok(si.compaction.compactedChars, 'text') },
    branches: si.branches.map(b => ({ ...b, tok: tok(b.chars, 'text') })),
    stray: { blocks: stray.length, tok: stray.reduce((a, b) => a + tok(b.chars, b.kind), 0) },
    dead: { blocks: deadBlocks.length, tok: deadBlocks.reduce((a, b) => a + tok(b.chars, b.kind), 0) },
    bytes: fs.statSync(model.sessions.find(x => x.sid === sid).file).size,
  };
}

// A tree node -> the deletions it stands for.
export function nodePlan(model, sid, { cat = '', sub = '', leaf = '', minTok = 0 } = {}) {
  const { s, parsed, tok } = load(model, sid);
  minTok = Math.max(0, Number(minTok) || 0);

  if (cat === 'boot') {
    const inv = bootInventory(parsed).filter(it => (!sub || it.sub === sub) && (!leaf || it.leaf === leaf));
    const ok = inv.filter(it => it.removable);
    return {
      kind: 'boot', label: [sub, leaf].filter(Boolean).join(' / ') || 'boot overhead',
      items: ok.map(it => ({ id: it.id, kind: it.kind, name: it.name, tok: tok(it.chars, 'attach'), warn: it.warn || '', lasts: it.lasts, how: it.how })),
      tok: ok.reduce((a, it) => a + tok(it.chars, 'attach'), 0),
      skipped: inv.filter(it => !it.removable).map(it => ({ name: it.name, reason: it.reason })),
      note: inv.length ? '' : 'Nothing removable here is in the resumed context (older Claude Code sessions record boot overhead without the pieces a fork can edit).',
    };
  }

  if (cat === 'tools' || cat === 'root' || !cat) {
    const v = model.byId.get(sid);
    const tuids = new Set();
    for (const c of v ? v.chunks : []) {
      if (c.side || c.cat !== 'tools' || !c.tuid) continue;
      if (sub && c.sub !== sub) continue;
      if (leaf && c.leaf !== leaf) continue;
      tuids.add(c.tuid);
    }
    const blocks = parsed.blocks.filter(b => (b.blockType === 'tool_result') && tuids.has(b.tuid));
    const items = [], skipped = { dead: 0, deadTok: 0, locked: 0, small: 0, done: 0 };
    for (const b of blocks) {
      const t = tok(b.chars, b.kind);
      if (!b.live) { skipped.dead++; skipped.deadTok += t; continue; }
      if (!b.editable) { skipped.locked++; continue; }
      if (b.text.startsWith(TOMBSTONED)) { skipped.done++; continue; }
      if (t < minTok) { skipped.small++; continue; }
      items.push({ id: b.id, fp: b.fp, tok: t, tool: b.tool, target: b.target.slice(0, 120), isError: b.isError });
    }
    items.sort((a, b) => b.tok - a.tok);
    return {
      kind: 'blocks', label: [sub, leaf].filter(Boolean).join(' / ') || 'all tool results',
      items, tok: items.reduce((a, i) => a + i.tok, 0), skipped,
      note: skipped.dead ? `${skipped.dead} result(s) are outside the resumed context and would save nothing; restore them with an uncompact or a branch switch instead.` : '',
    };
  }

  const why = {
    conversation: 'Your prompts and Claude\'s replies are the thread itself. Edit or bridge them in the Context Surgeon rather than deleting them wholesale.',
    injected: 'Injected content (file attachments, reminders, hook output) is edited in the Context Surgeon.',
    subcontext: 'Subagent contexts are separate conversations; they never ride along in this session\'s context.',
  };
  return { kind: 'none', label: cat, items: [], tok: 0, note: why[cat] || 'Nothing here can be deleted from a fork.', session: s.sid };
}

/** The one write path the UI uses: edits + tombstones + boot + structure, in one verified fork. */
export function applySurgery(model, { sid, edits = [], boot = [], structure = [], note = '', dryRun = false }) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError('Session not found.');
  const clean = (edits || []).map(e => ({ id: e.id, fp: e.fp, newText: e.newText, op: e.op }));
  const ops = (structure || []).map(o => (o && o.op === 'switch' ? { op: 'switch', tip: String(o.tip || '') } : { op: String(o && o.op) }));
  const kinds = [clean.length && 'edit', boot.length && 'boot', ...ops.map(o => o.op)].filter(Boolean);
  return forkSession(s, clean, { tok: anchoredTok(model, s), note, dryRun, boot: [...new Set(boot)], structure: ops, kind: kinds.length === 1 ? kinds[0] : 'surgery' });
}
