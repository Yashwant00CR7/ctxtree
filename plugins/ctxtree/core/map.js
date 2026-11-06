// The session as a WizTree-style map: one tree, sized in tokens, whose every
// leaf is a single thing in the resumed context and carries the handle that
// deletes it. The UI never has to know which mechanism a deletion uses:
//   act.k === 'drop'   -> hard delete: a unit (map.units) leaves the fork whole
//                         (restructure.js planDrop). Units are a task (your
//                         message and everything done for it), a tool step
//                         (Claude's call message and what came back) and an
//                         attachment. A leaf's act carries its own share of
//                         the tokens; leaves of one unit share its id. Your
//                         messages and Claude's last words only go with their
//                         task, so their act is the task's (act.task is set).
//   act.k === 'img'    -> take an image out of your message, keep the words
//   act.k === 'boot'   -> boot removal + launch profile (boot.js)
// Content `claude --resume` does not load is a second, grey tree whose groups
// carry the structural ops (restructure.js) that act on it.
import { bootInventory, BOOT_SUB } from './boot.js';
import { structureInfo } from './restructure.js';
import { ForkError } from './fork-error.js';
import { tokensOf } from './tokens.js';
import { timelineOf, sliceText, PREVIEW_CHARS } from './timeline.js';

// Attachment types bootInventory sizes; everything else live is "other".
const BOOT_ATTACH = new Set(['mcp_instructions_delta', 'deferred_tools_delta', 'deferred_tools_record',
  'skill_listing', 'agent_listing_delta', 'instructions', 'nested_memory', 'prompt_snapshot']);
const BOOT_TYPE = { mcp: 'mcp', tool: 'tools', skill: 'skill', agent: 'agent', md: 'md', sys: 'sys' };

// Tokens, anchored to what Claude Code measured. The last reply on the resumed
// chain records the exact size of the request that produced it (input + cache
// read + cache write). Everything sent before that reply is sized with the
// calibrated per-kind ratios, and one factor scales it to the measured total:
// the session's total is then measured, only the split between items is an
// estimate. A ctxtree fork nobody has continued still carries its parent's
// numbers, so it borrows the parent's factor.
const THINK = new Set(['thinking', 'redacted_thinking']);
export function anchorScale(cal, parsed) {
  const raw = (chars, kind) => (kind === 'image' ? tokensOf(0, 'image', cal) : chars / (cal.ratios[kind] || cal.ratios.text || 4));
  let anchor = null;
  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || o.type !== 'assistant' || o.isSidechain || !o.uuid || !parsed.live.has(o.uuid)) continue;
    const u = o.message && o.message.usage;
    if (!u) continue;
    const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const id = o.message.id || o.uuid;
    if (!anchor || anchor.id !== id) anchor = { id, line: r.line, total };
  }
  if (!anchor || anchor.total < 1000) return null;
  let before = 0, snap = null;
  for (const b of parsed.blocks) if (b.live && !b.side && !THINK.has(b.blockType) && b.line < anchor.line) before += raw(b.chars, b.kind);
  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || o.type !== 'attachment' || !o.uuid || !parsed.live.has(o.uuid)) continue;
    const a = o.attachment || {};
    if (a.type === 'prompt_snapshot') { snap = a; continue; }
    if (r.line < anchor.line && Array.isArray(o.rendered)) before += raw(o.rendered.reduce((n, x) => n + (typeof (x && x.content) === 'string' ? x.content.length : 0), 0), 'attach');
  }
  if (snap) before += raw(JSON.stringify(snap.systemPrompt || []).length + JSON.stringify(snap.tools || []).length, 'attach');
  const scale = before > 0 ? anchor.total / before : 0;
  return scale > 0.25 && scale < 5 ? { scale, raw, measured: anchor.total } : null;
}

