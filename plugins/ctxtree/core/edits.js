// The edits ctxtree can make to a block, and their resolution against a parse:
// shared by the fork writer (Node) and the live rebuild (the Claude Code mod).
import { groupDigits } from './text.js';

export const MAX_NEW_TEXT = 4_000_000;

export function tombstoneText(block, tok) {
  const what = block.tool ? `${block.tool} result` : (block.kind === 'image' ? 'image' : `${block.role} ${block.kind}`);
  const where = block.target ? ` for ${block.target.slice(0, 100)}` : '';
  const size = tok ? ` (~${groupDigits(tok)} tokens)` : '';
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
      return `${v.slice(0, 120).trimEnd()}\n[ctxtree: removed ${groupDigits(v.length - 120)} more characters to reclaim context]`;
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

    // An image taken out of your message; the rest of the message stays.
    if (e.op === 'remove') {
      if (b.kind !== 'image' || b.blockType !== 'image' || b.form !== 'array') { fail('Only an image in a message can be taken out on its own.'); continue; }
      resolved.push({ block: b, newText: '', remove: true });
      continue;
    }
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
