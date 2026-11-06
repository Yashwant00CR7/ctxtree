// Boot overhead: the tool list, MCP server instructions, skill and agent
// listings, CLAUDE.md files and the system prompt.
//
// How Claude Code carries it (verified on 2.1.283 by resuming edited forks
// against a recording API stand-in):
//  - It is written into the transcript as attachment records on the parent
//    chain. A record's `rendered` field is the exact text sent, and a resume
//    replays it verbatim; without `rendered` the text is rebuilt from
//    `attachment`.
//  - On resume Claude Code diffs what the transcript says was announced against
//    what is configured now, and appends a delta for the difference. So deleting
//    an announcement alone just gets it re-announced at the end.
//  - The diff is by NAME for MCP instructions, skills and agents: keep the name
//    in the record, drop its text, and nothing is re-announced -- no config change.
//  - It is by CONTENT for CLAUDE.md, and tools come from the live tool pool. Those
//    also need a launch overlay: `--settings` with claudeMdExcludes /
//    autoMemoryEnabled / permissions.deny. A bare-name deny removes the tool
//    from the request entirely (inline schema or deferred name).
//  - The latest prompt_snapshot's systemPrompt is sent as-is until the session
//    compacts again, so editing it in the fork edits the system prompt.
// Every rule here has a matching case in test/cc-e2e.js, which runs the real CLI.
import { fingerprint } from './session.js';

export const serverKey = (name) => String(name || '').replace(/[^A-Za-z0-9_-]/g, '_');
export const serverOfTool = (toolName = '') => (toolName.startsWith('mcp__') ? toolName.split('__')[1] || '' : '');

// Tree placement. The scanner (attach.js) and the inventory below both use these,
// so a node in the tree always resolves to the same removable item.
export const BOOT_SUB = {
  mcp: 'MCP servers', tool: 'built-in tools', skill: 'skills', agent: 'agent listing',
  md: 'CLAUDE.md', sys: 'system prompt',
};
export const sysLabel = (text) => {
  const t = String(text || '');
  const h = t.match(/^\s*#{1,3}\s+(.+)$/m);
  const first = (h ? h[1] : t.trim().split('\n')[0] || '').trim();
  return (first.length > 60 ? first.slice(0, 57) + '...' : first) || '(section)';
};
export const sysId = (text) => `sys:${fingerprint(text)}`;

// "- name: description" entries; a description may continue on following lines.
// Plugin skills are "plugin:skill", so the name ends at the first colon that is
// followed by whitespace.
export const ENTRY_RE = /^- (\S+?):(?=\s|$)/gm;
export function listEntries(content) {
  const out = [];
  const s = String(content || '');
  const re = new RegExp(ENTRY_RE.source, 'gm');
  const starts = [];
  let m;
  while ((m = re.exec(s))) starts.push({ i: m.index, name: m[1].trim() });
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].i : s.length;
    let text = s.slice(starts[k].i, end);
    text = text.replace(/\n+$/, '');
    out.push({ name: starts[k].name, text });
  }
  return out;
}

const renderedText = (o) => (Array.isArray(o.rendered)
  ? o.rendered.map(x => (x && typeof x.content === 'string' ? x.content : '')).join('\n') : '');

const CORE_TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ToolSearch', 'Skill', 'Agent']);

