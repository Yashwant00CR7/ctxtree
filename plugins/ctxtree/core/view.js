// The tree as the pane draws it: visible rows only, sorted and filtered, with
// each row's mark state. Pure, so the pane's window is cheap to recompute on
// every key and the same rows can be tested without a terminal.

// A leaf carries the actions deleting it would take (a task item can hold its
// call's shrink and its result's drop); marks are kept per action.
export const actKey = (a) => (a.k === 'boot' ? `boot:${a.id}` : a.id);
export const actsOf = (n) => n.acts || [];

export function index(root) {
  const byId = new Map(), parent = new Map();
  const walk = (n, p) => { byId.set(n.id, n); if (p) parent.set(n.id, p); for (const k of n.kids || []) walk(k, n); };
  if (root) walk(root, null);
  return { byId, parent };
}

// 'all' when every action under n is marked, 'some' when a few are, '' else.
export function markState(n, marks) {
  let total = 0, hit = 0;
  const walk = (x) => {
    if (x.kids) return x.kids.forEach(walk);
    for (const a of actsOf(x)) { total++; if (marks.has(actKey(a))) hit++; }
  };
  walk(n);
  return !total || !hit ? '' : hit === total ? 'all' : 'some';
}

export function actsUnder(n) {
  const out = [];
  const walk = (x) => { if (x.kids) x.kids.forEach(walk); else for (const a of actsOf(x)) out.push({ act: a, leaf: x }); };
  walk(n);
  return out;
}

// Tokens a mark saves: what the actions under n would free.
export function markedSave(n, marks) {
  let s = 0;
  for (const { act } of actsUnder(n)) if (marks.has(actKey(act))) s += act.save || 0;
  return s;
}

const SORTS = {
  tok: (a, b) => b.tok - a.tok,
  turn: (a, b) => (a.ord ?? 0) - (b.ord ?? 0),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};
export const SORT_KEYS = Object.keys(SORTS);

// Rows for the whole visible tree; the pane draws a window of them.
export function flatten(root, { expanded = new Set(), sort = 'tok', filter = '', marks = new Set() } = {}) {
  const rows = [];
  if (!root) return rows;
  const q = String(filter || '').trim().toLowerCase();
  const hits = new Set();
  if (q) {
    const { parent } = index(root);
    const walk = (n) => {
      if (String(n.name).toLowerCase().includes(q)) { let p = n; while (p) { hits.add(p.id); p = parent.get(p.id); } }
      for (const k of n.kids || []) walk(k);
    };
    walk(root);
  }
  const cmp = SORTS[sort] || SORTS.tok;
  const visit = (n, depth, parentTok) => {
    if (q && !hits.has(n.id)) return;
    const kids = n.kids && n.kids.length ? n.kids : null;
    const open = !!kids && (expanded.has(n.id) || (q && hits.has(n.id) && depth < 8));
    rows.push({
      id: n.id, depth, name: n.name, sub: n.sub || '', t: n.t, tok: n.tok || 0, n: kids ? n.n : 1, turn: n.turn || 0,
      pct: parentTok > 0 ? (n.tok || 0) / parentTok : 1, kids: !!kids, open,
      mark: markState(n, marks), save: markedSave(n, marks),
      lock: kids ? '' : (n.lock || ''), warn: n.warn || '', stale: n.stale ? 1 : 0, err: n.err ? 1 : 0, latest: n.latest ? 1 : 0,
      deletable: actsUnder(n).length > 0,
    });
    if (open) for (const k of [...kids].sort(cmp)) visit(k, depth + 1, n.tok || 0);
  };
  // The root itself is not a row: its children are the top level.
  for (const k of [...(root.kids || [])].sort(cmp)) visit(k, 0, root.tok || 0);
  return rows;
}

// The window the pane shows: `count` rows that keep `sel` in view.
export function windowOf(rows, sel, count, top = 0) {
  const i = Math.max(0, rows.findIndex(r => r.id === sel));
  let t = Math.min(Math.max(0, top), Math.max(0, rows.length - count));
  if (i < t) t = i; else if (i >= t + count) t = i - count + 1;
  return { top: t, sel: i, rows: rows.slice(t, t + count) };
}

export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
