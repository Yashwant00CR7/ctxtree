// ctxtree: WizTree for the context window.
// One session at a time: a tree, a type list and a cushion treemap over the
// exact context `claude --resume` sends. Mark what you no longer need, review,
// and ctxtree writes a verified fork; the original session is never touched.
(() => {
  'use strict';

  // ------------------------------------------------------------ plumbing
  const TOKEN = (document.querySelector('meta[name="ctxtree-token"]') || {}).content || '';
  async function api(path, body) {
    const init = { headers: { 'X-Ctxtree-Token': TOKEN } };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(path, init);
    const isJson = (r.headers.get('content-type') || '').includes('json');
    const data = isJson ? await r.json() : { error: await r.text() };
    if (!r.ok) { const e = new Error(data.error || r.statusText); e.data = data; throw e; }
    return data;
  }
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  }
  const svg = (markup, cls = '') => {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${markup}</svg>`;
    return t.content.firstChild;
  };
  const ICON = {
    chev: '<path d="M5 3l5 5-5 5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
  };
  const fmt = (n) => {
    n = Math.round(n || 0);
    const a = Math.abs(n);
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(n);
  };
  const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(a / b >= 0.995 ? 0 : 1)}%` : '');
  const ago = (ts) => {
    const s = (Date.now() - new Date(ts).getTime()) / 1000;
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`ctxtree.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`ctxtree.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let toastT = 0;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 2600);
  }

  // ------------------------------------------------------------- colours
  // Fixed hues for the setup and conversation families; tool results take
  // vivid colours in order of size, like WizTree does for extensions.
  const FIXED = {
    sys: '#7b879c', tools: '#5a8cf0', mcp: '#8f6ef2', skill: '#c56fdc', agent: '#4bb4dc', md: '#38bfa3',
    prompt: '#e2b04c', reply: '#d98a5a', call: '#a98a62', image: '#e47b9c', attach: '#69717f', task: '#55606f',
  };
  const VIVID = ['#f0664d', '#4cb86e', '#3fa4f2', '#e9c440', '#ee5fa7', '#9fcd3e', '#ff9b45', '#2cc6d8', '#b07cf7', '#f3807a', '#6fd3a8', '#d6a35a'];
  const LABEL = {
    sys: 'System prompt', tools: 'Built-in tools', mcp: 'MCP servers', skill: 'Skills', agent: 'Agents',
    md: 'CLAUDE.md & memory', prompt: 'Your messages', reply: 'Claude’s replies', call: 'Tool calls',
    image: 'Images', attach: 'Attachments',
  };
  const prettyTool = (n) => (n.startsWith('mcp__') ? n.slice(5).split('__').join(' › ') : n);
  const typeLabel = (t) => LABEL[t] || (t.startsWith('r:') ? `${prettyTool(t.slice(2))} results` : t);
  const colors = new Map();
  const colorOf = (t) => colors.get(t) || FIXED[t] || '#59606b';
  const rgbCache = new Map();
  function rgb(hex) {
    let v = rgbCache.get(hex);
    if (!v) { const n = parseInt(hex.slice(1), 16); v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; rgbCache.set(hex, v); }
    return v;
  }

  // --------------------------------------------------------------- state
  const S = {
    sessions: [], sid: null, map: null, roots: [],
    byId: new Map(), parent: new Map(),
    open: new Set(), sel: null, marks: new Set(),
    ops: { uncompact: false, slim: false, switchTip: '' },
    undo: [], typeHi: null,
    view: store.get('view', 'tasks'),
    sorts: { tasks: store.get('sort.tasks', { key: 'turn', dir: 1 }), types: store.get('sort.types', { key: 'tok', dir: -1 }) },
    rows: [], forks: [], actByKey: new Map(),
    tab: store.get('sideTab', 'details'),
    // a task's acts (task key -> every key in it) and the task each key sits in
    taskKeys: new Map(), keyTask: new Map(),
    env: { vtower: false }, version: 0, changed: false,
  };
  Object.defineProperty(S, 'sort', { get: () => S.sorts[S.view], set: (v) => { S.sorts[S.view] = v; store.set(`sort.${S.view}`, v); } });
  const curRoot = () => S.roots[0];
  const isGrey = (n) => { while (n) { if (n.id === 'grey') return true; n = S.parent.get(n.id); } return false; };
  const rootOf = (n) => { while (S.parent.get(n.id)) n = S.parent.get(n.id); return n; };
  const ancestors = (n) => { const a = []; let p = S.parent.get(n.id); while (p) { a.push(p); p = S.parent.get(p.id); } return a; };
  // A leaf carries one or more actions (a task item is a call and its result).
  // Marks are kept per action, so both views share them.
  const akey = (a) => (a.k === 'boot' ? `boot:${a.id}` : a.id);
  const actsOf = (n) => n.acts || [];
  const canDelete = (n) => actsOf(n).length > 0;
  const isMarked = (n) => canDelete(n) && actsOf(n).every(a => S.marks.has(akey(a)));
  const saveOf = (n) => actsOf(n).reduce((t, a) => t + (a.save || 0), 0);
  const markedSave = (n) => actsOf(n).reduce((t, a) => t + (S.marks.has(akey(a)) ? a.save || 0 : 0), 0);
  const isTask = (n) => n.t === 'task';
  const isToolOutput = (n) => !n.kids && (n.t.startsWith('r:') || n.t === 'call');

  function index() {
    S.byId.clear(); S.parent.clear();
    const walk = (n, p) => {
      S.byId.set(n.id, n);
      if (p) S.parent.set(n.id, p);
      for (const k of n.kids || []) walk(k, n);
    };
    for (const r of S.roots) walk(r, null);
    // colours: result types by size
    colors.clear();
    const res = new Map();
    const each = (n) => { if (n.kids) n.kids.forEach(each); else if (n.t.startsWith('r:')) res.set(n.t, (res.get(n.t) || 0) + n.tok); };
    S.roots.forEach(each);
    [...res.entries()].sort((a, b) => b[1] - a[1]).forEach(([t], i) => colors.set(t, VIVID[i % VIVID.length]));
  }

  // Marked totals per node, recomputed whenever marks change (O(n), cheap).
  function recount() {
    const walk = (n) => {
      if (!n.kids) {
        n._d = canDelete(n) ? 1 : 0; n._dt = saveOf(n);
        n._m = isMarked(n) ? 1 : 0; n._mt = markedSave(n); n._mk = n._mt > 0 || n._m ? 1 : 0;
        return;
      }
      n._d = 0; n._dt = 0; n._m = 0; n._mt = 0; n._mk = 0;
      for (const k of n.kids) { walk(k); n._d += k._d; n._dt += k._dt; n._m += k._m; n._mt += k._mt; n._mk += k._mk; }
    };
    S.roots.forEach(walk);
  }
  const deletableLeaves = (n, out = []) => {
    if (!n.kids) { if (canDelete(n)) out.push(n); return out; }
    for (const k of n.kids) deletableLeaves(k, out);
    return out;
  };

  // ------------------------------------------------------------- marking
  function snapshot() {
    S.undo.push({ marks: new Set(S.marks), ops: { ...S.ops } });
    if (S.undo.length > 100) S.undo.shift();
  }
  // Your messages and Claude's last words go only with their whole task: marking
  // one marks the task, and keeping any part of a marked task keeps the task.
  function setMarks(leaves, on) {
    snapshot();
    for (const l of leaves) for (const a of actsOf(l)) {
      const k = akey(a);
      if (on) {
        S.marks.add(k);
        if (a.task) for (const x of S.taskKeys.get(a.task) || []) S.marks.add(x);
      } else if (a.task) {
        for (const x of S.taskKeys.get(a.task) || []) S.marks.delete(x);
      } else {
        S.marks.delete(k);
        const t = S.keyTask.get(k);
        if (t) S.marks.delete(t);
      }
    }
    changed();
  }
  function toggleNode(n) {
    if (isGrey(n)) { openMenuFor(n); return; }
    const leaves = deletableLeaves(n);
    if (!S.parent.get(n.id)) { openMenuFor(n); return; }
    if (!leaves.length) { toast(n.lock || 'Nothing here can be deleted.', true); return; }
    const allOn = leaves.every(isMarked);
    setMarks(leaves, !allOn);
  }
  function setOp(op, value) {
    snapshot();
    if (op === 'switch') S.ops.switchTip = value ? value : '';
    else S.ops[op] = !!value;
    changed();
  }
  function undo() {
    const u = S.undo.pop();
    if (!u) return;
    S.marks = u.marks; S.ops = u.ops;
    changed();
  }
  const opCount = () => (S.ops.uncompact ? 1 : 0) + (S.ops.slim ? 1 : 0) + (S.ops.switchTip ? 1 : 0);
  function changed() {
    recount();
    renderTree(); renderTypes(); renderOverlay(); renderMeter(); renderStatus(); renderDetails();
    if (!$('#drawer').classList.contains('hidden') && drawerMode === 'review') renderReview();
  }

  // ------------------------------------------------------------ sessions
  async function loadSessions() {
    S.sessions = await api('/api/sessions');
    S.sessions.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
    try { S.forks = await api('/api/forks'); } catch { S.forks = []; }
    $('#forks-count').textContent = S.forks.length ? String(S.forks.length) : '';
  }
  const forkOf = (sid) => S.forks.find(f => f.forkSid === sid);
  // A fork reads best under its parent's first prompt (slimming may drop it).
  function titleOf(s, depth = 0) {
    if (!s) return '';
    const f = forkOf(s.sid);
    const p = f && depth < 8 && S.sessions.find(x => x.sid === f.parentSid);
    return (p && titleOf(p, depth + 1)) || s.title || '';
  }

  // `reload`: the same session read again (it grew): marks, selection and the
  // open folders stay where they were.
  async function openSession(sid, { keepMarks = false, reload = false } = {}) {
    if (!sid) return;
    if (!keepMarks && S.sid && sid !== S.sid && (S.marks.size || opCount())) {
      if (!confirm('Switch session? Your marked deletions in this one will be cleared.')) return;
    }
    const keep = reload && sid === S.sid;
    S.sid = sid;
    history.replaceState(null, '', `#${sid}`);
    const s = S.sessions.find(x => x.sid === sid);
    $('#session-title').textContent = titleOf(s) || sid.slice(0, 8);
    $('#session-meta').textContent = s ? `${s.projectName} · ${ago(s.lastTs)}${forkOf(sid) ? ' · fork' : ''}` : '';
    if (!keep) $('#tree-spacer').replaceChildren(h('div', { class: 'loading', text: 'Reading session…' }));
    let map;
    try { map = await api(`/api/map?sid=${encodeURIComponent(sid)}`); } catch (e) { toast(e.message, true); return; }
    if (S.sid !== sid) return;
    S.map = map;
    S.actByKey = new Map();
    const collect = (n) => { if (n.kids) return n.kids.forEach(collect); for (const a of actsOf(n)) S.actByKey.set(akey(a), a); };
    collect(map.tree); collect(map.tasks);
    S.taskKeys = new Map(); S.keyTask = new Map();
    const tasksOf = (n) => {
      if (!n.kids) return;
      if (n.t === 'task') {
        const keys = new Set();
        const each = (x) => { if (x.kids) return x.kids.forEach(each); for (const a of actsOf(x)) if (a.k === 'drop') keys.add(akey(a)); };
        each(n);
        const tk = `task:${n.id}`;
        if (keys.has(tk)) { S.taskKeys.set(tk, keys); for (const k of keys) if (k !== tk) S.keyTask.set(k, tk); }
        return;
      }
      n.kids.forEach(tasksOf);
    };
    tasksOf(map.tasks);
    if (!keep) { S.marks = new Set(); S.ops = { uncompact: false, slim: false, switchTip: '' }; S.undo = []; }
    else S.marks = new Set([...S.marks].filter(k => S.actByKey.has(k)));
    timelines.clear(); blocks.clear();
    if (!keep) { tlOpen.clear(); showView(S.view); return; }
    const open = S.open, sel = S.sel, top = $('#tree').scrollTop;
    showView(S.view);
    S.open = new Set([...open].filter(id => S.byId.has(id)));
    $('#tree').scrollTop = top;
    if (S.byId.has(sel)) select(sel, { scroll: false }); else changed();
  }

  // Two views of the same context. Marks are per action, so they carry over.
  function showView(view) {
    S.view = view;
    store.set('view', view);
    document.querySelectorAll('#view-seg button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    if (!S.map) return;
    const main = view === 'tasks' ? S.map.tasks : S.map.tree;
    S.roots = [main, ...(S.map.grey && S.map.grey.kids && S.map.grey.kids.length ? [S.map.grey] : [])];
    index();
    S.typeHi = null;
    S.open = new Set(['root']);
    if (view === 'types') for (const k of main.kids || []) S.open.add(k.id);
    S.sel = 'root';
    S.mapRoot = main;
    $('#tree').scrollTop = 0;
    recount();
    layoutMap();
    changed();
  }

  // ---------------------------------------------------------------- meter
  function renderMeter() {
    const m = S.map;
    if (!m) return;
    const win = m.window, now = curRoot().tok, cut = curRoot()._mt || 0, after = now - cut;
    $('#meter-now').textContent = `${fmt(now)} tokens`;
    $('#meter-after').textContent = cut ? `→ ${fmt(after)}` : '';
    $('#meter-of').textContent = `of ${fmt(win)} · ${pct(after, win)}`;
    $('#meter-keep').style.width = `${Math.min(100, (100 * after) / win)}%`;
    $('#meter-cut').style.width = `${Math.min(100 - Math.min(100, (100 * after) / win), (100 * cut) / win)}%`;
    $('#meter').classList.toggle('over', after / win > 0.8);
  }

  // ----------------------------------------------------------------- tree
  const ROW = 26;
  function sortedKids(n) {
    const { key, dir } = S.sort;
    const k = [...n.kids];
    if (key === 'name') k.sort((a, b) => dir * a.name.localeCompare(b.name));
    else if (key === 'n') k.sort((a, b) => dir * (((a.kids ? a.n : 1) - (b.kids ? b.n : 1)) || (a.tok - b.tok)));
    else if (key === 'turn') k.sort((a, b) => dir * ((a.ord != null && b.ord != null) ? a.ord - b.ord : (((a.turn || 0) - (b.turn || 0)) || (a.tok - b.tok))));
    else k.sort((a, b) => dir * (a.tok - b.tok));
    return k;
  }
  function flatten() {
    const rows = [];
    const walk = (n, d) => {
      rows.push({ n, d });
      if (n.kids && S.open.has(n.id)) for (const k of sortedKids(n)) walk(k, d + 1);
    };
    for (const r of S.roots) walk(r, 0);
    S.rows = rows;
  }
  function renderTree() {
    if (!S.map) return;
    flatten();
    const body = $('#tree'), spacer = $('#tree-spacer');
    spacer.style.height = `${S.rows.length * ROW}px`;
    const top = body.scrollTop, hgt = body.clientHeight || 400;
    const a = Math.max(0, Math.floor(top / ROW) - 8), b = Math.min(S.rows.length, Math.ceil((top + hgt) / ROW) + 8);
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) frag.append(rowEl(S.rows[i], i));
    spacer.replaceChildren(frag);
    fitTree();
    document.querySelectorAll('#thead .th').forEach(th => {
      const on = th.dataset.sort === S.sort.key && !(th.classList.contains('c-pct'));
      th.classList.toggle('sorted', on);
      th.classList.toggle('asc', on && S.sort.dir === 1);
    });
  }
  function rowEl({ n, d }, i) {
    const grey = isGrey(n);
    const group = !!n.kids;
    const marked = !group ? isMarked(n) : (n._d > 0 && n._m === n._d);
    const parent = S.parent.get(n.id);
    const cls = ['row', group && 'group', !parent && 'root', n.id === S.sel && 'sel', marked && 'marked', grey && 'greyrow'].filter(Boolean).join(' ');
    const row = h('div', { class: cls, style: `top:${i * ROW}px`, 'data-id': n.id, role: 'treeitem', 'aria-level': String(d + 1) });

    const name = h('div', { class: 'c-name', style: `padding-left:${8 + d * 16}px` });
    if (group) {
      const chev = h('span', { class: `chev${S.open.has(n.id) ? ' open' : ''}`, 'data-chev': '1' });
      chev.append(svg(ICON.chev));
      name.append(chev);
    } else name.append(h('span', { class: 'chev' }));
    if (parent) name.append(h('span', { class: 'sw', style: `background:${colorOf(n.t)}` }));
    name.append(h('span', { class: 'nm', text: n.name, title: n.name }));
    if (n.err) name.append(h('span', { class: 'err', text: 'error' }));
    if (n.sub && !/^turn \d+$/.test(n.sub)) name.append(h('span', { class: 'sub', text: n.sub }));
    if (isTask(n) && n.ts) name.append(h('span', { class: 'sub keep', text: taskSub(n) }));
    if (n.latest) name.append(h('span', { class: 'tag', text: 'latest' }));
    if (!group && n.stale && !marked) name.append(h('span', { class: 'tag old', text: 'out of date', title: n.stale }));
    if (!group && !canDelete(n) && !grey) name.append(svg(ICON.lock, 'lockic'));
    if (group && n._m && n._m < n._d) name.append(h('span', { class: 'sub', style: 'color:var(--danger)', text: `${n._m} of ${n._d} marked` }));
    if (n.ops && opsOn(n)) name.append(h('span', { class: 'sub', style: 'color:var(--danger)', text: opsOn(n) }));

    const base = parent ? parent.tok : (n.id === 'root' ? S.map.window : 0);
    const p = base ? n.tok / base : 0;
    const pctCell = h('div', { class: 'c-pct' });
    if (base) {
      const bar = h('div', { class: 'pbar' }, h('i', { style: `width:${Math.min(100, p * 100)}%` }));
      if (n._mt && n.tok) bar.append(h('b', { style: `left:${Math.min(100, p * 100) * (1 - n._mt / n.tok)}%;width:${Math.min(100, p * 100) * (n._mt / n.tok)}%` }));
      pctCell.append(h('div', { class: 'pct' }, bar, h('span', { text: pct(n.tok, base) })));
    }
    const tok = h('div', { class: 'c-tok' });
    if (group && n._mt && n._m < n._d) tok.append(h('span', { class: 'minus', text: `−${fmt(n._mt)}` }));
    tok.append(fmt(n.tok));
    row.append(name, pctCell, tok,
      h('div', { class: 'c-n', text: group ? n.n.toLocaleString() : '' }),
      h('div', { class: 'c-turn', text: isTask(n) && n.from != null && n.from !== n.turn ? `${n.from}–${n.turn}` : (n.turn ? String(n.turn) : (group ? '' : '—')) }),
      h('div', { class: 'c-x' }, parent && !grey && (group ? n._d > 0 : canDelete(n))
        ? h('button', { class: 'x-mark', 'data-x': '1', title: marked ? 'Keep (⌫)' : 'Mark for deletion (⌫)', 'aria-label': marked ? 'Keep' : 'Mark for deletion', text: marked ? '↺' : '✕' }) : null));
    return row;
  }
  function taskSub(n) {
    const bits = [ago(n.ts)];
    if (!n.latest && n.ownFiles && !n.lastRef) bits.push('not mentioned since');
    return bits.join(' · ');
  }
  function opsOn(n) {
    if (!n.ops) return '';
    const on = n.ops.filter(o => (o.op === 'switch' ? S.ops.switchTip === o.tip : S.ops[o.op]));
    return on.length ? on.map(o => (o.op === 'slim' ? 'remove from file' : o.op === 'switch' ? 'switch here' : 'restore')).join(' · ') : '';
  }

  function select(id, { reveal = true, scroll = true, fromMap = false } = {}) {
    const n = S.byId.get(id);
    if (!n) return;
    S.sel = id;
    if (reveal) for (const a of ancestors(n)) S.open.add(a.id);
    const r = rootOf(n);
    if (r !== S.mapRoot) { S.mapRoot = r; layoutMap(); }
    renderTree();
    if (scroll) {
      const i = S.rows.findIndex(x => x.n.id === id);
      const body = $('#tree');
      if (i >= 0) {
        const y = i * ROW;
        if (y < body.scrollTop + ROW || y > body.scrollTop + body.clientHeight - 2 * ROW) body.scrollTop = Math.max(0, y - body.clientHeight / 2);
        renderTree();
      }
    }
    if (!fromMap) S.hover = null;
    renderOverlay(); renderStatus(); renderDetails(); renderPath();
  }
  function toggleOpen(n, open) {
    if (!n.kids) return;
    const want = open == null ? !S.open.has(n.id) : open;
    if (want) S.open.add(n.id); else S.open.delete(n.id);
    renderTree();
  }

  function treeEvents() {
    const body = $('#tree');
    let raf = 0;
    body.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderTree); });
    body.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      const n = S.byId.get(row.dataset.id);
      if (e.target.closest('[data-chev]')) { toggleOpen(n); e.preventDefault(); return; }
      if (e.target.closest('[data-x]')) { select(n.id, { scroll: false }); toggleNode(n); e.preventDefault(); return; }
      select(n.id, { scroll: false });
    });
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row');
      if (row) toggleOpen(S.byId.get(row.dataset.id));
    });
    body.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      e.preventDefault();
      const n = S.byId.get(row.dataset.id);
      select(n.id, { scroll: false });
      openMenu(n, e.clientX, e.clientY);
    });
    body.addEventListener('keydown', (e) => {
      if (!S.rows.length) return;
      const i = Math.max(0, S.rows.findIndex(r => r.n.id === S.sel));
      const n = S.rows[i].n;
      const go = (j) => { j = Math.max(0, Math.min(S.rows.length - 1, j)); select(S.rows[j].n.id); };
      switch (e.key) {
        case 'ArrowDown': go(i + 1); break;
        case 'ArrowUp': go(i - 1); break;
        case 'PageDown': go(i + Math.floor(body.clientHeight / ROW)); break;
        case 'PageUp': go(i - Math.floor(body.clientHeight / ROW)); break;
        case 'Home': go(0); break;
        case 'End': go(S.rows.length - 1); break;
        case 'ArrowRight': if (n.kids && !S.open.has(n.id)) toggleOpen(n, true); else go(i + 1); break;
        case 'ArrowLeft': if (n.kids && S.open.has(n.id)) toggleOpen(n, false); else { const p = S.parent.get(n.id); if (p) select(p.id); } break;
        case 'Enter': case ' ': toggleOpen(n); break;
        case 'Delete': case 'Backspace': toggleNode(n); break;
        case 'ContextMenu': {
          const el = body.querySelector(`.row[data-id="${CSS.escape(n.id)}"]`);
          const r = el ? el.getBoundingClientRect() : { left: 100, bottom: 100 };
          openMenu(n, r.left + 40, r.bottom);
          break;
        }
        default: return;
      }
      e.preventDefault();
    });
    document.querySelectorAll('#thead .th').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
      renderTree();
    }));
  }

  // ---------------------------------------------------------------- types
  function typeRows() {
    const by = new Map();
    const each = (n) => {
      if (n.kids) { n.kids.forEach(each); return; }
      const r = by.get(n.t) || { t: n.t, tok: 0, n: 0, d: 0, m: 0, mt: 0 };
      r.tok += n.tok; r.n++; if (canDelete(n)) r.d++; const ms = markedSave(n); if (ms) { r.m++; r.mt += ms; }
      by.set(n.t, r);
    };
    each(S.mapRoot || S.map.tree);
    return [...by.values()].sort((a, b) => b.tok - a.tok);
  }
  function renderTypes() {
    if (!S.map) return;
    const rows = typeRows();
    const total = rows.reduce((a, r) => a + r.tok, 0);
    const body = $('#types');
    body.replaceChildren(...rows.map(r => {
      const el = h('div', { class: `trow${S.typeHi === r.t ? ' on' : ''}${S.typeHi && S.typeHi !== r.t ? ' dim' : ''}`, 'data-t': r.t, title: 'Click to highlight in the map · right-click to delete' },
        h('div', { class: 'c-type' }, h('span', { class: 'sw', style: `background:${colorOf(r.t)}` }), h('span', { class: 'nm', text: typeLabel(r.t) }),
          r.m ? h('span', { class: 'sub', style: 'color:var(--danger)', text: `−${fmt(r.mt)}` }) : null),
        h('div', { class: 'c-pct' }, h('div', { class: 'pct' }, h('div', { class: 'pbar' }, h('i', { style: `width:${total ? (100 * r.tok) / total : 0}%` })), h('span', { text: pct(r.tok, total) }))),
        h('div', { class: 'c-tok num', text: fmt(r.tok) }),
        h('div', { class: 'c-n num', text: r.n.toLocaleString() }));
      return el;
    }));
  }
  function typeEvents() {
    const body = $('#types');
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      S.typeHi = S.typeHi === row.dataset.t ? null : row.dataset.t;
      renderTypes(); renderOverlay();
    });
    body.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      e.preventDefault();
      const t = row.dataset.t;
      const leaves = [];
      const each = (n) => { if (n.kids) n.kids.forEach(each); else if (n.t === t && canDelete(n)) leaves.push(n); };
      each(S.mapRoot || S.map.tree);
      openListMenu(typeLabel(t), leaves, e.clientX, e.clientY, { lock: 'Nothing of this type can be deleted.' });
    });
  }

  // ---------------------------------------------------------------- menus
  let menuItems = [], menuKb = -1;
  function closeMenu() { $('#menu').classList.add('hidden'); menuItems = []; menuKb = -1; }
  function showMenu(children, x, y) {
    const m = $('#menu');
    m.replaceChildren(...children);
    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
    m.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
    menuItems = [...m.querySelectorAll('.mi:not(:disabled), .chip')];
    menuKb = -1;
  }
  const mi = (label, right, onclick, { danger = false, disabled = false, check = null, note = '', title = '' } = {}) => {
    const b = h('button', { class: `mi${danger ? ' danger' : ''}`, disabled, title: title || null, role: 'menuitem' });
    if (check !== null) b.append(h('span', { class: 'check' }, check ? svg(ICON.check) : ''));
    const l = h('span', { class: 'ml', text: label });
    if (note) l.append(h('span', { class: 'mnote', text: note }));
    b.append(l);
    if (right) b.append(h('span', { class: 'mr', text: right }));
    if (onclick) b.addEventListener('click', () => { closeMenu(); onclick(); });
    return b;
  };
  const mh = (t) => h('div', { class: 'mh', text: t });
  const msep = () => h('div', { class: 'msep' });

  // Size thresholds and "keep the latest" for any set of deletable leaves.
  function bulkItems(leaves) {
    const out = [];
    if (leaves.length >= 3) {
      const chips = [];
      for (const th of [1000, 2500, 5000, 10000, 25000, 50000]) {
        const big = leaves.filter(l => l.tok >= th && !isMarked(l));
        const allBig = leaves.filter(l => l.tok >= th);
        if (!big.length || allBig.length === leaves.length) continue;
        chips.push(h('button', { class: 'chip', title: `Delete the ${big.length} item(s) of at least ${fmt(th)} tokens` , onclick: () => { closeMenu(); setMarks(big, true); } }, `≥ ${fmt(th)} · ${big.length}`));
      }
      if (chips.length) out.push(mh('Delete only the larger ones'), h('div', { class: 'mchips' }, chips));
    }
    const stale = leaves.filter(l => l.stale && !isMarked(l));
    if (stale.length) out.push(mi('Delete out-of-date copies', `−${fmt(stale.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(stale, true), { danger: true, note: `${stale.length} item(s) a later turn replaced: the file was read again or changed, or the command ran again` }));
    return out;
  }

  function openListMenu(title, leaves, x, y, { lock = '' } = {}) {
    const items = [mh(title)];
    const off = leaves.filter(l => !isMarked(l)), on = leaves.filter(isMarked);
    if (!leaves.length) items.push(mi(lock || 'Nothing here can be deleted', '', null, { disabled: true }));
    if (off.length) items.push(mi(leaves.length === 1 ? 'Delete' : `Delete all ${leaves.length}`, `−${fmt(off.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(off, true), { danger: true }));
    if (on.length) items.push(mi(on.length === 1 ? 'Keep' : `Keep all ${on.length}`, `+${fmt(on.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(on, false)));
    items.push(...bulkItems(leaves));
    showMenu(items, x, y);
  }

  function openMenuFor(n) {
    const el = document.querySelector(`.row[data-id="${CSS.escape(n.id)}"]`);
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 3, bottom: innerHeight / 3 };
    openMenu(n, r.left + 60, r.bottom);
  }

  function openMenu(n, x, y) {
    const items = [];
    if (isGrey(n)) {
      const g = n.ops ? n : ancestors(n).find(a => a.ops);
      items.push(mh(g ? g.name : n.name));
      if (!g) items.push(mi('Pick one of the groups inside to act on it', '', null, { disabled: true }));
      else for (const o of g.ops) {
        const on = o.op === 'switch' ? S.ops.switchTip === o.tip : S.ops[o.op];
        items.push(mi(o.label, '', () => setOp(o.op, on ? false : (o.op === 'switch' ? o.tip : true)), { check: !!on, note: o.note }));
      }
      showMenu(items, x, y);
      return;
    }
    const leaves = deletableLeaves(n);
    if (!n.kids) {
      items.push(mh(n.name));
      if (canDelete(n)) {
        const on = isMarked(n);
        items.push(on ? mi('Keep', `+${fmt(saveOf(n))}`, () => setMarks([n], false)) : mi('Delete', `−${fmt(saveOf(n))}`, () => setMarks([n], true), { danger: true, note: n.stale || n.warn || '' }));
      } else items.push(mi('Can’t delete this', '', null, { disabled: true, note: n.lock || '' }));
    } else if (!S.parent.get(n.id)) {
      items.push(mh(n.name));
      if (S.view === 'tasks') items.push(...cleanupItems());
      else items.push(mi('Pick a part of the context to delete', '', null, { disabled: true, note: 'Right-click a group or an item; the whole context is never deleted at once.' }));
      const stale = leaves.filter(l => l.stale && !isMarked(l));
      if (stale.length) items.push(mi('Delete every out-of-date copy', `−${fmt(stale.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(stale, true), { danger: true, note: `${stale.length} item(s) a later turn replaced` }));
    } else if (isTask(n)) {
      items.push(mh(n.name));
      items.push(...taskItems(n));
    } else {
      items.push(mh(n.name));
      const off = leaves.filter(l => !isMarked(l)), on = leaves.filter(isMarked);
      if (!leaves.length) items.push(mi('Nothing here can be deleted', '', null, { disabled: true, note: firstLock(n) }));
      if (off.length) items.push(mi(leaves.length === 1 ? 'Delete' : `Delete all ${leaves.length}`, `−${fmt(off.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(off, true), { danger: true, note: leaves.length < countLeaves(n) ? `${countLeaves(n) - leaves.length} item(s) here can’t be deleted and stay` : '' }));
      if (on.length) items.push(mi(on.length === 1 ? 'Keep' : `Keep all ${on.length}`, `+${fmt(on.reduce((a, l) => a + saveOf(l), 0))}`, () => setMarks(on, false)));
      items.push(...bulkItems(leaves));
    }
    // From the map you click a leaf; offer the groups above it too.
    const ups = ancestors(n).filter(a => S.parent.get(a.id) && deletableLeaves(a).length > (n.kids ? leaves.length : 1)).slice(0, 2);
    if (ups.length) {
      items.push(msep());
      for (const a of ups) {
        const al = deletableLeaves(a), off = al.filter(l => !isMarked(l));
        if (off.length) items.push(mi(`Delete all of “${a.name}”`, `−${fmt(off.reduce((s, l) => s + saveOf(l), 0))}`, () => setMarks(off, true), { danger: true }));
      }
    }
    items.push(msep(), mi('Copy name', '', () => navigator.clipboard && navigator.clipboard.writeText(n.name).then(() => toast('Copied'))));
    showMenu(items, x, y);
  }
  // A task: delete its tool steps (you keep what you asked and what Claude
  // answered), or all of it.
  function taskItems(n) {
    const all = deletableLeaves(n), tools = all.filter(isToolOutput);
    const off = (l) => l.filter(x => !isMarked(x)), tok = (l) => fmt(l.reduce((a, x) => a + saveOf(x), 0));
    const items = [];
    if (!all.length) return [mi('Nothing here can be deleted', '', null, { disabled: true, note: firstLock(n) })];
    if (off(tools).length) items.push(mi('Delete its tool steps', `−${tok(off(tools))}`, () => setMarks(off(tools), true), { danger: true, note: 'Every call and what came back: files read, commands run, code written. Keeps what you asked and what Claude answered.' }));
    if (off(all).length) items.push(mi('Delete the whole task', `−${tok(off(all))}`, () => setMarks(off(all), true), { danger: true, note: 'Your message, everything Claude did, and its replies. Nothing of it is left in the fork.' }));
    if (all.some(isMarked)) items.push(mi('Keep all of it', `+${tok(all.filter(isMarked))}`, () => setMarks(all, false)));
    const stale = off(all).filter(l => l.stale);
    if (stale.length && stale.length < off(all).length) items.push(mi('Delete only out-of-date copies', `−${tok(stale)}`, () => setMarks(stale, true), { danger: true, note: `${stale.length} item(s) a later turn replaced` }));
    return items;
  }
  // The whole session: delete the tool steps of every task but the latest few.
  function cleanupItems() {
    const tasks = curRoot().kids.filter(k => isTask(k) && k.id.startsWith('g:task:')).sort((a, b) => (a.ord || 0) - (b.ord || 0));
    const earlier = curRoot().kids.find(k => k.id === 'g:earlier');
    const out = [];
    const chips = [];
    for (const keep of [1, 2, 3, 5, 10]) {
      if (keep >= tasks.length) break;
      const old = [...(earlier ? [earlier] : []), ...tasks.slice(0, tasks.length - keep)];
      const leaves = old.flatMap(t => deletableLeaves(t)).filter(l => isToolOutput(l) && !isMarked(l));
      if (!leaves.length) continue;
      chips.push(h('button', { class: 'chip', title: `Delete the tool steps of every task except the latest ${keep}`, onclick: () => { closeMenu(); setMarks(leaves, true); } }, `keep last ${keep} · −${fmt(leaves.reduce((a, l) => a + saveOf(l), 0))}`));
    }
    if (chips.length) out.push(mh('Delete tool steps of older tasks'), h('div', { class: 'mchips' }, chips));
    else out.push(mi('Right-click a task to delete it', '', null, { disabled: true }));
    return out;
  }
  const countLeaves = (n) => (n.kids ? n.kids.reduce((a, k) => a + countLeaves(k), 0) : 1);
  const firstLock = (n) => { if (!n.kids) return n.lock || ''; for (const k of n.kids) { const l = firstLock(k); if (l) return l; } return ''; };

  // -------------------------------------------------------------- treemap
  // Squarified layout, nested with a label band for each group large enough to
  // carry one, shaded with van Wijk & van de Wetering cushions.
  const HEAD = 16, CUSH_H = 0.5, CUSH_F = 0.75;
  const LX = -0.09759, LY = -0.19518, LZ = 0.9759, IA = 0.22, IS = 0.82;
  let M = { leaves: [], heads: [], groups: [], w: 0, h: 0 };

  function worst(row, side) {
    let sum = 0, mx = 0, mn = Infinity;
    for (const r of row) { sum += r.a; if (r.a > mx) mx = r.a; if (r.a < mn) mn = r.a; }
    const s2 = side * side, q = sum * sum;
    return Math.max((s2 * mx) / q, q / (s2 * mn));
  }
  function squarify(items, x, y, w, h, out) {
    const total = items.reduce((a, i) => a + i.v, 0);
    if (!total || w <= 0 || h <= 0) return;
    const scale = (w * h) / total;
    let rest = items.map(i => ({ n: i.n, a: i.v * scale }));
    while (rest.length) {
      const side = Math.min(w, h);
      let row = [], best = Infinity;
      for (const it of rest) {
        const cand = row.concat(it);
        const wr = worst(cand, side);
        if (row.length && wr > best) break;
        row = cand; best = wr;
      }
      const area = row.reduce((a, r) => a + r.a, 0);
      if (w >= h) {
        const cw = area / h; let cy = y;
        for (const r of row) { const rh = r.a / cw; out.push({ n: r.n, x, y: cy, w: cw, h: rh }); cy += rh; }
        x += cw; w -= cw;
      } else {
        const rh = area / w; let cx = x;
        for (const r of row) { const rw = r.a / rh; out.push({ n: r.n, x: cx, y, w: rw, h: rh }); cx += rw; }
        y += rh; h -= rh;
      }
      rest = rest.slice(row.length);
    }
  }
  function ridge(s, x, y, w, h, hh) {
    const o = s.slice();
    if (w > 0) { o[0] += (4 * hh * (2 * x + w)) / w; o[2] -= (4 * hh) / w; }
    if (h > 0) { o[1] += (4 * hh * (2 * y + h)) / h; o[3] -= (4 * hh) / h; }
    return o;
  }
  function layoutNode(n, x, y, w, h, depth, s, out) {
    if (w < 0.5 || h < 0.5) return;
    const surf = ridge(s, x, y, w, h, CUSH_H * Math.pow(CUSH_F, depth));
    if (!n.kids || !n.kids.length) { out.leaves.push({ n, x, y, w, h, s: surf }); return; }
    out.groups.push({ n, x, y, w, h });
    let cy = y, ch = h;
    if (depth > 0 && w >= 46 && h >= HEAD * 2.2) { out.heads.push({ n, x, y, w, h: HEAD }); cy += HEAD; ch -= HEAD; }
    const items = n.kids.filter(k => k.tok > 0).sort((a, b) => b.tok - a.tok).map(k => ({ n: k, v: k.tok }));
    const rects = [];
    // a hairline between siblings of a group keeps structure readable
    const pad = depth > 0 && w > 8 && h > 8 ? 1 : 0;
    squarify(items, x + pad, cy + (pad && cy === y ? pad : 0), w - 2 * pad, ch - pad - (pad && cy === y ? pad : 0), rects);
    for (const r of rects) layoutNode(r.n, r.x, r.y, r.w, r.h, depth + 1, surf, out);
  }

  function layoutMap() {
    const wrap = $('#map-wrap');
    const w = wrap.clientWidth, hh = wrap.clientHeight;
    M = { leaves: [], heads: [], groups: [], w, h: hh };
    if (!S.mapRoot || w < 10 || hh < 10) return;
    layoutNode(S.mapRoot, 0, 0, w, hh, 0, [0, 0, 0, 0], M);
    paintMap();
    renderOverlay();
    renderPath();
  }

  function paintMap() {
    const c = $('#map'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(M.w * dpr), H = Math.round(M.h * dpr);
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (!W || !H) return;
    const img = ctx.createImageData(W, H), d = img.data;
    const bg = rgb(getComputedStyle(document.documentElement).getPropertyValue('--map-bg').trim() || '#0b0d10');
    for (let i = 0; i < d.length; i += 4) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255; }
    const grey = S.mapRoot && S.mapRoot.id === 'grey';
    for (const L of M.leaves) {
      let [r, g, b] = rgb(colorOf(L.n.t));
      if (grey) { const y = 0.3 * r + 0.59 * g + 0.11 * b; r = g = b = y * 0.75; }
      const x0 = Math.max(0, Math.round(L.x * dpr)), x1 = Math.min(W, Math.round((L.x + L.w) * dpr));
      const y0 = Math.max(0, Math.round(L.y * dpr)), y1 = Math.min(H, Math.round((L.y + L.h) * dpr));
      const s = L.s;
      for (let py = y0; py < y1; py++) {
        const yy = (py + 0.5) / dpr;
        const ny = -(2 * s[3] * yy + s[1]);
        let i = (py * W + x0) * 4;
        for (let px = x0; px < x1; px++, i += 4) {
          const xx = (px + 0.5) / dpr;
          const nx = -(2 * s[2] * xx + s[0]);
          const cos = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
          const I = IA + (cos > 0 ? IS * cos : 0);
          d[i] = r * I > 255 ? 255 : r * I; d[i + 1] = g * I > 255 ? 255 : g * I; d[i + 2] = b * I > 255 ? 255 : b * I;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.scale(dpr, dpr);
    // group label bands, WizTree style: "Tool results (135.9k)"
    const css = getComputedStyle(document.documentElement);
    ctx.font = `500 11px ${css.getPropertyValue('--font')}`;
    ctx.textBaseline = 'middle';
    for (const hd of M.heads) {
      ctx.fillStyle = css.getPropertyValue('--map-head').trim() || 'rgba(11,13,16,.86)';
      ctx.fillRect(hd.x, hd.y, hd.w, hd.h);
      ctx.fillStyle = css.getPropertyValue('--map-head-text').trim() || '#c9ced6';
      clipText(ctx, `${hd.n.name}  ${fmt(hd.n.tok)}`, hd.x + 5, hd.y + hd.h / 2 + 0.5, hd.w - 10);
    }
    // leaf labels where they fit
    ctx.font = `11px ${css.getPropertyValue('--font')}`;
    for (const L of M.leaves) {
      if (L.w < 64 || L.h < 22) continue;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      clipText(ctx, L.n.name, L.x + 6, L.y + 11.5, L.w - 12);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      clipText(ctx, L.n.name, L.x + 5, L.y + 11, L.w - 12);
      if (L.h >= 36) {
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        clipText(ctx, fmt(L.n.tok), L.x + 5, L.y + 25, L.w - 12);
      }
    }
  }
  function clipText(ctx, text, x, y, max) {
    if (max < 12) return;
    if (ctx.measureText(text).width <= max) { ctx.fillText(text, x, y); return; }
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1; }
    if (lo > 0) ctx.fillText(`${text.slice(0, lo)}…`, x, y);
  }

  let hatch = null;
  function hatchPattern(ctx) {
    if (hatch) return hatch;
    const p = document.createElement('canvas');
    p.width = p.height = 8;
    const g = p.getContext('2d');
    g.fillStyle = 'rgba(8,9,12,.62)'; g.fillRect(0, 0, 8, 8);
    g.strokeStyle = 'rgba(255,111,97,.75)'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    hatch = ctx.createPattern(p, 'repeat');
    return hatch;
  }
  function renderOverlay() {
    const c = $('#map-over'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(M.w * dpr), H = Math.round(M.h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; hatch = null; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(dpr, dpr);
    const grey = S.mapRoot && S.mapRoot.id === 'grey';
    if (S.typeHi) {
      ctx.fillStyle = 'rgba(8,9,12,.74)';
      for (const L of M.leaves) if (L.n.t !== S.typeHi) ctx.fillRect(L.x, L.y, L.w, L.h);
    }
    if (!grey && S.marks.size) {
      ctx.fillStyle = hatchPattern(ctx);
      for (const L of M.leaves) if (markedSave(L.n) || isMarked(L.n)) ctx.fillRect(L.x, L.y, L.w, L.h);
    }
    if (grey) {
      // a group whose op is on gets the same hatch
      for (const g of M.groups) if (g.n.ops && opsOn(g.n)) { ctx.fillStyle = hatchPattern(ctx); ctx.fillRect(g.x, g.y, g.w, g.h); }
    }
    const sel = S.byId.get(S.sel);
    if (sel && rootOf(sel) === S.mapRoot) {
      const r = sel.kids ? M.groups.find(g => g.n === sel) : M.leaves.find(l => l.n === sel);
      if (r && sel !== S.mapRoot) {
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 4;
        ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
      }
    }
    if (S.hover && S.hover.n !== sel) {
      const r = S.hover;
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }
  }
  function hit(x, y) {
    for (const hd of M.heads) if (x >= hd.x && x < hd.x + hd.w && y >= hd.y && y < hd.y + hd.h) return { ...M.groups.find(g => g.n === hd.n), head: true };
    for (const L of M.leaves) if (x >= L.x && x < L.x + L.w && y >= L.y && y < L.y + L.h) return L;
    return null;
  }
  // The ✕ in the corner of the block under the mouse marks it (or keeps it).
  const mapX = h('button', { class: 'map-x hidden', type: 'button' });
  function placeX(r) {
    if (!r || r.head || r.n.kids || !canDelete(r.n) || isGrey(r.n) || r.w < 30 || r.h < 24) { mapX.classList.add('hidden'); mapX._n = null; return; }
    const on = isMarked(r.n);
    mapX._n = r.n;
    mapX.textContent = on ? '↺' : '✕';
    mapX.title = on ? 'Keep (⌫)' : 'Mark for deletion (⌫)';
    mapX.setAttribute('aria-label', mapX.title);
    mapX.classList.toggle('on', on);
    mapX.style.left = `${r.x + r.w - 24}px`; mapX.style.top = `${r.y + 4}px`;
    mapX.classList.remove('hidden');
  }
  function mapEvents() {
    const c = $('#map-over'), tip = $('#tip'), wrap = $('#map-wrap');
    wrap.append(mapX);
    mapX.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    mapX.addEventListener('click', () => {
      const n = mapX._n;
      if (!n) return;
      select(n.id, { fromMap: true });
      toggleNode(n);
      placeX(S.hover);
    });
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      const r = hit(x, y);
      if (!r) { tip.classList.add('hidden'); placeX(null); if (S.hover) { S.hover = null; renderOverlay(); } return; }
      if (!S.hover || S.hover.n !== r.n) { S.hover = r; renderOverlay(); fillTip(r.n); placeX(r); }
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let tx = x + 14, ty = y + 16;
      if (tx + tw > wrap.clientWidth) tx = x - tw - 10;
      if (ty + th > wrap.clientHeight) ty = y - th - 10;
      tip.style.left = `${Math.max(0, tx)}px`; tip.style.top = `${Math.max(0, ty)}px`;
    });
    c.addEventListener('mouseleave', (e) => {
      tip.classList.add('hidden');
      if (e.relatedTarget === mapX) return;
      placeX(null); S.hover = null; renderOverlay();
    });
    mapX.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== c) { placeX(null); S.hover = null; renderOverlay(); } });
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = pos(e);
      const r = hit(x, y);
      if (r) select(r.n.id, { fromMap: true });
    });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e);
      const r = hit(x, y);
      if (r) { const p = r.n.kids ? r.n : S.parent.get(r.n.id); if (p) { S.open.add(p.id); select(r.n.id); } }
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const r = hit(x, y);
      tip.classList.add('hidden');
      if (!r) return;
      select(r.n.id, { fromMap: true });
      openMenu(r.n, e.clientX, e.clientY);
    });
  }
  function fillTip(n) {
    const tip = $('#tip');
    const path = ancestors(n).reverse().slice(1).map(a => a.name).join(' › ');
    const kids = [];
    if (path) kids.push(h('div', { class: 't-path', text: path }));
    kids.push(h('div', { class: 't-name', text: n.name }));
    const p = S.parent.get(n.id);
    kids.push(h('div', { class: 't-row' }, h('span', null, h('b', { text: fmt(n.tok) }), ' tokens'),
      p ? h('span', { text: `${pct(n.tok, p.tok)} of ${p.name}` }) : null,
      n.turn ? h('span', { text: `turn ${n.turn}` }) : null));
    if (n.kids) kids.push(h('div', { class: 't-row', text: `${n.n.toLocaleString()} items` }));
    if (isTask(n) && n.ts) kids.push(h('div', { class: 't-row', text: taskSub(n) }));
    if (isMarked(n)) kids.push(h('div', { class: 't-mark', text: 'Marked for deletion' }));
    else if (!n.kids && !canDelete(n)) kids.push(h('div', { class: 't-lock', text: n.lock || '' }));
    else if (n.stale) kids.push(h('div', { class: 't-lock', text: n.stale }));
    tip.replaceChildren(...kids);
  }
  function renderPath() {
    const el = $('#map-path');
    const n = S.byId.get(S.sel) || S.mapRoot;
    if (!n) { el.replaceChildren(); return; }
    const chain = [...ancestors(n).reverse(), n];
    const parts = [];
    chain.forEach((a, i) => {
      if (i) parts.push(h('span', { class: 'sep', text: '›' }));
      parts.push(h('span', { class: i === chain.length - 1 ? '' : 'crumb', text: a.name, onclick: i === chain.length - 1 ? null : () => select(a.id) }));
    });
    el.replaceChildren(...parts);
  }

  // --------------------------------------------------------------- status
  function renderStatus() {
    const n = S.byId.get(S.sel);
    const sel = $('#status-sel');
    if (n) {
      sel.replaceChildren(h('b', { text: n.name }), `  ${fmt(n.tok)} tokens`, n.kids ? ` · ${n.n.toLocaleString()} items` : '');
    } else sel.textContent = '';
    const cut = S.map ? curRoot()._mt || 0 : 0;
    const count = S.map ? curRoot()._mk || 0 : 0, ops = opCount();
    const parts = [];
    if (count) parts.push(`${count.toLocaleString()} marked · −${fmt(cut)} tokens`);
    if (ops) parts.push(`${ops} file change${ops > 1 ? 's' : ''}`);
    $('#status-marked').textContent = parts.join(' · ');
    const pill = $('#btn-reload');
    pill.classList.toggle('hidden', !S.changed);
    $('#btn-review').disabled = !(count || ops);
    $('#btn-undo').disabled = !S.undo.length;
  }

  // -------------------------------------------------------------- details
  function renderDetails() {
    const el = $('#details');
    const n = S.byId.get(S.sel);
    if (!n || !S.map) { el.replaceChildren(h('div', { class: 'empty', text: 'Select anything to see what it is.' })); return; }
    const kids = [];
    const p = S.parent.get(n.id);
    const kicker = isTask(n) ? [n.id === 'g:earlier' ? 'Earlier' : 'Task', n.from != null ? `turns ${n.from}–${n.turn}` : '', n.ts ? ago(n.ts) : ''].filter(Boolean).join(' · ')
      : (n.kids ? (p ? 'Group' : '') : typeLabel(n.t));
    kids.push(h('div', { class: 'd-kicker' }, p && !isTask(n) ? h('span', { class: 'sw', style: `background:${colorOf(n.t)}` }) : null, h('span', { text: kicker })));
    kids.push(h('div', { class: 'd-title', text: n.name }));
    const stats = [h('div', { class: 'd-stat' }, h('b', { text: fmt(n.tok) }), h('span', { text: 'tokens' }))];
    if (p) stats.push(h('div', { class: 'd-stat' }, h('b', { text: pct(n.tok, p.tok) }), h('span', { text: `of ${p.name}` })));
    if (n.kids) stats.push(h('div', { class: 'd-stat' }, h('b', { text: n.n.toLocaleString() }), h('span', { text: 'items' })));
    if (n.turn) stats.push(h('div', { class: 'd-stat' }, h('b', { text: String(n.turn) }), h('span', { text: n.kids ? 'last turn' : 'turn' })));
    if (n._mt) stats.push(h('div', { class: 'd-stat' }, h('b', { style: 'color:var(--danger)', text: `−${fmt(n._mt)}` }), h('span', { text: 'marked' })));
    kids.push(h('div', { class: 'd-stats' }, stats));
    if (n.id === 'root' && S.map) kids.push(h('p', { class: 'd-note', text: `What claude --resume sends for this session: ${pct(n.tok, S.map.window)} of a ${fmt(S.map.window)} window.${S.map.measured ? ` Claude Code last measured ${fmt(S.map.measured)}.` : ''}` }));
    if (isTask(n)) kids.push(...taskDetails(n));
    if (n.stale) kids.push(h('p', { class: 'd-warn', text: n.stale }));
    if (n.info) kids.push(h('p', { class: 'd-note', text: n.info }));
    if (n.warn) kids.push(h('p', { class: 'd-warn', text: n.warn }));
    if (n.profile) kids.push(h('p', { class: 'd-note', text: 'Needs a launch profile; ctxtree writes it and the resume command uses it.' }));
    if (!n.kids && !canDelete(n)) kids.push(h('p', { class: 'd-lock' }, svg(ICON.lock, 'lockic'), h('span', { text: n.lock || '' })));

    const acts = h('div', { class: 'd-actions' });
    if (isGrey(n)) {
      const g = n.ops ? n : ancestors(n).find(a => a.ops);
      if (g) for (const o of g.ops) {
        const on = o.op === 'switch' ? S.ops.switchTip === o.tip : S.ops[o.op];
        acts.append(h('button', { class: on ? 'primary' : 'secondary', title: o.note, text: on ? `✓ ${o.label}` : o.label, onclick: () => setOp(o.op, on ? false : (o.op === 'switch' ? o.tip : true)) }));
      }
    } else if (isTask(n)) {
      const all = deletableLeaves(n), tools = all.filter(isToolOutput);
      const toolsOn = tools.length && tools.every(isMarked), allOn = all.length && all.every(isMarked);
      const tok = (l) => fmt(l.reduce((a, x) => a + saveOf(x), 0));
      if (all.length > tools.length) acts.append(h('button', { class: allOn ? 'secondary' : 'primary danger', title: 'Your message, everything Claude did, and its replies. Nothing of it is left in the fork.',
        text: allOn ? 'Keep the task' : `Delete whole task  −${tok(all)}`, onclick: () => setMarks(all, !allOn) }));
      if (tools.length) acts.append(h('button', { class: 'secondary', title: 'Every call and what came back. Keeps what you asked and what Claude answered.',
        text: toolsOn ? 'Keep tool steps' : `Delete tool steps  −${tok(tools)}`, onclick: () => setMarks(tools, !toolsOn) }));
    } else if (S.parent.get(n.id)) {
      const leaves = deletableLeaves(n);
      if (leaves.length) {
        const all = leaves.every(isMarked);
        acts.append(h('button', { class: all ? 'secondary' : 'primary danger', text: all ? 'Keep' : (n.kids && leaves.length > 1 ? `Delete all ${leaves.length}` : 'Delete'), onclick: () => setMarks(leaves, !all) }));
      }
    }
    if (acts.childNodes.length) kids.push(acts);

    // what it actually says: a task item shows the call, then what came back
    const ids = n.kids ? [] : (n.blocks || [/^(b_|l_|d:)/.test(n.id) ? n.id : null].filter(Boolean));
    ids.forEach((id, i) => kids.push(...blockView(id, ids.length > 1 ? (i === 0 ? 'Claude sent' : 'It got back') : '')));
    if (isTask(n)) kids.push(...timelineView(n));
    // a redraw for the same selection (a mark, a load) keeps the reading position
    const top = shownSel === n.id ? el.scrollTop : 0;
    el.replaceChildren(...kids);
    el.scrollTop = top;
    shownSel = n.id;
  }
  let shownSel = null;

  // ------------------------------------------------------------- timeline
  // Block text as loaded: the first 20,000 characters, then all of it on
  // request. Kept per session so redraws (a mark, a tab switch) cost nothing.
  const blocks = new Map();
  function loadBlock(id, all = false) {
    const have = blocks.get(id);
    if (have && (have.loading || !all || !have.next)) return;
    blocks.set(id, { ...(have || { text: '' }), loading: true });
    const q = `/api/block?sid=${encodeURIComponent(S.sid)}&id=${encodeURIComponent(id)}${all ? `&offset=${have.next}&full=1` : ''}`;
    const sid = S.sid;
    api(q).then(b => {
      if (S.sid !== sid) return;
      blocks.set(id, { text: (all ? have.text : '') + (b.text || ''), chars: b.chars, next: b.next, isError: b.isError });
      renderDetails();
    }).catch(e => { blocks.set(id, { text: '', err: e.message, next: 0 }); renderDetails(); });
  }
  function blockView(id, label) {
    const out = [];
    if (label) out.push(h('div', { class: 'label', text: label }));
    const b = blocks.get(id);
    if (!b) loadBlock(id);
    out.push(h('pre', { class: 'd-pre', text: !b || (b.loading && !b.text) ? 'Loading…' : b.err || b.text || '(empty)' }));
    if (b && b.next) {
      out.push(h('div', { class: 'd-more' },
        h('span', { text: `Showing the first ${b.text.length.toLocaleString()} of ${b.chars.toLocaleString()} characters.` }),
        h('button', { text: b.loading ? 'Loading…' : `Show all ${b.chars.toLocaleString()}`, disabled: !!b.loading, onclick: () => loadBlock(id, true) })));
    }
    return out;
  }

  // A task, as it happened: your message, then every tool call and reply in
  // order. Messages show in full; a tool call opens in place to show what
  // Claude sent and what came back.
  const timelines = new Map();
  const tlOpen = new Set();
  function timelineView(n) {
    const key = n.id;
    const tl = timelines.get(key);
    if (!tl) {
      timelines.set(key, { loading: true });
      const sid = S.sid;
      api(`/api/timeline?sid=${encodeURIComponent(sid)}&id=${encodeURIComponent(n.id)}`)
        .then(r => { if (S.sid !== sid) return; timelines.set(key, { entries: r.entries }); if (S.sel === n.id) renderDetails(); })
        .catch(e => { timelines.set(key, { err: e.message }); if (S.sel === n.id) renderDetails(); });
    }
    if (!tl || tl.loading) return [h('div', { class: 'd-more', text: 'Loading the timeline…' })];
    if (tl.err) return [h('p', { class: 'd-warn', text: tl.err })];
    const tools = tl.entries.filter(e => e.kind === 'tool');
    const allOpen = tools.length && tools.every(e => tlOpen.has(e.id));
    const head = h('div', { class: 'd-more', style: 'margin:4px 0 8px' },
      h('span', { class: 'label', text: `What happened · ${tl.entries.length} item${tl.entries.length === 1 ? '' : 's'}, ${tools.length} tool call${tools.length === 1 ? '' : 's'}` }),
      tools.length ? h('button', { text: allOpen ? 'Collapse all' : 'Expand all', onclick: () => { for (const e of tools) { if (allOpen) tlOpen.delete(e.id); else tlOpen.add(e.id); } renderDetails(); } }) : null);
    return [head, h('div', { class: 'tl' }, tl.entries.map(timelineEntry))];
  }
  // (a run of attachments shown as one entry is marked as the run)
  function markButton(e) {
    const nodes = (e.ids || [e.id]).map(id => S.byId.get(id)).filter(n => n && canDelete(n));
    if (!nodes.length) return null;
    const on = nodes.every(isMarked);
    return h('button', { class: `tl-mark${on ? ' on' : ''}`, title: on ? 'Keep it' : (nodes[0].info || 'Mark for deletion'), text: on ? '✕ marked' : 'delete',
      onclick: (ev) => { ev.stopPropagation(); setMarks(nodes, !on); } });
  }
  function timelineEntry(e) {
    const node = S.byId.get(e.id);
    const marked = node && isMarked(node);
    if (e.kind === 'prompt' || e.kind === 'reply') {
      const b = blocks.get(e.id);
      const text = b && !b.loading && b.text ? b.text : e.text;
      const more = b ? b.next : (e.truncated ? 1 : 0);
      return h('div', { class: `tl-msg ${e.kind}${marked ? ' marked' : ''}` },
        h('div', { class: 'tl-who' }, h('b', { text: e.kind === 'prompt' ? (/^You: /.test(e.name) ? 'You' : e.name.split(':')[0]) : 'Claude' }),
          e.turn ? h('span', { text: `turn ${e.turn}` }) : null, h('span', { class: 'tl-tok', text: fmt(e.tok) }), markButton(e)),
        h('div', { class: 'tl-text', text: tidyMsg(text) || '(empty)' }),
        more ? h('div', { class: 'd-more' }, h('span', { text: `Showing the first ${text.length.toLocaleString()} of ${(b ? b.chars : e.chars).toLocaleString()} characters.` }),
          h('button', { text: b && b.loading ? 'Loading…' : 'Show all', onclick: () => { if (!b) { blocks.set(e.id, { text: e.text, chars: e.chars, next: e.text.length }); } loadBlock(e.id, true); } })) : null);
    }
    if (e.kind === 'tool') {
      const open = tlOpen.has(e.id);
      const body = open ? h('div', { class: 'tl-body' }, e.parts.flatMap(p => blockView(p.id, e.parts.length > 1 ? (p.role === 'sent' ? 'Claude sent' : 'It got back') : (p.role === 'sent' ? 'Claude sent (no result recorded)' : 'It got back')))) : null;
      return h('div', { class: `tl-tool${marked ? ' marked' : ''}` },
        h('div', { class: 'tl-head', title: e.name, onclick: () => { if (open) tlOpen.delete(e.id); else tlOpen.add(e.id); renderDetails(); } },
          h('span', { class: `chev${open ? ' open' : ''}` }, svg(ICON.chev)),
          h('span', { class: 'sw', style: `background:${colorOf(e.t)}` }),
          h('span', { class: 'tl-name', text: e.name }),
          e.err ? h('span', { class: 'tl-flag bad', text: 'error' }) : null,
          e.stale ? h('span', { class: 'tl-flag old', title: e.stale, text: 'out of date' }) : null,
          h('span', { class: 'tl-tok', text: fmt(e.tok) }), markButton(e)),
        body);
    }
    const all = (e.ids || [e.id]).map(id => S.byId.get(id)).filter(Boolean);
    return h('div', { class: `tl-other${all.length && all.every(isMarked) ? ' marked' : ''}` }, h('span', { text: `${e.name} · ${fmt(e.tok)}` }), markButton(e));
  }
  // Messages as you wrote them, without the XML wrappers Claude Code adds.
  const tidyMsg = (t) => String(t || '').replace(/<\/?(command-[a-z-]+|local-command-[a-z-]+|system-reminder)>/g, '').trim();

  // A task, explained: what you asked, how it ended, what it touched, and
  // whether anything since still leans on it.
  function taskDetails(n) {
    const out = [];
    if (n.files && n.files.length) out.push(h('div', { class: 'label', text: 'Files it touched' }),
      h('div', { class: 'd-files' }, n.files.map(f => h('span', { class: 'file', title: f, text: f.split('/').pop() }))));
    const signals = [];
    const stale = deletableLeaves(n).filter(l => l.stale);
    if (n.latest) signals.push(['ok', 'This is the task you’re on now.']);
    else if (n.lastRef) signals.push(['', `Its files came up again at turn ${n.lastRef}, so later work may lean on it.`]);
    else if (n.ownFiles) signals.push(['old', 'Nothing since has mentioned the files it worked on.']);
    if (stale.length) signals.push(['old', `${stale.length} item${stale.length > 1 ? 's are' : ' is'} out of date (re-read, re-run or changed later): −${fmt(stale.reduce((a, l) => a + saveOf(l), 0))} at no cost.`]);
    if (signals.length) out.push(h('ul', { class: 'd-signals' }, signals.map(([c, t]) => h('li', { class: c, text: t }))));
    return out;
  }

  // --------------------------------------------------------------- review
  let drawerMode = '', verifyReq = 0;
  function payload() {
    const edits = [], drop = [], boot = [];
    for (const key of S.marks) {
      const a = S.actByKey.get(key);
      if (!a) continue;
      if (a.k === 'drop') drop.push(a.id);
      else if (a.k === 'img') edits.push({ id: a.id, fp: a.fp, op: 'remove' });
      else if (a.k === 'boot') boot.push(a.id);
    }
    const structure = [];
    if (S.ops.switchTip) structure.push({ op: 'switch', tip: S.ops.switchTip });
    if (S.ops.uncompact) structure.push({ op: 'uncompact' });
    if (S.ops.slim) structure.push({ op: 'slim' });
    return { sid: S.sid, edits, drop, boot, structure };
  }
  function openDrawer(mode) {
    drawerMode = mode;
    $('#drawer').classList.remove('hidden');
    $('#scrim').classList.remove('hidden');
  }
  function closeDrawer() {
    drawerMode = '';
    $('#drawer').classList.add('hidden');
    $('#scrim').classList.add('hidden');
  }

  function openReview() {
    if (!S.marks.size && !opCount()) return;
    openDrawer('review');
    renderReview();
    verify();
  }
  let lastVerify = null;
  async function verify() {
    const req = ++verifyReq;
    lastVerify = { state: 'run' };
    paintVerify();
    try {
      const r = await api('/api/fork', { ...payload(), dryRun: true });
      if (req !== verifyReq) return;
      lastVerify = { state: 'ok', r };
    } catch (e) {
      if (req !== verifyReq) return;
      lastVerify = { state: 'bad', msg: e.message, problems: (e.data && e.data.problems) || [] };
    }
    paintVerify();
  }
  function paintVerify() {
    const el = document.getElementById('verify');
    if (!el || !lastVerify) return;
    const v = lastVerify;
    el.className = `verify ${v.state}`;
    const dot = h('span', { class: 'dot' });
    if (v.state === 'run') el.replaceChildren(dot, h('span', { text: 'Building the fork and checking it (nothing is written yet)…' }));
    else if (v.state === 'ok') {
      const { saved } = v.r.resume;
      el.replaceChildren(dot, h('span', { text: `Verified on a full build of the fork: every tool call still pairs with its result, the resumed chain is intact, and ${fmt(saved)} tokens come off.${v.r.bytes ? ` File ${fmtBytes(v.r.bytes.before)} → ${fmtBytes(v.r.bytes.after)}.` : ''}` }));
      const btn = document.getElementById('btn-commit');
      if (btn) btn.disabled = false;
    } else {
      el.replaceChildren(dot, h('div', null, h('div', { text: v.msg }), v.problems.length ? h('ul', null, v.problems.slice(0, 6).map(p => h('li', { text: p.error }))) : null));
    }
  }
  const fmtBytes = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

  function renderReview() {
    const dr = $('#drawer');
    const m = S.map;
    const now = curRoot().tok, cut = curRoot()._mt || 0, after = now - cut;
    const groups = new Map(), marked = [];
    const each = (n) => { if (n.kids) return n.kids.forEach(each); if (markedSave(n) || isMarked(n)) marked.push(n); };
    each(curRoot());
    for (const n of marked) {
      const top = ancestors(n).reverse()[1] || n;
      const g = groups.get(top.id) || { name: top.name, items: [], tok: 0 };
      g.items.push(n); g.tok += markedSave(n);
      groups.set(top.id, g);
    }
    const body = h('div', { class: 'dr-body' });
    body.append(h('div', { class: 'sum' },
      h('div', { class: 'sum-nums' }, h('span', { class: 'from', text: fmt(now) }), h('span', { class: 'arrow', text: '→' }), h('span', { class: 'to', text: `${fmt(after)} tokens` }),
        h('span', { class: 'saved', text: cut ? `−${fmt(cut)}` : '' })),
      h('div', { class: 'meter-bar' }, h('span', { class: 'keep', style: `width:${(100 * after) / m.window}%` }), h('span', { class: 'cut', style: `width:${(100 * cut) / m.window}%` })),
      h('div', { id: 'verify', class: 'verify' })));

    const warns = new Set(), profile = [];
    for (const n of marked) { if (n.warn && n.t !== 'prompt' && n.t !== 'reply') warns.add(n.warn); if (n.profile) profile.push(n); }
    const tasks = new Set(marked.flatMap(n => actsOf(n).filter(a => a.task && S.marks.has(a.task)).map(a => a.task)));
    if (tasks.size) warns.add(`${tasks.size} whole task${tasks.size > 1 ? 's go' : ' goes'}: your message, everything Claude did for it, and its replies.`);
    if (warns.size) body.append(h('div', { class: 'callout warn' }, h('b', { text: 'Check before you go' }), h('ul', null, [...warns].slice(0, 6).map(w => h('li', { text: w })))));
    if (profile.length) body.append(h('div', { class: 'callout' }, h('b', { text: 'Resume with the command ctxtree gives you. ' }),
      `${profile.length} setup removal${profile.length > 1 ? 's need' : ' needs'} a launch profile (a small settings file) so Claude Code doesn’t load ${profile.length > 1 ? 'them' : 'it'} again. Plain claude --resume would bring ${profile.length > 1 ? 'them' : 'it'} back.`));

    for (const g of [...groups.values()].sort((a, b) => b.tok - a.tok)) {
      const sec = h('div', { class: 'sec' }, h('h3', null, h('span', { class: 'nm', text: g.name, title: g.name }), h('span', { text: `${g.items.length} · −${fmt(g.tok)}` })));
      const items = g.items.sort((a, b) => markedSave(b) - markedSave(a));
      for (const n of items.slice(0, 40)) {
        sec.append(h('div', { class: 'qrow' }, h('span', { class: 'sw', style: `background:${colorOf(n.t)}` }),
          h('span', { class: 'nm', text: n.name, title: ancestors(n).reverse().slice(1).map(a => a.name).concat(n.name).join(' › ') }),
          h('span', { class: 't', text: `−${fmt(markedSave(n))}` }),
          h('button', { class: 'x', title: 'Keep this', text: '×', onclick: () => { setMarks([n], false); if (!S.marks.size && !opCount()) closeDrawer(); else verify(); } })));
      }
      if (items.length > 40) sec.append(h('div', { class: 'qmore', text: `and ${items.length - 40} more` }));
      body.append(sec);
    }
    const ops = [];
    if (S.ops.switchTip) ops.push(['Switch to the rewound branch', 'switch', false]);
    if (S.ops.uncompact) ops.push(['Restore the conversation before the compaction', 'uncompact', false]);
    if (S.ops.slim) ops.push(['Remove everything not resumed from the fork’s file', 'slim', false]);
    if (ops.length) {
      const sec = h('div', { class: 'sec' }, h('h3', null, 'File changes', h('span', { text: '' })));
      for (const [label, op] of ops) sec.append(h('div', { class: 'qrow' }, h('span', { class: 'sw', style: 'background:var(--faint)' }), h('span', { class: 'nm', text: label }),
        h('button', { class: 'x', title: 'Undo this', text: '×', onclick: () => { setOp(op, false); if (!S.marks.size && !opCount()) closeDrawer(); else verify(); } })));
      body.append(sec);
    }

    const note = h('input', { id: 'fork-note', type: 'text', placeholder: 'Note for this fork (optional)', value: (document.getElementById('fork-note') || {}).value || '' });
    const commit = h('button', { id: 'btn-commit', class: 'primary danger', disabled: !(lastVerify && lastVerify.state === 'ok'), text: 'Create fork', onclick: commitFork });
    dr.replaceChildren(
      h('div', { class: 'dr-head' }, h('h2', { text: 'Delete from context' }), h('p', { text: `${$('#session-title').textContent}` }),
        h('button', { class: 'dr-x', text: '×', title: 'Close', onclick: closeDrawer })),
      body,
      h('div', { class: 'dr-foot' },
        h('div', { class: 'label', text: 'ctxtree writes a new session (a fork) with these deleted completely: no note, no trace, so Claude will not know they happened. Your original session is not changed.' }),
        note,
        h('div', { class: 'dr-btns' }, h('button', { class: 'secondary', text: 'Cancel', onclick: closeDrawer }), commit)));
    paintVerify();
  }

  async function commitFork() {
    const btn = $('#btn-commit');
    btn.disabled = true; btn.textContent = 'Creating…';
    let r;
    try { r = await api('/api/fork', { ...payload(), note: ($('#fork-note') || {}).value || '' }); } catch (e) {
      lastVerify = { state: 'bad', msg: e.message, problems: (e.data && e.data.problems) || [] };
      paintVerify(); btn.textContent = 'Create fork';
      return;
    }
    r.shown = { before: curRoot().tok, after: Math.max(0, curRoot().tok - r.resume.saved) };
    S.marks.clear(); S.ops = { uncompact: false, slim: false, switchTip: '' }; S.undo = [];
    await loadSessions().catch(() => {});
    renderDone(r);
    changed();
  }
  function renderDone(r) {
    drawerMode = 'done';
    const dr = $('#drawer');
    const id8 = r.forkSid.slice(0, 8);
    const cmd = r.resumeCmd;
    const short = `ctxtree resume ${id8}`;
    const copy = (text) => () => navigator.clipboard.writeText(text).then(() => toast('Copied'));
    dr.replaceChildren(
      h('div', { class: 'dr-head' }, h('h2', { text: 'Fork created' }), h('p', { text: `${r.projectName} · ${id8}` }),
        h('button', { class: 'dr-x', text: '×', onclick: closeDrawer })),
      h('div', { class: 'dr-body' },
        h('div', { class: 'done-mark' }, svg(ICON.check)),
        h('div', { class: 'sum-nums' }, h('span', { class: 'from', text: fmt(r.shown.before) }), h('span', { class: 'arrow', text: '→' }),
          h('span', { class: 'to', text: `${fmt(r.shown.after)} tokens` }), h('span', { class: 'saved', text: `−${fmt(r.resume.saved)}` })),
        h('p', { class: 'd-note', text: 'The original session is untouched. Continue in the fork:' }),
        h('div', { class: 'label', text: 'Resume command' }),
        h('div', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'secondary', text: 'Copy', onclick: copy(cmd) })),
        h('div', { class: 'label', text: 'or, from anywhere' }),
        h('div', { class: 'cmd' }, h('code', { text: short }), h('button', { class: 'secondary', text: 'Copy', onclick: copy(short) })),
        r.profileFile ? h('p', { class: 'd-note', text: 'This fork has a launch profile, so use one of these commands rather than a plain claude --resume.' }) : null),
      h('div', { class: 'dr-foot' }, h('div', { class: 'dr-btns' },
        h('button', { class: 'secondary', text: 'Done', onclick: closeDrawer }),
        h('button', { class: S.env.vtower ? 'secondary' : 'primary', text: 'View its map', onclick: () => { closeDrawer(); openSession(r.forkSid); } }),
        S.env.vtower ? h('button', { class: 'primary', text: 'Open in vTower', onclick: () => openInVtower(r.forkSid, cmd) }) : null)));
  }
  // A new vTower tab in the fork's folder, resuming it (the server opens the
  // vtower:// link); without vTower, the command to paste.
  async function openInVtower(forkSid, cmd) {
    try { await api('/api/open-fork', { forkSid }); toast('Opening in vTower'); }
    catch (e) {
      const c = (e.data && e.data.resumeCmd) || cmd;
      if (c && navigator.clipboard) { await navigator.clipboard.writeText(c).catch(() => {}); toast(`${e.message} The resume command is copied.`, true); }
      else toast(e.message, true);
    }
  }

  // ---------------------------------------------------------------- forks
  async function openForks() {
    await loadSessions().catch(() => {});
    openDrawer('forks');
    renderForks();
  }
  function renderForks() {
    const dr = $('#drawer');
    const list = [...S.forks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const body = h('div', { class: 'dr-body' });
    if (!list.length) body.append(h('p', { class: 'd-note', text: 'No forks yet. Mark something, review it, and create one.' }));
    for (const f of list) {
      const copy = () => navigator.clipboard.writeText(f.resumeCmd).then(() => toast('Resume command copied'));
      body.append(h('div', { class: 'frow' },
        h('div', { class: 'f-top' }, h('span', { class: 'f-note', text: f.note || 'Fork' }), h('span', { class: 'f-saved', text: f.savedTok ? `−${fmt(f.savedTok)}` : '' })),
        h('div', { class: 'f-meta', text: `${f.projectName || ''} · ${ago(f.createdAt)} · ${f.forkSid.slice(0, 8)}${f.exists === false ? ' · file missing' : ''}${f.grown ? ' · continued since' : ''}` }),
        h('div', { class: 'f-btns' },
          f.exists !== false && S.env.vtower ? h('button', { class: 'primary', text: 'Open in vTower', onclick: () => openInVtower(f.forkSid, f.resumeCmd) }) : null,
          f.exists !== false ? h('button', { text: 'View map', onclick: () => { closeDrawer(); openSession(f.forkSid); } }) : null,
          h('button', { text: 'Copy resume command', onclick: copy }),
          h('button', { class: 'del', text: 'Revert', title: 'Delete this fork (the original stays)', onclick: () => revert(f) }))));
    }
    dr.replaceChildren(
      h('div', { class: 'dr-head' }, h('h2', { text: 'Forks' }), h('p', { text: 'Sessions ctxtree wrote. Reverting deletes the fork; the original is never touched.' }),
        h('button', { class: 'dr-x', text: '×', onclick: closeDrawer })),
      body);
  }
  async function revert(f) {
    if (!confirm(`Delete fork ${f.forkSid.slice(0, 8)}? The original session stays as it is.`)) return;
    try { await api('/api/revert', { forkSid: f.forkSid }); } catch (e) {
      if (!/force/.test(e.message) || !confirm(`${e.message}\n\nDelete it anyway?`)) { toast(e.message, true); return; }
      try { await api('/api/revert', { forkSid: f.forkSid, force: true }); } catch (e2) { toast(e2.message, true); return; }
    }
    toast('Fork deleted');
    await loadSessions().catch(() => {});
    if (S.sid === f.forkSid) { const parent = S.sessions.find(s => s.sid === f.parentSid) || S.sessions[0]; if (parent) openSession(parent.sid, { keepMarks: true }); }
    renderForks();
  }

  // -------------------------------------------------------- session picker
  let popKb = 0, popRows = [];
  function openPicker() {
    const pop = $('#session-pop'), btn = $('#session-btn').getBoundingClientRect();
    pop.style.left = `${btn.left}px`; pop.style.top = `${btn.bottom + 6}px`;
    pop.classList.remove('hidden');
    const q = $('#session-search');
    q.value = '';
    renderPicker();
    q.focus();
  }
  function closePicker() { $('#session-pop').classList.add('hidden'); }
  function renderPicker() {
    const q = $('#session-search').value.trim().toLowerCase();
    popRows = S.sessions.filter(s => !q || `${titleOf(s)} ${s.projectName} ${s.sid}`.toLowerCase().includes(q)).slice(0, 200);
    popKb = Math.max(0, popRows.findIndex(s => s.sid === S.sid));
    if (q) popKb = 0;
    const list = $('#session-list');
    if (!popRows.length) { list.replaceChildren(h('div', { class: 'none', text: 'No session matches.' })); return; }
    list.replaceChildren(...popRows.map((s, i) => h('div', { class: `srow${s.sid === S.sid ? ' cur' : ''}${i === popKb ? ' kb' : ''}`, 'data-sid': s.sid, role: 'option' },
      h('div', { class: 's-main' }, h('div', { class: 's-t' }, titleOf(s) || s.sid.slice(0, 8), forkOf(s.sid) ? h('span', { class: 'tag', text: 'fork' }) : null),
        h('div', { class: 's-m', text: `${s.projectName} · ${ago(s.lastTs)} · ${s.turns} turns` })),
      h('div', { class: 's-tok', text: fmt(s.peak || s.tok) }))));
    const kb = list.querySelector('.kb');
    if (kb) kb.scrollIntoView({ block: 'nearest' });
  }
  function pickerEvents() {
    $('#session-btn').addEventListener('click', (e) => { e.stopPropagation(); if ($('#session-pop').classList.contains('hidden')) openPicker(); else closePicker(); });
    $('#session-search').addEventListener('input', renderPicker);
    $('#session-search').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        popKb = Math.max(0, Math.min(popRows.length - 1, popKb + (e.key === 'ArrowDown' ? 1 : -1)));
        document.querySelectorAll('.srow').forEach((r, i) => r.classList.toggle('kb', i === popKb));
        const kb = document.querySelector('.srow.kb'); if (kb) kb.scrollIntoView({ block: 'nearest' });
        e.preventDefault();
      } else if (e.key === 'Enter' && popRows[popKb]) { closePicker(); openSession(popRows[popKb].sid); }
      else if (e.key === 'Escape') closePicker();
    });
    $('#session-list').addEventListener('click', (e) => {
      const r = e.target.closest('.srow');
      if (r) { closePicker(); openSession(r.dataset.sid); }
    });
  }

  // ------------------------------------------------------------ side tabs
  // Details and Types share the side column, one at a time, full height.
  function showTab(tab) {
    S.tab = tab === 'types' ? 'types' : 'details';
    store.set('sideTab', S.tab);
    document.querySelectorAll('.side-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === S.tab); b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)); });
    $('#types-panel').classList.toggle('hidden', S.tab !== 'types');
    $('#details').classList.toggle('hidden', S.tab !== 'details');
  }

  // ------------------------------------------------------------ splitters
  // The tree takes the height of its rows, at most `treeMax` of the left
  // column (the divider sets that); the treemap gets the rest.
  function fitTree() {
    const left = $('#left'), pane = $('#tree-pane');
    if (!left.clientHeight) return;
    const max = store.get('treeMax', 0.45) * left.clientHeight;
    const need = $('#thead').offsetHeight + Math.max(3, S.rows.length) * ROW + 4;
    const want = `${Math.round(Math.max(96, Math.min(max, need)))}px`;
    if (pane.style.height !== want) pane.style.height = want;
  }
  function splitters() {
    const side = $('#side-pane');
    side.style.flexBasis = `${store.get('splitV', 0.42) * 100}%`;
    const drag = (el, onMove, onEnd) => el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('drag');
      const move = (ev) => onMove(ev);
      const up = () => { el.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); onEnd(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    drag($('#split-h'), (e) => {
      const r = $('#left').getBoundingClientRect();
      const f = Math.max(0.12, Math.min(0.85, (e.clientY - r.top) / r.height));
      store.set('treeMax', f);
      $('#tree-pane').style.height = `${Math.round(f * r.height)}px`;
      renderTree();
    }, () => { fitTree(); layoutMap(); });
    drag($('#split-v'), (e) => {
      const r = $('#main').getBoundingClientRect();
      const f = Math.max(0.22, Math.min(0.6, (r.right - e.clientX) / r.width));
      side.style.flexBasis = `${f * 100}%`;
      store.set('splitV', f);
    }, () => layoutMap());
  }

  // ----------------------------------------------------------------- boot
  async function rescan() {
    const b = $('#btn-rescan');
    b.classList.add('spin');
    try {
      await api('/api/refresh', {});
      await loadSessions();
      if (S.sid) await openSession(S.sid, { keepMarks: true });
      toast('Rescanned');
    } catch (e) { toast(e.message, true); }
    b.classList.remove('spin');
  }

  // The server bumps a version when a session file changes. The list follows;
  // the open session reloads in place when nothing is marked, else it says so.
  async function poll() {
    if (document.hidden) return;
    let v;
    try { v = (await api('/api/version')).version; } catch { return; }
    if (!S.version) { S.version = v; return; }
    if (v === S.version) return;
    S.version = v;
    const before = S.sessions.find(x => x.sid === S.sid);
    await loadSessions().catch(() => {});
    const after = S.sessions.find(x => x.sid === S.sid);
    if (!S.sid || !after || (before && before.bytes === after.bytes)) return;
    if (!S.marks.size && !opCount() && !drawerMode) await openSession(S.sid, { reload: true });
    else { S.changed = true; renderStatus(); }
  }

  async function start() {
    treeEvents(); typeEvents(); mapEvents(); pickerEvents(); splitters();
    api('/api/env').then(e => { S.env = e; }).catch(() => {});
    setInterval(poll, 4000);
    document.addEventListener('visibilitychange', poll);
    document.querySelectorAll('.side-tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab(S.tab);
    $('#btn-review').addEventListener('click', openReview);
    document.querySelectorAll('#view-seg button').forEach(b => b.addEventListener('click', () => { if (b.dataset.view !== S.view) showView(b.dataset.view); }));
    document.querySelectorAll('#view-seg button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-forks').addEventListener('click', openForks);
    $('#btn-rescan').addEventListener('click', rescan);
    $('#btn-reload').addEventListener('click', async () => {
      if ((S.marks.size || opCount()) && !confirm('Reload this session? It changed since you opened it; marks that still apply are kept.')) return;
      S.changed = false; renderStatus();
      await openSession(S.sid, { reload: true });
    });
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#menu')) closeMenu();
      if (!e.target.closest('#session-pop') && !e.target.closest('#session-btn')) closePicker();
    });
    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest && e.target.closest('input, textarea');
      if (!$('#menu').classList.contains('hidden')) {
        if (e.key === 'Escape') { closeMenu(); e.preventDefault(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          menuKb = (menuKb + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
          menuItems.forEach((m, i) => m.classList.toggle('kb', i === menuKb));
          e.preventDefault(); e.stopPropagation(); return;
        }
        if (e.key === 'Enter' && menuItems[menuKb]) { menuItems[menuKb].click(); e.preventDefault(); return; }
      }
      if (e.key === 'Escape') { closePicker(); if (drawerMode) closeDrawer(); }
      if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); }
      if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { openPicker(); e.preventDefault(); }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'i' || e.key === 't')) { showTab(e.key === 't' ? 'types' : 'details'); e.preventDefault(); }
      // ⌫ marks the selection wherever the focus is (the tree handles its own)
      if (!typing && !drawerMode && (e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('#tree')) {
        const n = S.byId.get(S.sel);
        if (n && S.parent.get(n.id)) { toggleNode(n); e.preventDefault(); }
      }
    }, true);
    let rt = 0;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { layoutMap(); renderTree(); }, 60); }).observe($('#map-wrap'));
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { hatch = null; layoutMap(); });

    try { await loadSessions(); } catch (e) { $('#session-title').textContent = 'Could not load sessions'; toast(e.message, true); return; }
    if (!S.sessions.length) { $('#session-title').textContent = 'No Claude Code sessions found'; return; }
    const want = location.hash.slice(1);
    const first = S.sessions.find(s => s.sid === want) || S.sessions[0];
    await openSession(first.sid);
    $('#tree').focus();
  }
  start();
})();