// Everything removable in the context `claude --resume` loads, sized from what is
// actually sent.
export function bootInventory(parsed) {
  const items = new Map();
  const item = (id, init) => {
    let it = items.get(id);
    if (!it) { it = { id, chars: 0, parts: {}, ...init }; items.set(id, it); }
    return it;
  };
  const add = (it, part, n) => { it.chars += n; it.parts[part] = (it.parts[part] || 0) + n; };
  const mcp = (key, display) => item(`mcp:${key}`, {
    kind: 'mcp', name: key, display: display || key, sub: BOOT_SUB.mcp, leaf: key, tools: [],
    source: /^claude_ai_/.test(key) ? 'claude.ai connector' : (/^plugin_/.test(key) ? 'plugin' : 'MCP config'),
  });
  let snap = null;

  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || o.type !== 'attachment' || !o.uuid || !parsed.live.has(o.uuid)) continue;
    const a = o.attachment || {};
    const rt = renderedText(o);
    switch (a.type) {
      case 'mcp_instructions_delta':
        (a.addedNames || []).forEach((n, i) => {
          const b = (a.addedBlocks || [])[i] || '';
          if (b) add(mcp(serverKey(n), n), 'instructions', b.length);
        });
        break;
      case 'deferred_tools_delta':
        for (const n of a.addedNames || []) {
          const key = serverOfTool(n);
          if (key) { const it = mcp(key); add(it, 'tool names', n.length + 1); if (!it.tools.includes(n)) it.tools.push(n); }
          else add(item(`tool:${n}`, { kind: 'tool', name: n, sub: BOOT_SUB.tool, leaf: n, deferred: true }), 'tool names', n.length + 1);
        }
        break;
      case 'deferred_tools_record':
        for (const e of a.entries || []) {
          const key = serverOfTool(e && e.name);
          const n = JSON.stringify(e).length;
          if (key) add(mcp(key), 'loaded schemas', n);
          else if (e && e.name) add(item(`tool:${e.name}`, { kind: 'tool', name: e.name, sub: BOOT_SUB.tool, leaf: e.name }), 'loaded schemas', n);
        }
        break;
      case 'skill_listing':
        for (const e of listEntries(rt || a.content)) {
          add(item(`skill:${e.name}`, { kind: 'skill', name: e.name, sub: BOOT_SUB.skill, leaf: e.name, plugin: e.name.includes(':') }), 'listing', e.text.length);
        }
        break;
      case 'agent_listing_delta':
        for (const e of listEntries((a.addedLines || []).join('\n'))) {
          add(item(`agent:${e.name}`, { kind: 'agent', name: e.name, sub: BOOT_SUB.agent, leaf: e.name }), 'listing', e.text.length);
        }
        break;
      case 'instructions':
        for (const f of a.files || []) {
          if (!f || !f.path) continue;
          add(item(`md:${f.path}`, { kind: 'md', name: f.path, mdType: f.type || '', sub: BOOT_SUB.md, leaf: f.path }), 'file', (f.content || '').length);
        }
        break;
      case 'nested_memory': {
        const p = a.path || (a.content && a.content.path);
        const c = typeof a.content === 'string' ? a.content : (a.content && a.content.content) || '';
        if (p && c) add(item(`md:${p}`, { kind: 'md', name: p, mdType: (a.content && a.content.type) || 'Project', sub: BOOT_SUB.md, leaf: p, nested: true }), 'file', c.length);
        break;
      }
      case 'prompt_snapshot': snap = a; break;
      default: break;
    }
  }
  // Only the latest snapshot is sent. Its tool list is the inline schemas.
  if (snap) {
    for (const s of snap.systemPrompt || []) {
      if (typeof s !== 'string' || !s.trim()) continue;
      add(item(sysId(s), { kind: 'sys', name: sysLabel(s), sub: BOOT_SUB.sys, leaf: sysLabel(s) }), 'section', s.length);
    }
    for (const t of snap.tools || []) {
      if (!t || !t.name) continue;
      const key = serverOfTool(t.name);
      const n = JSON.stringify(t).length;
      if (key) { const it = mcp(key); add(it, 'inline schemas', n); if (!it.tools.includes(t.name)) it.tools.push(t.name); }
      else add(item(`tool:${t.name}`, { kind: 'tool', name: t.name, sub: BOOT_SUB.tool, leaf: t.name }), 'inline schema', n);
    }
  }

  for (const it of items.values()) describe(it);
  return [...items.values()].sort((a, b) => b.chars - a.chars);
}