const oneLine = (t, n = 90) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
// A message's first words, without the XML wrappers Claude Code puts around
// slash commands, their output and system reminders.
const msgName = (t) => {
  const s = String(t || '');
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) return `${cmd[1].trim()} command`;
  if (/^\s*<local-command-caveat>/.test(s)) return 'Note about local commands';
  const out = s.match(/<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/);
  if (out) return `Command output: ${oneLine(out[1].replace(/\x1b\[[0-9;]*m/g, ''), 70)}`;
  const tidy = s.replace(/<\/?[a-z][\w-]*[^>]*>/gi, ' ')
    .replace(/(['"])(\/(?:Users|home|var|private|tmp|Volumes)\/[^'"]+)\1/g, (_, q, p) => `[${p.split('/').pop()}]`)
    .replace(/\/(?:Users|home|var|private|tmp|Volumes)\/\S+/g, (p) => p.split('/').pop());
  return oneLine(tidy) || '(empty)';
};
// `cd "/the/project" && S=/tmp/x npm test` reads as `npm test`.
const LEAD = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*|(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*)/;
export function commandName(cmd) {
  let c = String(cmd || '').trim();
  for (let i = 0; i < 8; i++) { const next = c.replace(LEAD, ''); if (next === c || !next) break; c = next; }
  return c;
}
// A path as you would say it: relative to the project, else from ~, and a
// long one by its last two parts.
const HOME = /^\/(?:Users|home)\/[^/]+(?=\/)/;
export function pathName(p, cwd) {
  if (!p) return '';
  if (cwd && (p.startsWith(cwd + '/') || p.startsWith(cwd + '\\'))) return p.slice(cwd.length + 1);
  if (!p.startsWith('/')) return p;
  const home = p.replace(HOME, '~');
  const parts = home.split('/');
  return home.length > 48 && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : home;
}
const short = (target, cwd) => {
  if (!target) return '';
  target = commandName(target);
  return /^[~/]/.test(target) && !/\s/.test(target) ? pathName(target, cwd) : (cwd ? target.split(cwd + '/').join('') : target);
};
const prettyTool = (name) => (name.startsWith('mcp__') ? name.slice(5).split('__').join(' › ') : name);

function group(id, name, t, extra = {}) {
  return { id, name, t, tok: 0, n: 0, turn: 0, kids: [], ...extra };
}
function sum(n) {
  if (!n.kids) return n;
  n.tok = 0; n.n = 0; n.turn = 0;
  for (const k of n.kids) {
    sum(k);
    n.tok += k.tok; n.n += k.kids ? k.n : 1; n.turn = Math.max(n.turn, k.turn || 0);
  }
  n.kids.sort((a, b) => b.tok - a.tok);
  return n;
}
const prune = (n) => { if (n.kids) { n.kids = n.kids.filter(k => !k.kids || (prune(k), k.kids.length)); } return n; };

// A leaf for one block; `how` is what deleting it does ({ act } or { lock }).
// The act carries this leaf's own tokens: a unit shown as several leaves adds
// up once.
function blockLeaf(b, tok, how, { name, t, warn }) {
  const leaf = { id: b.id, name, t, tok: tok(b.chars, b.kind), turn: b.turn, err: b.isError || undefined };
  if (how.lock) leaf.lock = how.lock;
  else {
    leaf.act = { ...how.act, save: leaf.tok };
    if (warn || how.warn) leaf.warn = how.warn || warn;
  }
  return leaf;
}

// Attachment types that are boot overhead (deleted through boot.js) or that
// Claude Code needs to rebuild the request; a task's hard delete leaves them.
const KEEP_ATTACH = new Set([...BOOT_ATTACH, 'prompt_snapshot']);

// What can be deleted, as whole units (see the header): unit key -> the
// records it names (the fork's planDrop adds what goes with them), and how
// each block of the resumed context is deleted.
function deletion(parsed, compacted) {
  const { byUuid } = parsed;
  const units = new Map();
  const put = (k, u) => { const l = units.get(k); if (l) l.push(u); else units.set(k, [u]); };
  const midOf = (o) => (o.message && o.message.id) || o.uuid;
  // tool steps: an assistant message that called a tool, by message id
  const stepOfMid = new Map(), stepOfCall = new Map();
  for (const u of parsed.order) {
    const o = byUuid.get(u);
    if (!o || o.type !== 'assistant' || o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) if (x && x.type === 'tool_use') { stepOfMid.set(midOf(o), `step:${midOf(o)}`); if (x.id) stepOfCall.set(x.id, `step:${midOf(o)}`); }
  }
  for (const u of parsed.order) {
    const o = byUuid.get(u);
    if (o && o.type === 'assistant' && stepOfMid.has(midOf(o))) put(stepOfMid.get(midOf(o)), u);
  }
  // tasks: from a message you typed to the next one, every record between
  const starts = [];
  for (const b of parsed.blocks) {
    if (!b.live || b.side || THINK.has(b.blockType)) continue;
    if (startsTask(b, byUuid.get(b.uuid) || {})) starts.push({ id: `g:task:${b.id}`, line: b.line });
  }
  const taskAt = (line) => {
    let lo = 0, hi = starts.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m].line <= line) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 ? starts[at].id : (compacted ? null : 'g:earlier');
  };
  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || !o.uuid || o.isSidechain || o.subtype === 'compact_boundary' || o.isCompactSummary) continue;
    if (o.type === 'attachment' && KEEP_ATTACH.has((o.attachment || {}).type)) continue;
    const t = taskAt(r.line);
    if (t) put(`task:${t}`, o.uuid);
  }
  const how = (b) => {
    if (!b.live) return { lock: 'Not sent on resume, so deleting it saves nothing.' };
    if (b.side) return { lock: b.lock || 'Sidechain record; it is not part of the main conversation.' };
    const rec = byUuid.get(b.uuid) || {};
    if (b.blockType === 'tool_use' || b.blockType === 'tool_result') {
      const k = b.blockType === 'tool_use' ? stepOfMid.get(midOf(rec)) : stepOfCall.get(b.tuid);
      return k ? { act: { k: 'drop', id: k } } : { lock: 'Its call is not in the resumed context, so it cannot go on its own.' };
    }
    if (rec.isCompactSummary) return { lock: 'The summary of everything before the compaction. Without it Claude forgets that whole history.' };
    if (b.role === 'assistant' && stepOfMid.has(midOf(rec))) return { act: { k: 'drop', id: stepOfMid.get(midOf(rec)) } };
    const c = rec.message && rec.message.content;
    if (b.blockType === 'image' && Array.isArray(c) && c.some(x => x && x.type !== 'image')) return { act: { k: 'img', id: b.id, fp: b.fp }, warn: 'Claude will no longer see this image; your words stay.' };
    const t = taskAt(b.line);
    if (!t) return { lock: 'Part of the turn the compaction left in place; it goes with an uncompact.' };
    return { act: { k: 'drop', id: `task:${t}`, task: `task:${t}` },
      warn: b.role === 'assistant' ? 'Claude\'s reply goes with its whole task: your message and everything done for it.' : 'Your message goes with its whole task: everything Claude did for it goes too.' };
  };
  return { units, how };
}

