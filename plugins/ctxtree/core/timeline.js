// A task as it happened: your message, then everything Claude did for it, in
// order. Tool calls are one entry each (what Claude sent and what came back);
// messages carry their text, up to `limit` characters. Entries name the map's
// own leaves, so a mark made here is the same mark the tree shows. Pure: the
// caller hands in the task node (from the map's by-task tree) and a block lookup.

// How much of one block a view loads before it asks for the rest.
export const PREVIEW_CHARS = 20000;

const KIND = { prompt: 'prompt', reply: 'reply', attach: 'attach', image: 'image' };

export function timelineOf(task, blockOf, { limit = PREVIEW_CHARS } = {}) {
  if (!task || !task.kids) return [];
  const kids = [...task.kids].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  const entries = kids.map((k) => {
    const kind = k.blocks ? 'tool' : (KIND[k.t] || 'other');
    const e = {
      id: k.id, kind, name: k.name, t: k.t, tok: k.tok || 0, turn: k.turn || 0,
      deletable: (k.acts || []).length > 0, lock: k.lock || '',
    };
    if (k.err) e.err = true;
    if (k.stale) e.stale = typeof k.stale === 'string' ? k.stale : 'A later turn made this out of date.';
    if (kind === 'tool') {
      e.parts = k.blocks.map((id) => {
        const b = blockOf(id);
        return { id, role: b && b.blockType === 'tool_use' ? 'sent' : 'got', chars: b ? b.chars : 0 };
      });
    } else if (kind === 'prompt' || kind === 'reply') {
      const b = blockOf(k.id);
      const text = b ? b.text : '';
      e.text = text.slice(0, limit);
      e.chars = text.length;
      e.truncated = text.length > limit;
    }
    return e;
  });
  // Claude Code records many small attachments (reminders, environment,
  // snapshots); a run of them reads as one line, not dozens.
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.kind !== 'attach') { out.push(e); continue; }
    const label = e.name.replace(/^Attachment: /, '');
    if (prev && prev.kind === 'attach') {
      prev.count++; prev.tok += e.tok; prev.ids.push(e.id);
      if (!prev.labels.includes(label)) prev.labels.push(label);
    } else out.push({ ...e, count: 1, ids: [e.id], labels: [label] });
  }
  for (const e of out) if (e.kind === 'attach') {
    e.name = e.count === 1 ? `Attachment: ${e.labels[0]}` : `${e.count} attachments: ${e.labels.slice(0, 4).join(', ')}${e.labels.length > 4 ? ', …' : ''}`;
    delete e.labels;
  }
  return out;
}

// One block's text from `offset`, at most `limit` characters (Infinity: all
// of it). `next` is where the rest starts, 0 when nothing is left.
export function sliceText(text, { offset = 0, limit = PREVIEW_CHARS } = {}) {
  const s = String(text || '');
  const from = Math.max(0, Math.min(s.length, offset | 0));
  const end = limit === Infinity ? s.length : Math.min(s.length, from + Math.max(0, limit));
  return { text: s.slice(from, end), chars: s.length, offset: from, next: end < s.length ? end : 0, truncated: end < s.length };
}