// What removing it takes, how long the removal lasts, and what to warn about.
function describe(it) {
  it.removable = true;
  it.needs = {};
  switch (it.kind) {
    case 'mcp':
      it.needs.deny = [`mcp__${it.name}`];
      it.how = `Its tool names and schemas are denied at launch; its instructions are removed from the transcript.`;
      it.lasts = 'Tools: every launch through the fork\'s profile. Instructions: until the fork compacts (the server is still connected, so a compaction re-announces them).';
      break;
    case 'tool':
      it.needs.deny = [it.name];
      it.how = 'Denied at launch, which removes the tool from the request, and dropped from the recorded tool list.';
      it.lasts = 'Every launch through the fork\'s profile.';
      if (CORE_TOOLS.has(it.name)) it.warn = `${it.name} is a core tool; without it Claude cannot ${it.name === 'ToolSearch' ? 'load any deferred tool' : it.name === 'Skill' ? 'use skills' : 'do that kind of work'} in this fork.`;
      break;
    case 'skill':
      if (!it.plugin) it.needs.skillOverrides = { [it.name]: 'user-invocable-only' };
      it.how = 'Its listing line is removed; the recorded name stays, so Claude Code does not re-announce it.' + (it.plugin ? '' : ' You can still run it yourself as /' + it.name + '.');
      it.lasts = it.plugin ? 'Until the fork compacts (plugin skills have no per-skill override).' : 'Every launch through the fork\'s profile.';
      break;
    case 'agent':
      it.how = 'Its listing line is removed; the recorded agent type stays, so it is not re-announced.';
      it.lasts = 'Until the fork compacts.';
      break;
    case 'md':
      if (it.mdType === 'Managed') { it.removable = false; it.reason = 'Managed (policy) instructions cannot be excluded.'; break; }
      if (it.mdType === 'AutoMem') {
        it.needs.autoMemoryEnabled = false;
        it.how = 'Removed from the transcript, and auto memory is off for launches of this fork (Claude will not read or write memory there).';
      } else {
        it.needs.claudeMdExcludes = [it.name];
        it.how = 'Removed from the transcript and excluded at launch, so it is not re-read.';
      }
      it.lasts = 'Every launch through the fork\'s profile.';
      break;
    case 'sys':
      it.how = 'Removed from the recorded system prompt, which Claude Code sends verbatim on resume.';
      it.lasts = 'Until the fork compacts; a compaction renders a fresh system prompt.';
      it.warn = 'This is Claude Code\'s own system prompt. Removing sections changes how Claude behaves in the fork.';
      break;
    default: break;
  }
}

// Map a tree node (boot overhead / sub / leaf) to the items it covers.
export function bootIdsForNode(inventory, sub, leaf) {
  return inventory.filter(it => it.removable && (!sub || it.sub === sub) && (!leaf || it.leaf === leaf)).map(it => it.id);
}

// The --settings overlay a fork is launched with. Lists merge with the user's own
// settings; nothing here edits a config file.
export function launchProfile(items) {
  const s = {};
  const deny = [], excludes = [], overrides = {};
  for (const it of items) {
    const n = it.needs || {};
    if (n.deny) deny.push(...n.deny);
    if (n.claudeMdExcludes) excludes.push(...n.claudeMdExcludes);
    if (n.skillOverrides) Object.assign(overrides, n.skillOverrides);
    if (n.autoMemoryEnabled === false) s.autoMemoryEnabled = false;
  }
  if (deny.length) s.permissions = { deny: [...new Set(deny)] };
  if (excludes.length) s.claudeMdExcludes = [...new Set(excludes)];
  if (Object.keys(overrides).length) s.skillOverrides = overrides;
  return Object.keys(s).length ? s : null;
}

// ------------------------------------------------------------------ surgery
// Remove `piece` and the separator before it. null when it is not there, so the
// caller can fall back to dropping `rendered` (Claude Code then re-renders from
// the already-edited attachment data).
function cut(s, piece) {
  if (!piece) return s;
  const i = s.indexOf(piece);
  if (i < 0) return null;
  let start = i;
  if (s.slice(start - 2, start) === '\n\n') start -= 2;
  else if (s[start - 1] === '\n') start -= 1;
  return s.slice(0, start) + s.slice(i + piece.length);
}
function cutLines(s, names) {
  const drop = new Set(names);
  return s.split('\n').filter(l => !drop.has(l)).join('\n');
}
function cutSection(s, path, content) {
  const h = s.indexOf(`Contents of ${path} (`);
  if (h < 0) return null;
  const c = s.indexOf(content, h);
  if (c < 0) return null;
  let start = h;
  while (start > 0 && s[start - 1] === '\n') start--;
  return s.slice(0, start) + s.slice(c + content.length);
}