// Which copies a later turn made out of date: a file read or written again
// later, a command or search run again later. Walked backwards, so the first
// sighting of a file or command is its latest use.
const FILE_READ = new Set(['Read', 'NotebookRead']);
const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const RERUN = new Set(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
// The whole input of a call, as one comparable string (the target shown in the
// tree is cut to 120 characters, and two scripts can share their first 120).
function fullInputs(blocks) {
  const m = new Map();
  for (const b of blocks) if (b.blockType === 'tool_use' && b.tuid) m.set(b.tuid, b.text);
  return m;
}
function staleness(blocks) {
  const stale = new Map(), lastFile = new Map(), lastRun = new Map();
  const inputs = fullInputs(blocks);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b.live || b.side || !b.target || (b.blockType !== 'tool_use' && b.blockType !== 'tool_result')) continue;
    if (FILE_READ.has(b.tool) || FILE_WRITE.has(b.tool)) {
      const later = lastFile.get(b.target);
      if (later && ((b.blockType === 'tool_result' && FILE_READ.has(b.tool)) || (b.blockType === 'tool_use' && FILE_WRITE.has(b.tool))))
        stale.set(b.id, later.read ? `Out of date: read again at turn ${later.turn}` : `Out of date: the file changed at turn ${later.turn}`);
      if (b.blockType === 'tool_use') lastFile.set(b.target, { turn: b.turn, read: FILE_READ.has(b.tool) });
    } else if (RERUN.has(b.tool)) {
      const key = `${b.tool}::${inputs.get(b.tuid) || b.target}`, later = lastRun.get(key);
      if (later && b.blockType === 'tool_result') stale.set(b.id, `Out of date: ${b.tool === 'Bash' ? 'ran' : 'searched'} again at turn ${later}`);
      if (b.blockType === 'tool_use') lastRun.set(key, b.turn);
    }
  }
  return stale;
}

