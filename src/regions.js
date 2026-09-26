// A session arrives as a flat run of records. Its only real structure is where
// you spoke: each genuine prompt starts a new stretch of work. Continuations
// ("continue", an interrupt) name nothing, so they merge into the region above.
const NOISE = /^(\[Request interrupted|<command-|<local-command|<system-reminder)/i;
const FILLER = /^(continue|go on|go ahead|proceed|carry on|yes|yeah|yep|ok|okay|k|y|sure|next|more|do it|thanks|ty)\b[\s.!,]*$/i;

const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

export function isBoundary(text) {
  const t = clean(text);
  if (!t) return false;
  if (NOISE.test(t)) return false;
  if (FILLER.test(t)) return false;
  return t.length > 12;
}

export function buildRegions(session, chunks) {
  const main = chunks.filter(c => !c.side && c.cat !== 'subcontext').sort((a, b) => a.i - b.i);
  const marks = [];
  for (const c of main) {
    if (c.cat === 'conversation' && c.sub === 'your prompts' && c.kind === 'text') {
      marks.push({ i: c.i, turn: c.turn, text: c.rawText || '', chunk: c });
    }
  }
  // Boundaries come from the chunk stream; text lives on the session's prompts list.
  const prompts = (session.prompts || []).filter(p => p.text);
  const byIdx = new Map(prompts.map(p => [p.idx, p]));

  const bounds = [];
  for (const m of marks) {
    const p = byIdx.get(m.i);
    const text = p ? p.text : '';
    if (bounds.length === 0 || isBoundary(text)) bounds.push({ i: m.i, turn: m.turn, text, merged: 0 });
    else bounds[bounds.length - 1].merged++;
  }
  if (!bounds.length) bounds.push({ i: 0, turn: 0, text: '(session start)', merged: 0 });
  if (bounds[0].i > 1) bounds.unshift({ i: 0, turn: 0, text: '(before first prompt)', merged: 0 });

  const regions = bounds.map((b, k) => ({
    id: k,
    name: clean(b.text).slice(0, 96) || '(untitled)',
    from: b.i,
    to: k + 1 < bounds.length ? bounds[k + 1].i : Infinity,
    turn: b.turn,
    merged: b.merged,
    tok: 0, alloc: 0, n: 0,
    files: new Set(), tools: new Set(),
  }));

  for (const c of main) {
    const r = regions.find(x => c.i >= x.from && c.i < x.to);
    if (!r) continue;
    r.tok += c.tok || 0; r.alloc += c.alloc || 0; r.n++;
    if (c.tool) r.tools.add(c.tool);
    if (c.target && /[/\\.]/.test(c.target)) r.files.add(c.target);
  }

  const total = regions.reduce((a, r) => a + r.alloc, 0) || 1;
  return regions.map(r => ({
    ...r,
    to: r.to === Infinity ? null : r.to,
    files: r.files.size, tools: [...r.tools].slice(0, 8),
    pct: r.alloc / total,
  })).filter(r => r.n > 0);
}
