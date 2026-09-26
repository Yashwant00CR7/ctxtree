// The lever tree: nodes are things you can act on, not places bytes happen to sit.
const CAT_LABEL = {
  boot: 'boot overhead',
  tools: 'tool results',
  conversation: 'conversation',
  injected: 'injected content',
  subcontext: 'subagent contexts',
};
const CAT_ORDER = ['boot', 'tools', 'injected', 'conversation', 'subcontext'];

function node(name, key) {
  return { name, key, tok: 0, alloc: 0, n: 0, children: new Map(), exact: true, meta: {} };
}
function add(parent, name, key) {
  let c = parent.children.get(key);
  if (!c) { c = node(name, key); parent.children.set(key, c); }
  return c;
}
function bump(n, c) {
  n.tok += c.tok || 0; n.alloc += c.alloc || 0; n.n++;
  if (c.exact === false) n.exact = false;
}

// Build over any chunk set (all sessions, one session, or one region).
export function buildTree(chunkSets, { label = 'all context' } = {}) {
  const root = node(label, 'root');
  for (const chunks of chunkSets) {
    for (const c of chunks) {
      if (c.side) continue;
      const cat = c.cat || 'conversation';
      const catNode = add(root, CAT_LABEL[cat] || cat, cat);
      bump(root, c); bump(catNode, c);

      const subKey = c.sub || '(unclassified)';
      const subNode = add(catNode, subKey, subKey);
      bump(subNode, c);

      if (c.leaf) {
        const leafNode = add(subNode, c.leaf, c.leaf);
        bump(leafNode, c);
        if (c.n) leafNode.meta.tools = Math.max(leafNode.meta.tools || 0, c.n);
      }
      if (c.n && !c.leaf) subNode.meta.tools = Math.max(subNode.meta.tools || 0, c.n);
    }
  }
  return finish(root);
}

function finish(n, parentAlloc = null) {
  const kids = [...n.children.values()]
    .map(k => finish(k, n.alloc))
    .sort((a, b) => b.alloc - a.alloc);
  const order = (k) => CAT_ORDER.indexOf(k.key);
  if (n.key === 'root') kids.sort((a, b) => (order(a) - order(b)) || (b.alloc - a.alloc));
  return {
    name: n.name, key: n.key, tok: n.tok, alloc: n.alloc, n: n.n,
    exact: n.exact, meta: n.meta,
    pct: parentAlloc ? (parentAlloc > 0 ? n.alloc / parentAlloc : 0) : 1,
    children: kids,
  };
}

// Right-hand panel: for a selected node, which projects it actually lands in.
export function projectBreakdown(model, pred) {
  const by = new Map();
  for (const s of model.sessions) {
    const v = model.byId.get(s.sid);
    let tok = 0, alloc = 0, n = 0;
    for (const c of v.chunks) {
      if (c.side || !pred(c)) continue;
      tok += c.tok || 0; alloc += c.alloc || 0; n++;
    }
    if (!alloc && !tok) continue;
    const cur = by.get(s.project) || { project: s.project, name: s.projectName, tok: 0, alloc: 0, n: 0, sessions: 0 };
    cur.tok += tok; cur.alloc += alloc; cur.n += n; cur.sessions++;
    by.set(s.project, cur);
  }
  const rows = [...by.values()].sort((a, b) => b.alloc - a.alloc);
  const total = rows.reduce((a, r) => a + r.alloc, 0) || 1;
  for (const r of rows) r.pct = r.alloc / total;
  return rows;
}