// The files a call touched: its file_path, or the paths a shell command names.
const EXT = 'js|mjs|cjs|jsx|ts|tsx|json|md|py|go|rs|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|css|scss|less|html|vue|svelte|yml|yaml|toml|ini|sh|zsh|sql|xml|gradle|txt|csv|proto|lock|env|png|jpg|jpeg|svg|pdf';
const PATHLIKE = new RegExp(`(?:[\\w.-]*/)*[\\w-][\\w.-]*\\.(?:${EXT})\\b`, 'g');
function filesOf(b) {
  if (FILE_READ.has(b.tool) || FILE_WRITE.has(b.tool)) return b.target ? [b.target] : [];
  if (b.tool !== 'Bash') return [];
  let cmd = '';
  try { cmd = JSON.parse(b.text).command || ''; } catch { return []; }
  // only the command lines, not the body of a heredoc
  const head = cmd.split(/<<-?\s*['"]?\w+['"]?/)[0] + ' ' + (cmd.match(/p\s*=\s*['"][^'"]+['"]/g) || []).join(' ');
  const out = new Set();
  for (const m of head.match(PATHLIKE) || []) out.add(m);
  return [...out].slice(0, 20);
}

const STEP_INFO = 'Deleting removes the call and what came back completely, with any other calls Claude made in the same message. Claude will not know it ran.';

// A shell command by what Claude said it does: Bash calls carry a one-line
// description ("Run the tests"), clearer than the command itself.
function callSays(call) {
  if (!call || call.tool !== 'Bash') return '';
  try { const d = JSON.parse(call.text).description; return typeof d === 'string' && d.trim() ? oneLine(d, 90) : ''; } catch { return ''; }
}
// The file a call names, whole (a block's target is cut at 120 characters).
function callPath(call, cwd) {
  if (!call || !(FILE_READ.has(call.tool) || FILE_WRITE.has(call.tool))) return '';
  try { const i = JSON.parse(call.text); return pathName(i.file_path || i.notebook_path || i.path || '', cwd); } catch { return ''; }
}

// What a tool call did, in words a developer would use.
function actionName(tool, target) {
  const t = target || '';
  switch (tool) {
    case 'Read': case 'NotebookRead': return `Read ${t}`;
    case 'Write': return `Wrote ${t}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Edited ${t}`;
    case 'Bash': return `Ran ${t}`;
    case 'Grep': return `Searched for ${t}`;
    case 'Glob': case 'LS': return `Listed ${t}`;
    case 'WebFetch': return `Fetched ${t}`;
    case 'WebSearch': return `Searched the web for ${t}`;
    case 'Agent': case 'Task': return `Subagent: ${t}`;
    case 'Skill': return `Used skill ${t}`;
    case 'ToolSearch': return `Loaded tools ${t}`;
    case 'TodoWrite': return 'Updated the todo list';
    case 'AskUserQuestion': return t ? `Asked you: ${t}` : 'Asked you a question';
    default: return `${prettyTool(tool || 'tool')}${t ? ` ${t}` : ''}`;
  }
}

// Wrappers Claude Code puts around things you did not type as a request.
const SYSTEM_WRAP = /^<(command-name|command-message|command-args|local-command-|system-reminder|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|post-tool-use-hook)/;

// A message you typed that starts a new piece of work (not a slash command,
// its output, a reminder, a "continue", or the compaction summary).
function startsTask(b, rec) {
  if (b.role !== 'user' || b.blockType !== 'text' || rec.isMeta || rec.isCompactSummary) return false;
  const t = b.text.trim();
  if (!t || SYSTEM_WRAP.test(t) || /^\[Request interrupted/i.test(t)) return false;
  if (/^(continue|go on|go ahead|proceed|yes|yep|ok|okay|k|y|next|more|do it|sure|go+|lets go|let's go|yes please|please continue)\b[.!\s]*$/i.test(t)) return false;
  // one or two words ("fix it", "goooo") carry on the work before them
  return !(t.length <= 16 && t.split(/\s+/).length <= 2);
}

// The same leaves, organised the way you remember the session: setup, then one
// folder per thing you asked for, holding everything Claude did for it. A tool
// call and its result become one item ("Read src/app.js"). Each task says when
// it was, which files it touched, and when anything later last mentioned them.
function taskTree({ parsed, cwd, leafOf, setup, attachLeaves, compacted }) {
  const root = group('root', 'Resumed context', 'root');
  const earlier = group('g:earlier', compacted ? 'Before the compaction' : 'Start of the session', 'task',
    { info: compacted ? 'Claude sees this part only as a summary written when the session compacted.' : 'Messages from before your first request.' });
  const tasks = [];
  const resByTuid = new Map();
  for (const b of parsed.blocks) if (b.live && !b.side && b.blockType === 'tool_result' && b.tuid) resByTuid.set(b.tuid, b);
  const paired = new Set();
  let cur = null;
  const touch = (g, b) => { g.endLine = Math.max(g.endLine || 0, b.line); };
  const action = (call, res) => {
    const cl = call && leafOf.get(call.id), rl = res && leafOf.get(res.id);
    const base = call || res;
    // the call's and the result's shares of one step
    const acts = [];
    for (const a of [...((cl && cl.acts) || []), ...((rl && rl.acts) || [])]) {
      const same = acts.find(x => x.id === a.id && x.k === a.k);
      if (same) same.save += a.save || 0; else acts.push({ ...a });
    }
    const said = call && callSays(call);
    let target = callPath(call, cwd) || short(base.target, cwd);
    if (!target && call) {
      try {
        const inp = JSON.parse(call.text);
        target = inp.skill || inp.name || (Array.isArray(inp.questions) && inp.questions[0] && inp.questions[0].question) || '';
        target = oneLine(target, 80);
      } catch { /* keep empty */ }
    }
    const leaf = {
      id: `s:${base.id}`, name: said || actionName(base.tool, target), t: rl ? rl.t : 'call',
      tok: (cl ? cl.tok : 0) + (rl ? rl.tok : 0), turn: base.turn, acts, blocks: [call && call.id, res && res.id].filter(Boolean),
    };
    if (res && res.isError) leaf.err = true;
    const st = (rl && rl.stale) || (cl && cl.stale);
    if (st) leaf.stale = st;
    if (!acts.length) leaf.lock = (rl && rl.lock) || (cl && cl.lock) || 'Nothing here can be deleted.';
    else leaf.info = STEP_INFO;
    return leaf;
  };
  for (const b of parsed.blocks) {
    if (!b.live || b.side || THINK.has(b.blockType)) continue;
    const rec = parsed.byUuid.get(b.uuid) || {};
    if (startsTask(b, rec)) {
      cur = group(`g:task:${b.id}`, msgName(b.text), 'task', { ts: b.ts, from: b.turn, ask: b.text.slice(0, 700), files: new Set() });
      tasks.push(cur);
    }
    const into = rec.isCompactSummary ? earlier : (cur || earlier);
    touch(into, b);
    if (b.blockType === 'tool_use') {
      const res = resByTuid.get(b.tuid);
      if (res) paired.add(res.id);
      const leaf = action(b, res);
      leaf._line = b.line;
      if (into.files) for (const f of filesOf(b)) into.files.add(f);
      into.kids.push(leaf);
      continue;
    }
    if (b.blockType === 'tool_result') { if (!paired.has(b.id)) into.kids.push({ ...action(null, b), _line: b.line }); continue; }
    const l = leafOf.get(b.id);
    if (!l) continue;
    const copy = { ...l, _line: b.line };
    if (rec.isCompactSummary) copy.name = 'Summary of everything before the compaction';
    else if (l.t === 'prompt' && rec.isMeta) {
      const skill = b.text.match(/^Base directory for this skill:\s*\S*?([^/\s]+)\s/);
      copy.name = skill ? `Skill instructions: ${skill[1]}` : `Added by Claude Code: ${l.name}`;
    } else if (l.t === 'prompt') copy.name = `You: ${l.name}`;
    else if (l.t === 'reply') { copy.name = `Claude: ${l.name}`; into.outcome = b.text.slice(0, 600); }
    into.kids.push(copy);
  }
  // attachments go to the task they arrived in
  for (const { leaf, line } of attachLeaves) {
    let into = earlier;
    for (const t of tasks) { if (t.kids.length && firstLine(t, parsed) <= line) into = t; else if (firstLine(t, parsed) > line) break; }
    into.kids.push({ ...leaf, _line: line });
  }
  // story order: an attachment sits where it arrived, not after everything
  for (const t of [earlier, ...tasks]) {
    t.kids.sort((a, b) => (a._line ?? 0) - (b._line ?? 0));
    for (const k of t.kids) delete k._line;
  }

  // When did anything after a task last mention the files it touched?
  const base = (p) => p.split(/[\\/]/).pop();
  // Only files few tasks share say anything about one task: index.html is
  // mentioned everywhere, notes-store.cjs only by the task that wrote it.
  const spread = new Map();
  for (const t of tasks) for (const n of new Set([...t.files].map(f => base(f).toLowerCase()))) spread.set(n, (spread.get(n) || 0) + 1);
  const limit = Math.max(2, Math.ceil(tasks.length * 0.2));
  const names = new Set([...spread].filter(([n, c]) => n.length >= 4 && c <= limit).map(([n]) => n));
  const lastSeen = new Map();
  for (const b of parsed.blocks) {
    if (!b.live || b.side || !((b.blockType === 'text') || b.blockType === 'tool_use')) continue;
    const text = (b.blockType === 'tool_use' ? b.target : b.text).toLowerCase();
    for (const w of text.match(/[\w.-]{4,}/g) || []) if (names.has(w)) lastSeen.set(w, { line: b.line, turn: b.turn });
  }
  for (const t of tasks) {
    let ref = 0;
    for (const f of t.files) { const k = base(f).toLowerCase(); const s = names.has(k) && lastSeen.get(k); if (s && s.line > t.endLine) ref = Math.max(ref, s.turn); }
    t.ownFiles = [...t.files].some(f => names.has(base(f).toLowerCase()));
    t.lastRef = ref || undefined;
    t.files = [...t.files].map(f => short(f, cwd)).slice(0, 12);
    delete t.endLine;
  }
  delete earlier.endLine;
  root.kids.push(setup, earlier, ...tasks);
  // story order, kept for the UI's chronological sort (sum() sorts by size)
  root.kids.forEach((k, i) => { k.ord = i; });
  for (const t of [earlier, ...tasks]) t.kids.forEach((k, i) => { k.ord = i; });
  prune(root); sum(root);
  if (tasks.length) tasks[tasks.length - 1].latest = true;
  return root;
}
const firstLineCache = new WeakMap();
function firstLine(task, parsed) {
  let v = firstLineCache.get(task);
  if (v === undefined) {
    const id = task.id.slice('g:task:'.length);
    const b = parsed.blocks.find(x => x.id === id);
    v = b ? b.line : 0;
    firstLineCache.set(task, v);
  }
  return v;
}

// The map of one parsed session: the tree by type, the tree by task, and what
// the file holds that resume does not load. Pure: the caller parses (from a
// transcript in Node, from the live messages in the mod) and supplies the
// token estimator.
export function buildMap(parsed, { tok, sid = '', cwd = '', title = '', project = '', bytes = 0, setupItems = [] }) {
  const byUuid = parsed.byUuid;
  const stale = staleness(parsed.blocks);
  const leafOf = new Map(), attachLeaves = [];
  const si = structureInfo(parsed);
  const { units, how } = deletion(parsed, !!si.compaction);

  // ---- resumed context
  const root = group('root', 'Resumed context', 'root');

  const setup = group('g:boot', 'Setup', 'boot', { info: 'Loaded before your first message: system prompt, tool schemas, MCP servers, skills, agents and CLAUDE.md.' });
  const bootGroups = new Map();
  for (const it of bootInventory(parsed)) {
    const t = BOOT_TYPE[it.kind] || 'sys';
    let g = bootGroups.get(it.sub);
    if (!g) { g = group(`g:boot:${it.sub}`, it.sub === BOOT_SUB.md ? 'CLAUDE.md & memory' : it.sub.replace(/^./, c => c.toUpperCase()), t); bootGroups.set(it.sub, g); setup.kids.push(g); }
    const leaf = { id: `boot:${it.id}`, name: it.kind === 'md' ? short(it.name, cwd) : (it.display || it.name), t, tok: tok(it.chars, 'attach'), turn: 0 };
    if (it.kind === 'mcp' && it.tools && it.tools.length) leaf.sub = `${it.tools.length} tool${it.tools.length === 1 ? '' : 's'} · ${it.source}`;
    if (it.kind === 'md' && it.mdType) leaf.sub = it.mdType === 'AutoMem' ? 'auto memory' : `${it.mdType.toLowerCase()} instructions`;
    if (it.removable) {
      leaf.act = { k: 'boot', id: it.id, save: leaf.tok };
      leaf.info = [it.how, it.lasts && `Lasts: ${it.lasts}`].filter(Boolean).join('\n');
      if (it.warn) leaf.warn = it.warn;
      if (it.needs && Object.keys(it.needs).length) leaf.profile = true;
    } else leaf.lock = it.reason || 'Cannot be removed.';
    g.kids.push(leaf);
  }

  // Sizes the caller knows from elsewhere (the mod: Claude Code's own usage
  // categories), shown so the map adds up to the whole window. Not editable here.
  for (const it of setupItems) {
    setup.kids.push({ id: `boot:${it.id}`, name: it.name, t: it.t || 'sys', tok: Math.max(0, Math.round(it.tok || 0)), turn: 0,
      lock: it.lock || 'Loaded by Claude Code before the conversation; ctxtree does not edit it live yet.' });
  }

  const results = group('g:results', 'Tool results', 'results', { info: `What tools returned. ${STEP_INFO}` });
  const conv = group('g:conv', 'Conversation', 'conv');
  const prompts = group('g:prompts', 'Your messages', 'prompt', { info: 'A message of yours goes with its whole task: everything Claude did for it goes too, and nothing of it is left in the fork.' });
  const replies = group('g:replies', 'Claude\'s replies', 'reply', { info: 'What Claude said goes with the tool step it belongs to, or, for its last words on a task, with the whole task.' });
  const calls = group('g:calls', 'Tool calls', 'call', { info: `What Claude sent to tools. ${STEP_INFO}` });
  const images = group('g:images', 'Images', 'image');
  conv.kids.push(prompts, replies, calls, images);

  const byTool = new Map(), byTarget = new Map(), callsByTool = new Map();
  const callOf = new Map();
  for (const b of parsed.blocks) if (b.blockType === 'tool_use' && b.tuid) callOf.set(b.tuid, b);
  for (const b of parsed.blocks) {
    if (!b.live || b.side || b.blockType === 'thinking' || b.blockType === 'redacted_thinking') continue;
    if (b.blockType === 'tool_result') {
      const name = b.tool || 'unknown tool';
      let tg = byTool.get(name);
      if (!tg) { tg = group(`g:r:${name}`, prettyTool(name), `r:${name}`); byTool.set(name, tg); results.kids.push(tg); }
      const call = callOf.get(b.tuid);
      const target = callSays(call) || callPath(call, cwd) || short(b.target, cwd) || '(no input)';
      const key = `${name}::${target}`;
      const leaf = blockLeaf(b, tok, how(b), { name: target, t: `r:${name}` });
      leaf.sub = `turn ${b.turn}`;
      if (stale.has(b.id)) leaf.stale = stale.get(b.id);
      leafOf.set(b.id, leaf);
      const prev = byTarget.get(key);
      if (!prev) { byTarget.set(key, { tg, leaf }); tg.kids.push(leaf); continue; }
      // a second result for the same target: the target becomes a folder of runs
      if (!prev.folder) {
        const f = group(`g:r:${key}`, target, `r:${name}`);
        tg.kids.splice(tg.kids.indexOf(prev.leaf), 1, f);
        prev.leaf.name = `turn ${prev.leaf.turn}`; delete prev.leaf.sub;
        f.kids.push(prev.leaf); prev.folder = f;
      }
      leaf.name = `turn ${b.turn}`; delete leaf.sub;
      prev.folder.kids.push(leaf);
      continue;
    }
    if (b.blockType === 'tool_use') {
      let cg = callsByTool.get(b.tool);
      if (!cg) { cg = group(`g:c:${b.tool}`, prettyTool(b.tool), 'call'); callsByTool.set(b.tool, cg); calls.kids.push(cg); }
      const leaf = blockLeaf(b, tok, how(b), { name: callSays(b) || callPath(b, cwd) || short(b.target, cwd) || prettyTool(b.tool), t: 'call' });
      leaf.sub = `turn ${b.turn}`;
      if (stale.has(b.id)) leaf.stale = stale.get(b.id);
      leafOf.set(b.id, leaf);
      cg.kids.push(leaf);
      continue;
    }
    if (b.kind === 'image') {
      const leaf = blockLeaf(b, tok, how(b), { name: `image · turn ${b.turn}`, t: 'image', warn: 'Claude will no longer see this image.' });
      leafOf.set(b.id, leaf);
      images.kids.push(leaf);
      continue;
    }
    if (b.blockType !== 'text' || !b.text.trim()) continue;
    const rec = byUuid.get(b.uuid) || {};
    if (b.role === 'user') {
      const summary = !!rec.isCompactSummary;
      prompts.kids.push(blockLeaf(b, tok, how(b), { name: summary ? 'Compaction summary' : msgName(b.text), t: 'prompt' }));
      prompts.kids[prompts.kids.length - 1].sub = `turn ${b.turn}`;
      leafOf.set(b.id, prompts.kids[prompts.kids.length - 1]);
    } else {
      replies.kids.push(blockLeaf(b, tok, how(b), { name: msgName(b.text), t: 'reply' }));
      replies.kids[replies.kids.length - 1].sub = `turn ${b.turn}`;
      leafOf.set(b.id, replies.kids[replies.kids.length - 1]);
    }
  }

  // Attachments Claude Code records mid-conversation (file snapshots, hook
  // output, todo and plan reminders): each one can go on its own.
  const other = group('g:attach', 'Other attachments', 'attach', { info: 'Recorded by Claude Code mid-session: changed-file snapshots, hook output, reminders. Deleting one removes it from the fork; Claude Code adds some kinds (environment, date) again when you resume.' });
  const byAttach = new Map();
  for (const r of parsed.rows) {
    const o = r.rec;
    if (!o || o.type !== 'attachment' || !o.uuid || !parsed.live.has(o.uuid)) continue;
    const a = o.attachment || {};
    if (BOOT_ATTACH.has(a.type) || !Array.isArray(o.rendered)) continue;
    const chars = o.rendered.reduce((n, x) => n + (typeof (x && x.content) === 'string' ? x.content.length : 0), 0);
    if (!chars) continue;
    const type = a.type || 'attachment';
    let g = byAttach.get(type);
    if (!g) { g = group(`g:a:${type}`, type.replace(/_/g, ' '), 'attach'); byAttach.set(type, g); other.kids.push(g); }
    const name = short(a.filename || a.path || (a.content && a.content.path) || '', cwd) || type.replace(/_/g, ' ');
    const leaf = { id: `a:${o.uuid}`, name, t: 'attach', tok: tok(chars, 'attach'), turn: 0 };
    leaf.act = { k: 'drop', id: `att:${o.uuid}`, save: leaf.tok };
    units.set(`att:${o.uuid}`, [o.uuid]);
    g.kids.push(leaf);
    const { act, ...copy } = leaf;
    attachLeaves.push({ leaf: { ...copy, acts: [{ ...act }], name: `Attachment: ${name}` }, line: r.line });
  }

  root.kids.push(setup, results, conv, other);
  prune(root); sum(root);
  // every leaf carries a list of actions (a task-view item can hold two)
  const acts = (n) => { if (n.kids) return n.kids.forEach(acts); n.acts = n.act ? [n.act] : []; delete n.act; };
  acts(root);
  const tasks = taskTree({ parsed, cwd, leafOf, setup, attachLeaves, compacted: !!si.compaction });

  // ---- not resumed: what the file holds but `claude --resume` does not load
  const grey = group('grey', 'Not in resumed context', 'grey', { info: 'Kept in the file but not sent when you resume. Deleting it saves no tokens; these actions restore it or drop it from the fork\'s file.' });
  const SLIM = { op: 'slim', label: 'Remove all of this from the fork\'s file', note: 'Saves disk, not tokens: none of it is sent on resume.' };
  const deadLeaf = (b) => ({ id: `d:${b.id}`,
    name: b.blockType === 'tool_result' || b.blockType === 'tool_use'
      ? `${prettyTool(b.tool || 'tool')}${b.blockType === 'tool_use' ? ' call' : ''} · ${short(b.target, cwd) || 'result'}` : msgName(b.text),
    t: b.blockType === 'tool_result' ? `r:${b.tool || 'unknown tool'}` : (b.blockType === 'tool_use' ? 'call' : (b.role === 'user' ? 'prompt' : 'reply')),
    tok: tok(b.chars, b.kind), turn: b.turn, acts: [], lock: 'Not sent on resume, so deleting it saves nothing.' });
  const dead = parsed.blocks.filter(b => !b.live && !b.side && b.blockType !== 'thinking' && b.blockType !== 'redacted_thinking');

  if (si.compaction) {
    const pre = group('g:compacted', `Before the compaction`, 'grey', {
      info: `Summarised away when the session compacted${si.compaction.trigger ? ` (${si.compaction.trigger})` : ''}. Claude sees only the summary.`,
      ops: [
        si.compaction.restorable && { op: 'uncompact', label: 'Restore into context (uncompact)', note: 'Puts the original conversation back in place of the summary. Adds these tokens back.' },
        SLIM,
      ].filter(Boolean),
    });
    for (const b of dead) if (b.deadKind === 'compacted') pre.kids.push(deadLeaf(b));
    grey.kids.push(pre);
  }
  const tips = new Set();
  for (const br of si.branches) {
    tips.add(br.tip);
    const g = group(`g:branch:${br.tip}`, `Rewound: “${oneLine(br.firstText, 60) || 'branch'}”`, 'grey', {
      info: 'A timeline you rewound away from. It stays in the file, but resume follows the newer one.',
      ops: [{ op: 'switch', tip: br.tip, label: 'Switch to this branch', note: 'The fork resumes this timeline instead of the current one.' }, SLIM],
    });
    for (const b of dead) if (b.deadKind === 'branch' && b.branchTip === br.tip) g.kids.push(deadLeaf(b));
    grey.kids.push(g);
  }
  const stray = group('g:stray', 'Interrupted or retried calls', 'grey', { info: 'Results of calls that were interrupted or retried. Nothing resumes them.', ops: [SLIM] });
  for (const b of dead) if (b.deadKind === 'branch' && !tips.has(b.branchTip)) stray.kids.push(deadLeaf(b));
  grey.kids.push(stray);
  prune(grey); sum(grey);

  const turns = parsed.turns;
  const peak = tok.measured || 0;
  const map = {
    sid, title, project, cwd, turns,
    window: peak > 200_000 || root.tok > 200_000 ? 1_000_000 : 200_000,
    measured: peak, bytes,
    tree: root, tasks, grey,
  };
  // What each drop act names, for the fork writer; not sent to a browser.
  Object.defineProperty(map, 'units', { value: units });
  return map;
}

// The records a set of marked drop acts names, for the fork writer. A unit the
// map no longer has (the session moved on, or a stale page) is refused.
export function dropRecs(map, keys) {
  const recs = new Set(), missing = [];
  for (const k of new Set(keys || [])) {
    const l = map.units && map.units.get(k);
    if (!l) missing.push(k); else for (const u of l) recs.add(u);
  }
  if (missing.length) throw new ForkError(`${missing.length} marked item(s) are no longer in this session. Reload it and mark again.`, missing.map(id => ({ id, error: 'Not in this session any more.' })));
  return [...recs];
}

// What a block says, for the inspector: the first PREVIEW_CHARS characters,
// or a slice of them (`offset`, `limit`; Infinity for the rest), so a 2 MB
// Read loads only when someone asks for all of it.
export function previewBlock(parsed, tok, id, { offset = 0, limit = PREVIEW_CHARS } = {}) {
  const raw = String(id || '').replace(/^d:/, '');
  const b = parsed.blocks.find(x => x.id === raw);
  if (!b) throw new ForkError('No such block in this session.');
  return {
    id, tool: b.tool, target: b.target, role: b.role, kind: b.kind, turn: b.turn, live: b.live,
    tok: tok(b.chars, b.kind), isError: b.isError, ts: b.ts,
    ...sliceText(b.text, { offset, limit }),
  };
}

// A task's timeline (timeline.js) over a parsed session.
export function taskTimeline(parsed, tasks, id, opts) {
  let task = null;
  const walk = (n) => { if (task) return; if (n.id === id) task = n; else for (const k of n.kids || []) walk(k); };
  walk(tasks);
  if (!task || task.t !== 'task') throw new ForkError('No such task in this session.');
  const byId = new Map(parsed.blocks.map(b => [b.id, b]));
  return timelineOf(task, (bid) => byId.get(bid), opts);
}

export function sessionTitle(s) {
  // (not a wrapper, a compaction summary, or the note an older ctxtree fork left)
  const ok = (x) => x.text && !/^\s*</.test(x.text) && !/^This session is being continued from a previous conversation/.test(x.text) && !/^\[ctxtree: removed/.test(x.text);
  const p = (s.prompts || []).find(x => x.real && ok(x)) || (s.prompts || []).find(ok);
  return p ? oneLine(p.text, 80) : '';
}