// Edit one attachment record in place for the removal set. Returns what must no
// longer appear in it (the verifier checks), or null if the record is untouched.
export function applyBootToRecord(o, removeIds) {
  const a = o.attachment;
  if (!a || typeof a !== 'object') return null;
  const has = (id) => removeIds.has(id);
  const gone = [];
  const rend = Array.isArray(o.rendered) ? o.rendered : null;
  let rerender = false;
  const editRendered = (fn) => {
    if (!rend) return;
    for (const x of rend) {
      if (!x || typeof x.content !== 'string') continue;
      const next = fn(x.content);
      if (next === null) { rerender = true; return; }
      x.content = next;
    }
  };
  const toolGone = (name) => { const k = serverOfTool(name); return k ? has(`mcp:${k}`) : has(`tool:${name}`); };

  switch (a.type) {
    case 'mcp_instructions_delta': {
      (a.addedNames || []).forEach((n, i) => {
        if (!has(`mcp:${serverKey(n)}`)) return;
        const b = (a.addedBlocks || [])[i];
        if (!b) return;
        a.addedBlocks[i] = '';           // the name stays: announced, so not re-sent
        editRendered(s => cut(s, b));
        if (b.length > 24) gone.push(b);
      });
      break;
    }
    case 'deferred_tools_delta': {
      const names = (a.addedNames || []).filter(toolGone);
      if (!names.length) break;
      const drop = new Set(names);
      for (const f of ['addedNames', 'addedLines', 'surfacedNames', 'readdedNames', 'wireHiddenNames'])
        if (Array.isArray(a[f])) a[f] = a[f].filter(x => !drop.has(x));
      editRendered(s => cutLines(s, names));
      gone.push(...names.map(n => `\n${n}\n`));
      break;
    }
    case 'deferred_tools_record': {
      const before = (a.entries || []).length;
      const removed = (a.entries || []).filter(e => e && toolGone(e.name));
      if (!removed.length) break;
      a.entries = a.entries.filter(e => !(e && toolGone(e.name)));
      if (a.entries.length === before) break;
      gone.push(...removed.map(e => `"name":"${e.name}"`));
      break;
    }
    case 'prompt_snapshot': {
      if (Array.isArray(a.tools)) {
        const removed = a.tools.filter(t => t && toolGone(t.name));
        if (removed.length) { a.tools = a.tools.filter(t => !(t && toolGone(t.name))); gone.push(...removed.map(t => `"name":"${t.name}"`)); }
      }
      if (Array.isArray(a.systemPrompt)) {
        const removed = a.systemPrompt.filter(s => typeof s === 'string' && s.trim() && has(sysId(s)));
        if (removed.length) {
          a.systemPrompt = a.systemPrompt.filter(s => !(typeof s === 'string' && s.trim() && has(sysId(s))));
          gone.push(...removed.filter(s => s.length > 40).map(s => s.slice(0, 400)));
        }
      }
      break;
    }
    case 'skill_listing': {
      const entries = listEntries(a.content).filter(e => has(`skill:${e.name}`));
      if (!entries.length) break;
      for (const e of entries) {
        a.content = cut(a.content, e.text) ?? a.content;
        editRendered(s => cut(s, e.text));
        gone.push(e.text);
      }
      break;                              // `names` keeps them: announced, so not re-sent
    }
    case 'agent_listing_delta': {
      const lines = (a.addedLines || []).filter(l => { const m = /^- (\S+?):(?=\s|$)/.exec(l); return m && has(`agent:${m[1]}`); });
      if (!lines.length) break;
      a.addedLines = a.addedLines.filter(l => !lines.includes(l));
      editRendered(s => { let t = s; for (const l of lines) { const n = cut(t, l); if (n === null) return null; t = n; } return t; });
      gone.push(...lines);
      break;
    }
    case 'instructions': {
      const files = (a.files || []).filter(f => f && has(`md:${f.path}`));
      if (!files.length) break;
      a.files = a.files.filter(f => !(f && has(`md:${f.path}`)));
      if (!a.files.length && rend) o.rendered = [];                  // nothing left to send
      else editRendered(s => { let t = s; for (const f of files) { const n = cutSection(t, f.path, f.content || ''); if (n === null) return null; t = n; } return t; });
      gone.push(...files.filter(f => (f.content || '').length > 24).map(f => f.content));
      break;
    }
    case 'nested_memory': {
      const p = a.path || (a.content && a.content.path);
      if (!p || !has(`md:${p}`)) break;
      const c = typeof a.content === 'string' ? a.content : (a.content && a.content.content) || '';
      if (typeof a.content === 'string') a.content = ''; else if (a.content) a.content.content = '';
      if (rend) o.rendered = [];
      if (c.length > 24) gone.push(c);
      break;
    }
    default: return null;
  }
  if (!gone.length) return null;
  if (rerender) delete o.rendered;
  return { gone, rerender };
}
