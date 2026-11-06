// The pane's Details as rows of text: what the selection is, then its
// timeline. Messages wrap in full, a tool call is one header row, and an open
// call's parts (what Claude sent, what came back) follow it. Pure, so the
// hooks can lay it out, window it and map a click back to its entry.

// Escape sequences and control characters (tab becomes two spaces).
const CTRL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f]/g;
export const clean = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(CTRL, '');
// Messages as they were written, without the wrappers Claude Code adds.
const tidy = (t) => String(t || '').replace(/<\/?(command-[a-z-]+|local-command-[a-z-]+|system-reminder)>/g, '').trim();
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));

// Wrapped to `width` columns at a space where one falls in the second half
// of the row, else mid-word; a blank line stays a blank row.
export function wrap(text, width) {
  const w = Math.max(4, width | 0), out = [];
  for (let line of clean(text).split('\n')) {
    if (!line) { out.push(''); continue; }
    while (line.length > w) {
      const sp = line.lastIndexOf(' ', w);
      const cut = sp >= w / 2 ? sp : w;
      out.push(line.slice(0, cut));
      line = line.slice(cut === sp ? cut + 1 : cut);
    }
    out.push(line);
  }
  return out;
}

const MARK = { all: '  ✕ marked', some: '  ◐ part marked' };

// Rows: { text, style, e } where `e` is the entry's index (-1 for the head)
// and `hdr` is set on the row a click opens or closes.
/** @param {{ head?: { text: string, style?: string }[], entries?: any[], width?: number, open?: string[], cur?: number }} a */
export function readerRows({ head = [], entries = [], width = 40, open = [], cur = -1 }) {
  const rows = [];
  const W = Math.max(10, width | 0);
  const push = (text, style, e = -1, hdr = false) => rows.push({ text, style, e, hdr: hdr || undefined, cur: e === cur && hdr ? true : undefined });
  for (const h of head) for (const l of wrap(h.text, W)) push(l, h.style || 'dim');
  if (entries.length > 1) push(`What happened · ${entries.length} items · ${entries.filter(e => e.kind === 'tool').length} tool calls`, 'label');
  const isOpen = new Set(open);
  entries.forEach((e, i) => {
    const mark = MARK[e.mark] || '';
    if (e.kind === 'prompt' || e.kind === 'reply') {
      const who = e.kind === 'reply' ? 'Claude' : /^You: /.test(e.name) ? 'You' : (e.name.split(':')[0] || 'You');
      push(`${who}${e.turn ? ` · turn ${e.turn}` : ''} · ${fmt(e.tok)}${mark}`, e.kind, i, true);
      for (const l of wrap(tidy(e.text), W - 2)) push(`  ${l}`, e.mark === 'all' ? 'gone' : 'msg', i);
      if (e.truncated) push(`  … ${(e.chars - e.text.length).toLocaleString()} more characters · a shows all`, 'dim', i);
      return;
    }
    if (e.kind === 'tool') {
      const o = isOpen.has(e.id);
      const flags = `${e.err ? '  error' : ''}${e.stale ? '  out of date' : ''}`;
      push(`${o ? '▾' : '▸'} ${e.name} · ${fmt(e.tok)}${flags}${mark}`, e.mark === 'all' ? 'gone' : 'tool', i, true);
      if (!o) return;
      for (const p of e.parts || []) {
        push(`    ${p.role === 'sent' ? 'Claude sent' : 'It got back'}`, 'label', i);
        for (const l of wrap(p.text ?? '', W - 4)) push(`    ${l}`, 'body', i);
        if (p.next) push(`    … ${(p.chars - p.next).toLocaleString()} more characters · a shows all`, 'dim', i);
      }
      return;
    }
    push(`· ${e.name} · ${fmt(e.tok)}${MARK[e.mark] || ''}`, e.mark === 'all' ? 'gone' : 'dim', i, true);
  });
  return rows;
}

// The first row of entry `i`: where the window goes to show it.
export const rowOf = (rows, i) => Math.max(0, rows.findIndex(r => r.e === i && r.hdr));

// A window `height` rows tall that starts at `top`, kept inside the rows.
export const clampTop = (rows, top, height) => Math.max(0, Math.min(top | 0, Math.max(0, rows.length - height)));
