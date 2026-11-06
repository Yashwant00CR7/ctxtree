// ctxtree core: the map of this session's context, the one plan that the pane
// and Claude both edit, Claude's tools, and Apply.
//
// The map is read from the session's own transcript, the file `claude --resume`
// reads, so it is the same map the web UI shows and every mark names exactly
// what the fork writer deletes. Apply never changes the running conversation:
// it writes a verified fork of it (core/fork.js, the server's own builder),
// records it where the web UI lists forks, and opens it in a new vTower tab.
// It runs only on a press in ctxtree-ui; Claude can stage, never apply.
//
// Every engine call is spelled `$.noun.method(...)` inside a hook (the engine
// requires it), so the logic lives in pure helpers that take and return data.
// The $.ctxtree noun's methods are answered by this module's own hooks on
// `ctxtree.<method>`, which have their `$`.
import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'
import type {
  Ctxtree, CtxtreeEntry, CtxtreePlan, CtxtreeStatus, CtxtreeView, CtxtreeDetails, CtxtreeReview, CtxtreeType,
  CtxtreeTimelineArgs, CtxtreeTimelineEntry, CtxtreeFork,
} from '../types'
import { parseSession } from '../core/session.js'
import { buildMap, anchorScale, dropRecs, sessionTitle } from '../core/map.js'
import { tokensOf, DEFAULT_RATIOS } from '../core/tokens.js'
import { makeFork, resumeCommand, forkNote, vtowerLink } from '../core/fork.js'
import { flatten, windowOf, index, actsUnder, markState, actKey, fmtTok } from '../core/view.js'
import { timelineOf, sliceText, PREVIEW_CHARS } from '../core/timeline.js'
import { layout, paint, hitTest, cellsBase64, assignColors, colorOf } from '../core/treemap.js'

const PLAN0: CtxtreePlan = { entries: [] }
const STATUS0: CtxtreeStatus = { version: 0, tokens: 0, window: 0, turns: 0, busy: false, applying: 'idle', lastApply: null, error: '' }
const plan = atom({ plugin: 'ctxtree', key: 'plan' } as const, PLAN0)
const status = atom({ plugin: 'ctxtree', key: 'status' } as const, STATUS0)

const PREVIEW = 6000
const CAL = { ratios: DEFAULT_RATIOS as Record<string, number> }
const VTOWER = ['/Applications/vTower.app']

type Act = { k: string; id: string; fp?: string; task?: string; save?: number }
type Node = { id: string; name: string; t: string; tok: number; turn?: number; kids?: Node[]; acts?: Act[]; blocks?: string[]; info?: string; warn?: string; lock?: string; stale?: unknown }
type Index = { byId: Map<string, Node>; parent: Map<string, Node> }
type Tok = ((chars: number, kind: string) => number) & { measured?: number }
type Live = {
  file: string; size: number; map: any; tok: Tok; version: number; title: string
  blocks: Map<string, any>; idx: Record<CtxtreeView, Index>; colors: Record<string, number>; layouts: Map<string, any>
  acts: Map<string, { act: Act; leaf: Node }>
  // a task's every action, and the task each action can only go with
  taskActs: Map<string, { act: Act; leaf: Node }[]>; keyTask: Map<string, string>
}

let live: Live | null = null
let version = 0
let planMem: CtxtreePlan = PLAN0
let sid = ''
let home = ''
let cfg = ''
let transcript = ''

// ------------------------------------------------------------ pure helpers
const rootOf = (L: Live, view: CtxtreeView): Node => (view === 'task' ? L.map.tasks : L.map.tree)
const nodeOf = (L: Live, id: string): Node | undefined => L.idx.task.byId.get(id) || L.idx.type.byId.get(id)
const oneLine = (t: string, n = 80) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
const errText = (err: unknown) => String((err as Error)?.message || err)
const marksOf = () => new Set(planMem.entries.map(e => e.key))
const errorsOf = (err: any): string[] => (err && Array.isArray(err.problems) && err.problems.length
  ? [err.message, ...err.problems.slice(0, 6).map((p: any) => p.error || String(p))] : [errText(err)])

// Tokens anchored to the size Claude Code measured for the last reply, as the
// web server anchors them (map.js anchorScale).
function tokFor(parsed: any): Tok {
  const a = anchorScale(CAL, parsed)
  const raw = (chars: number, kind: string) => (kind === 'image' ? tokensOf(0, 'image', CAL) : chars / (CAL.ratios[kind] || 4))
  const scale = a ? a.scale : 1
  const fn: Tok = (chars, kind) => (kind === 'image' ? Math.round(raw(0, 'image')) : Math.max(1, Math.round(raw(chars, kind) * scale)))
  fn.measured = a ? a.measured : 0
  return fn
}

function liveFrom(raw: string, file: string, size: number, cwd: string): Live {
  const parsed = parseSession(raw)
  const tok = tokFor(parsed)
  const title = sessionTitle({ prompts: parsed.blocks.filter((b: any) => b.live && b.role === 'user' && b.blockType === 'text').map((b: any) => ({ text: b.text, real: true })) })
  const map = buildMap(parsed, { tok, sid, cwd, title, bytes: size } as any)
  const acts = new Map<string, { act: Act; leaf: Node }>()
  const each = (n: Node) => { if (n.kids) return n.kids.forEach(each); for (const a of n.acts || []) if (!acts.has(actKey(a))) acts.set(actKey(a), { act: a, leaf: n }) }
  each(map.tree); each(map.tasks)
  const taskActs = new Map<string, { act: Act; leaf: Node }[]>(), keyTask = new Map<string, string>()
  const tasks = (n: Node) => {
    if (!n.kids) return
    if (n.t !== 'task') return n.kids.forEach(tasks)
    const under = actsUnder(n) as { act: Act; leaf: Node }[]
    const tk = `task:${n.id}`
    if (!under.some(x => actKey(x.act) === tk)) return
    taskActs.set(tk, under)
    for (const x of under) if (actKey(x.act) !== tk) keyTask.set(actKey(x.act), tk)
  }
  tasks(map.tasks)
  version++
  return {
    file, size, map, tok, title, version, acts, taskActs, keyTask,
    blocks: new Map(parsed.blocks.map((b: any) => [b.id, b])),
    idx: { task: index(map.tasks), type: index(map.tree) },
    colors: assignColors(map.tree), layouts: new Map(),
  }
}

// Plan entries for the actions under the given map ids. Your messages and
// Claude's last words go only with their task, so they bring the whole task.
function entriesFor(L: Live, ids: string[], by: 'you' | 'claude') {
  const byKey = new Map<string, CtxtreeEntry>(), skipped: string[] = []
  const add = ({ act, leaf }: { act: Act; leaf: Node }) => {
    const key = actKey(act)
    const had = byKey.get(key)
    if (had) { had.save += act.save || 0; had.tok += leaf.tok || 0; return }
    const e: CtxtreeEntry = { key, k: act.k as CtxtreeEntry['k'], id: act.id, by, name: leaf.name, t: leaf.t, tok: leaf.tok || 0, save: act.save || 0 }
    if (act.fp) e.fp = act.fp
    if (act.task) { e.task = act.task; e.name = (nodeOf(L, act.task.slice(5)) || leaf).name }
    byKey.set(key, e)
  }
  for (const id of ids) {
    const n = nodeOf(L, id)
    if (!n) { skipped.push(`${id}: no such item in the map`); continue }
    const under = actsUnder(n) as { act: Act; leaf: Node }[]
    if (!under.length) { skipped.push(`${n.name}: ${n.lock || 'nothing here can be deleted'}`); continue }
    for (const x of under) {
      add(x)
      if (x.act.task) for (const y of L.taskActs.get(x.act.task) || []) add(y)
    }
  }
  return { entries: [...byKey.values()], skipped }
}

function mergeEntries(base: CtxtreeEntry[], add: CtxtreeEntry[]) {
  const byKey = new Map(base.map(e => [e.key, e]))
  for (const e of add) byKey.set(e.key, e)
  return [...byKey.values()]
}

// Taking keys out of the plan: a part of a task keeps the task.
function withoutKeys(L: Live | null, entries: CtxtreeEntry[], keys: Iterable<string>) {
  const out = new Set(keys)
  if (L) for (const k of [...out]) { const t = L.keyTask.get(k); if (t) out.add(t) }
  const tasks = new Set(entries.filter(e => out.has(e.key) && e.task === e.key).map(e => e.key))
  return entries.filter(e => !out.has(e.key) && !(e.task && tasks.has(e.task)))
}

// The plan checked against the map as it now stands: what the session no
// longer has is flagged, not dropped.
function recheck(L: Live): CtxtreePlan | null {
  const entries = planMem.entries.map(e => ({ ...e, problem: L.acts.has(e.key) ? undefined : 'Not in this session any more.' }))
  return entries.some((e, i) => e.problem !== planMem.entries[i]?.problem) ? { entries } : null
}

function markedLeafIds(L: Live, view: CtxtreeView) {
  const marks = marksOf()
  const out = new Set<string>()
  const walk = (n: Node) => {
    if (n.kids) return n.kids.forEach(walk)
    const acts = n.acts || []
    if (acts.length && acts.every(a => marks.has(actKey(a)))) out.add(n.id)
  }
  walk(rootOf(L, view))
  return out
}

function layoutFor(L: Live, view: CtxtreeView, columns: number, rows: number) {
  const k = `${view}:${columns}x${rows}`
  let lay = L.layouts.get(k)
  if (!lay) { lay = layout(rootOf(L, view), columns, rows); L.layouts.set(k, lay) }
  return lay
}

// What a leaf says: a task item's call and result, else the block itself.
function previewOf(L: Live, n: Node) {
  if (n.kids) return ''
  const parts: string[] = []
  for (const id of n.blocks || [n.id]) {
    const b = L.blocks.get(id)
    if (b) parts.push(b.blockType === 'tool_use' ? `${b.tool} input:\n${b.text}` : b.text)
  }
  return parts.join('\n\n— — —\n\n')
}

function typesOf(L: Live, view: CtxtreeView): CtxtreeType[] {
  const by = new Map<string, CtxtreeType>()
  const walk = (n: Node) => {
    if (n.kids) return n.kids.forEach(walk)
    const t = by.get(n.t) || { t: n.t, name: '', tok: 0, n: 0, color: colorOf(L.colors, n.t) }
    t.tok += n.tok || 0; t.n++
    by.set(n.t, t)
  }
  walk(rootOf(L, view))
  const label: Record<string, string> = { sys: 'System & setup', tools: 'Built-in tools', mcp: 'MCP servers', skill: 'Skills', agent: 'Agents', md: 'CLAUDE.md & memory', prompt: 'Your messages', reply: 'Claude’s replies', call: 'Tool calls', image: 'Images', attach: 'Attachments' }
  const pretty = (t: string) => label[t] || (t.startsWith('r:') ? `${t.slice(2).replace(/^mcp__/, '').split('__').join(' › ')} results` : t)
  return [...by.values()].map(t => ({ ...t, name: pretty(t.t) })).sort((x, y) => y.tok - x.tok)
}

function detailsOf(L: Live, id: string): CtxtreeDetails {
  const n = nodeOf(L, id)
  if (!n) return { id, name: '', kind: '', tok: 0, turn: 0, info: '', warn: '', lock: '', stale: '', preview: '', truncated: false, path: [] }
  const path: string[] = []
  const parentOf = (x: string) => L.idx.task.parent.get(x) || L.idx.type.parent.get(x)
  for (let p = parentOf(n.id); p && p.id !== 'root'; p = parentOf(p.id)) path.unshift(p.name)
  const pv = previewOf(L, n)
  const st: any = n.stale
  return {
    id: n.id, name: n.name, kind: n.t, tok: n.tok || 0, turn: n.turn || 0, info: n.info || '', warn: n.warn || '', lock: n.lock || '',
    stale: st ? (typeof st === 'string' ? st : String(st.why || st.reason || 'A later turn made this out of date.')) : '', preview: pv.slice(0, PREVIEW), truncated: pv.length > PREVIEW, path,
  }
}

// What the pane's Details reads: a task as it happened, or one item on its
// own. Open tool calls carry their text (all of it for the ones in `all`).
function timelineFor(L: Live, a: CtxtreeTimelineArgs): CtxtreeTimelineEntry[] {
  const n = nodeOf(L, a.id)
  if (!n) return []
  let task: any = n
  if (n.t !== 'task') {
    if (n.kids) return []
    // a by-type leaf is one block: show it as the call or result it is
    const b: any = L.blocks.get(n.id)
    const leaf = !n.blocks && b && (b.blockType === 'tool_use' || b.blockType === 'tool_result') ? { ...n, blocks: [n.id] } : n
    task = { kids: [{ ...leaf, ord: 0 }] }
  }
  const blockOf = (id: string) => L.blocks.get(id)
  const open = new Set(a.open), all = new Set(a.all)
  const entries = timelineOf(task, blockOf) as CtxtreeTimelineEntry[]
  const marks = marksOf()
  // (a run of attachments shown as one entry is marked as the run)
  const stateOf = (id: string) => { const k = nodeOf(L, id) || (task.kids || []).find((x: Node) => x.id === id); return k ? markState(k, marks) : '' }
  for (const e of entries) {
    const ids: string[] = (e as any).ids || [e.id]
    const st = ids.map(stateOf)
    e.mark = st.every(x => x === 'all') ? 'all' : st.some(x => x) ? 'some' : ''
  }
  for (const e of entries) {
    if (e.kind !== 'tool' || !open.has(e.id) || !e.parts) continue
    for (const p of e.parts) {
      const b: any = blockOf(p.id)
      const sl = sliceText(b ? b.text : '', { limit: all.has(e.id) ? Infinity : PREVIEW_CHARS })
      p.text = sl.text
      p.next = sl.next
    }
  }
  for (const e of entries) if ((e.kind === 'prompt' || e.kind === 'reply') && e.truncated && all.has(e.id)) {
    const b: any = blockOf(e.id)
    if (b) { e.text = b.text; e.truncated = false }
  }
  return entries
}

function mapText(L: Live, view: CtxtreeView, under: string, limit: number, window: number) {
  const root = under ? nodeOf(L, under) : rootOf(L, view)
  if (!root) return `No item ${under} in the map. Call map again without "under".`
  const marks = marksOf()
  const lines: string[] = []
  const head = `ctxtree map · ~${fmtTok(L.map.tree.tok)} tokens resumed from this session (window ${fmtTok(window || L.map.window)}) · ${view === 'task' ? 'by task' : 'by type'}${under ? ` · inside "${root.name}"` : ''}`
  const walk = (n: Node, depth: number) => {
    if (lines.length >= limit) return
    const kids = n.kids ? [...n.kids].sort((a, b) => (b.tok || 0) - (a.tok || 0)) : null
    const st = markState(n, marks)
    const flags = [n.stale ? 'out of date' : '', n.lock && !n.kids ? 'locked' : '', st === 'all' ? 'staged' : st === 'some' ? 'partly staged' : ''].filter(Boolean)
    lines.push(`${'  '.repeat(depth)}- [${n.id}] ${n.name} — ${fmtTok(n.tok || 0)}${n.turn ? `, turn ${n.turn}` : ''}${kids ? `, ${kids.length} inside` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`)
    if (kids && depth < 1) for (const k of kids.slice(0, 12)) walk(k, depth + 1)
  }
  for (const k of [...(root.kids || [root])].sort((a, b) => (b.tok || 0) - (a.tok || 0))) walk(k, 0)
  return `${head}\n${lines.join('\n')}${lines.length >= limit ? '\n… (more: call map with "under" an id)' : ''}`
}

// What the plan asks of the fork writer.
function forkArgs(L: Live) {
  const drop = planMem.entries.filter(e => e.k === 'drop' && !e.problem).map(e => e.id)
  const edits = planMem.entries.filter(e => e.k === 'img' && !e.problem).map(e => ({ id: e.id, fp: e.fp, op: 'remove' }))
  const boot = planMem.entries.filter(e => e.k === 'boot' && !e.problem).map(e => e.id)
  const structure = drop.length ? [{ op: 'drop', recs: dropRecs(L.map, drop) }] : []
  return { edits, boot, structure }
}

// The noun's methods are stubs: this module's hooks on `ctxtree.<method>`
// answer every call (they have `$`); reaching a stub means the core is not
// loaded properly.
const stub = async () => { throw new Error('ctxtree core did not answer') }
const noun: Ctxtree = {
  refresh: stub, rows: stub, treemap: stub, hit: stub, types: stub, details: stub, timeline: stub, mark: stub,
  unstage: stub, review: stub, approve: stub, open: stub,
} as unknown as Ctxtree

// ------------------------------------------------------------- Claude's tools
const TOOLS = [
  {
    name: 'map',
    description: 'Show what fills this session\'s context: a tree (by task or by type) with token sizes, ids, and which items a later turn made out of date. Use it when the user wants to free context or asks what is taking space. Then stage deletions; the user reviews and applies them in ctxtree, never you.',
    inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['task', 'type'], description: 'Group by task (default) or by type.' }, under: { type: 'string', description: 'An id from an earlier map call: show what is inside it.' }, limit: { type: 'number', description: 'Most lines to return (default 60).' } } },
  },
  {
    name: 'inspect',
    description: 'Show the content of one item from the ctxtree map (up to 4,000 characters), to judge whether it can go.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'stage',
    description: 'Stage items from the ctxtree map for deletion, for the user to review. Deletion is complete: Apply writes a fork of this session without them (no note is left; the resumed Claude will not know they happened), opened in a new vTower tab; this conversation is not changed. A tool step goes with its call and output; the user\'s message or your last words on a task take the whole task. Staging changes nothing: the user reviews the plan and applies it in ctxtree (press 2 on the ctxtree band, then a). Never say anything is deleted.',
    inputSchema: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
    },
  },
  {
    name: 'unstage',
    description: 'Remove items from the staged ctxtree plan (all of them when no ids are given).',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
  },
]

// ---------------------------------------------------- engine-facing helpers
// The session's transcript: <config>/projects/<the folder, as Claude Code
// names it>/<session id>.jsonl, else wherever a project folder holds it.
async function transcriptOf($: any): Promise<string> {
  if (transcript && await $.fs.exists(transcript)) return transcript
  const cwd = await $.session.cwd()
  const guess = `${cfg}/projects/${String(cwd).replace(/[^A-Za-z0-9]/g, '-')}/${sid}.jsonl`
  if (await $.fs.exists(guess)) return (transcript = guess)
  for (const d of await $.fs.list(`${cfg}/projects`).catch(() => [])) {
    const f = `${cfg}/projects/${d.name}/${sid}.jsonl`
    if (d.kind === 'dir' && await $.fs.exists(f)) return (transcript = f)
  }
  throw new Error('ctxtree cannot find this session\'s transcript (it is written after the first message).')
}

// Whole, however large: $.fs.read stops at 4 MiB, a stream does not.
async function readAll($: any, file: string) {
  let out = ''
  for await (const c of $.process.spawn({ argv: ['cat', file] })) if (c.stream === 'stdout') out += c.text
  return out
}

// The map, read again only when the transcript grew.
async function ensureLive($: any): Promise<Live> {
  const file = await transcriptOf($)
  const st = await $.fs.stat(file)
  if (live && live.file === file && live.size === st.size) return live
  live = liveFrom(await readAll($, file), file, st.size, await $.session.cwd())
  const p = recheck(live)
  if (p) { planMem = p; await update($, plan, () => p) }
  return live
}

async function setPlan($: any, entries: CtxtreeEntry[]) {
  const p: CtxtreePlan = { entries }
  planMem = p
  await update($, plan, () => p)
}

async function hasVtower($: any) {
  if (await $.env.get('CTXTREE_NO_VTOWER')) return false   // tests, or a person who would rather paste
  for (const p of [...VTOWER, `${home}/Applications/vTower.app`]) if (await $.fs.exists(p)) return true
  return false
}

async function openFork($: any, forkSid: string, cwd: string) {
  if (!await hasVtower($)) return false
  const r = await $.process.run(['open', vtowerLink(forkSid, cwd)])
  return r.exitCode === 0
}

export const register: Register = on => {
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, ctxtree: noun }
  })

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    sid = await $.session.id()
    home = (await $.env.get('HOME')) || ''
    cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    transcript = ''
    live = null
    const saved = await $.state.get({ plugin: 'ctxtree', key: 'plan' })
    // (a plan an older ctxtree saved names blocks, not units: it is let go)
    const entries = saved.value && Array.isArray(saved.value.entries) ? saved.value.entries.filter((x: any) => x && x.k) : []
    planMem = { entries }
    if (saved.value && entries.length !== saved.value.entries.length) await update($, plan, () => planMem)
    for (const t of TOOLS) { try { await $.tool.register(t) } catch { /* registered already (a reload) */ } }
    return out
  })

  on('turn.start', async ($, e, next) => {
    await update($, status, s => ({ ...s, busy: true }))
    return next(e)
  })

  // The band's numbers come from Claude Code's own count (no file read); the
  // map is read again when the pane next asks.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out
    try {
      const usage: any = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
      const ctx = usage && usage.context
      const turns = await $.session.turns().catch(() => 0)
      await update($, status, s => ({ ...s, version: s.version + 1, tokens: ctx && ctx.tokens ? ctx.tokens : s.tokens, window: (ctx && ctx.window) || s.window, turns, busy: false }))
    } catch (err) {
      await update($, status, s => ({ ...s, busy: false, error: errText(err) }))
    }
    return out
  })

  // ---- the noun, for ctxtree-ui
  on('ctxtree.refresh', async ($) => {
    live = null
    const L = await ensureLive($)
    const usage: any = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
    const ctx = usage && usage.context
    await update($, status, s => ({ ...s, version: L.version, tokens: ctx && ctx.tokens ? ctx.tokens : L.map.tree.tok, window: (ctx && ctx.window) || L.map.window, error: '' }))
    return { value: { version: L.version } }
  })

  on('ctxtree.rows', async ($, a) => {
    const L = await ensureLive($)
    const all = flatten(rootOf(L, a.view), { expanded: new Set(a.expanded), sort: a.sort, filter: a.filter, marks: marksOf() })
    let i = Math.max(0, all.findIndex(r => r.id === a.sel))
    if (a.move) i = Math.max(0, Math.min(all.length - 1, i + a.move))
    const w = windowOf(all, all[i] ? all[i].id : '', Math.max(1, a.count), a.top)
    const selRow = all[w.sel] || null
    let parent = ''
    if (selRow) for (let j = w.sel - 1; j >= 0; j--) if (all[j].depth < selRow.depth) { parent = all[j].id; break }
    return { value: { rows: w.rows, top: w.top, sel: w.sel, selId: selRow ? selRow.id : '', total: all.length, version: L.version, title: L.title, selRow, parent } }
  })

  on('ctxtree.treemap', async ($, a) => {
    const L = await ensureLive($)
    const lay = layoutFor(L, a.view, a.columns, a.rows)
    const cells = paint(lay, { colors: L.colors, sel: a.sel || null, hover: a.hover || null, marked: markedLeafIds(L, a.view), dimExcept: a.dimType || null, fmt: fmtTok } as any)
    return { value: { cells: cellsBase64(cells), version: L.version } }
  })

  on('ctxtree.hit', async ($, a) => {
    const L = await ensureLive($)
    const id = hitTest(layoutFor(L, a.view, a.columns, a.rows), a.x, a.y) || ''
    const ancestors: string[] = []
    const par = L.idx[a.view].parent
    for (let p = par.get(id); p && p.id !== 'root'; p = par.get(p.id)) ancestors.unshift(p.id)
    return { value: { id, ancestors } }
  })

  on('ctxtree.types', async ($, a) => ({ value: typesOf(await ensureLive($), a.view) }))
  on('ctxtree.details', async ($, a) => ({ value: detailsOf(await ensureLive($), a.id) }))
  on('ctxtree.timeline', async ($, a) => ({ value: { entries: timelineFor(await ensureLive($), a) } }))

  on('ctxtree.mark', async ($, a) => {
    const L = await ensureLive($)
    const want = entriesFor(L, a.ids, 'you').entries
    const have = marksOf()
    const allIn = want.length > 0 && want.every(e => have.has(e.key))
    const entries = a.op === 'unmark' || (a.op === 'toggle' && allIn)
      ? withoutKeys(L, planMem.entries, want.map(e => e.key))
      : mergeEntries(planMem.entries, want.filter(e => !have.has(e.key)))
    await setPlan($, entries)
    return { value: { count: entries.length } }
  })

  on('ctxtree.unstage', async ($, a) => {
    await setPlan($, withoutKeys(live, planMem.entries, a.keys))
    return { value: { count: planMem.entries.length } }
  })

  // The plan, checked by building the fork in memory: nothing is written.
  on('ctxtree.review', async ($) => {
    const L = await ensureLive($)
    const items = planMem.entries.map(e => ({ ...e, ok: !e.problem }))
    const tasks = new Set(planMem.entries.filter(e => e.task && e.key === e.task).map(e => e.key)).size
    const review: CtxtreeReview = { items, save: 0, verified: false, problems: [], tasks, vtower: await hasVtower($) }
    if (!items.some(i => i.ok)) return { value: review }
    try {
      const { report } = makeFork(await readAll($, L.file), { parentSid: sid, forkSid: crypto.randomUUID(), tok: L.tok, ...forkArgs(L) })
      review.save = Math.max(0, report.resume.saved)
      review.verified = true
    } catch (err) { review.problems = errorsOf(err) }
    return { value: review }
  })

  // Apply: the fork, verified, written beside the session (a hidden temp file,
  // read back, then moved into place), recorded where the web UI lists forks,
  // and opened in a new vTower tab. This session is not changed.
  on('ctxtree.approve', async ($) => {
    if (!planMem.entries.some(e => !e.problem)) return { value: { ok: false, problems: ['The plan is empty.'] } }
    await update($, status, s => ({ ...s, applying: 'writing' as const, error: '' }))
    const done = async (problems: string[]) => {
      await update($, status, s => ({ ...s, applying: 'idle' as const, error: problems[0] || '' }))
      return { value: { ok: false, problems } }
    }
    let L: Live
    try { L = await ensureLive($) } catch (err) { return done([errText(err)]) }
    const cwd = await $.session.cwd()
    const forkSid = crypto.randomUUID()
    const raw = await readAll($, L.file)
    let built: any
    try { built = makeFork(raw, { parentSid: sid, forkSid, tok: L.tok, ...forkArgs(L) }) } catch (err) { return done(errorsOf(err)) }
    const { content, profile, report } = built
    const dir = L.file.slice(0, L.file.lastIndexOf('/'))
    const forkFile = `${dir}/${forkSid}.jsonl`, tmp = `${dir}/.${forkSid}.jsonl.ctxtree-tmp`
    const profileFile = profile ? `${cfg}/ctxtree/profiles/${forkSid}.json` : null
    try {
      if (profileFile) await $.fs.write(profileFile, JSON.stringify(profile, null, 2) + '\n')
      await $.fs.write(tmp, content)
      if (await readAll($, tmp) !== content) throw new Error('read-back mismatch')
      if (await $.fs.exists(forkFile)) throw new Error('the fork file already exists')
      const mv = await $.process.run(['mv', '-n', tmp, forkFile])
      if (mv.exitCode !== 0 || !await $.fs.exists(forkFile)) throw new Error(mv.stderr || 'could not move it into place')
      await $.process.run(['chmod', '600', forkFile])
    } catch (err) {
      await $.process.run(['rm', '-f', tmp, ...(profileFile ? [profileFile] : [])]).catch(() => null)
      return done([`Not written: ${errText(err)}. Nothing changed.`])
    }
    // file history (checkpoints) comes along, as the server's forks do
    const hist = `${cfg}/file-history/${sid}`
    let history = 'none'
    if (await $.fs.exists(hist)) history = (await $.process.run(['cp', '-c', '-R', hist, `${cfg}/file-history/${forkSid}`]).catch(() => ({ exitCode: 1 }))).exitCode === 0 ? 'cloned' : 'failed'
    const resumeCmd = resumeCommand({ forkSid, cwd, profile: profileFile })
    const projectDir = dir.slice(dir.lastIndexOf('/') + 1)
    const bytes = (await $.fs.stat(forkFile)).size
    try {
      const lin = `${cfg}/ctxtree/lineage.jsonl`
      const before = await $.fs.exists(lin) ? await readAll($, lin) : ''
      await $.fs.write(lin, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${JSON.stringify({
        forkSid, parentSid: sid, kind: 'pane', project: projectDir, projectName: projectDir, cwd, file: forkFile, createdAt: new Date().toISOString(),
        bytes, edits: report.edits, deadEdits: report.deadEdits, modifiedRecords: report.modifiedRecords, blocks: report.blocks,
        boot: report.boot, structure: report.structure, profileFile, resume: report.resume, savedTok: Math.max(0, report.resume.saved), history,
        note: forkNote(report, 'pane'),
      })}\n`)
    } catch { /* the fork stands; only the web UI's list misses it */ }
    const opened = await openFork($, forkSid, cwd).catch(() => false)
    const fork: CtxtreeFork = { forkSid, at: Date.now(), saved: Math.max(0, report.resume.saved), resumeCmd, opened }
    await setPlan($, [])
    await update($, status, s => ({ ...s, applying: 'idle' as const, error: '', lastApply: fork }))
    $.ui.toast(`ctxtree: fork ${forkSid.slice(0, 8)} written · −${fmtTok(fork.saved)} tokens${opened ? ' · opening in vTower' : ''}`)
    return { value: { ok: true, problems: [], fork } }
  })

  on('ctxtree.open', async ($, a) => {
    const ok = await openFork($, a.forkSid, await $.session.cwd()).catch(() => false)
    return { value: { ok, error: ok ? '' : 'vTower is not installed here; run the resume command instead.' } }
  })

  // ---- Claude's tools. None applies anything.
  on('tool.call', { tool: 'mcp__ctxtree__map' }, async ($, e) => {
    const a = e as any
    const L = await ensureLive($)
    const st = await $.state.get({ plugin: 'ctxtree', key: 'status' })
    return { result: mapText(L, a.view === 'type' ? 'type' : 'task', String(a.under || ''), Math.max(10, Math.min(200, Number(a.limit) || 60)), st.value ? st.value.window : 0) }
  })

  on('tool.call', { tool: 'mcp__ctxtree__inspect' }, async ($, e) => {
    const L = await ensureLive($)
    const n = nodeOf(L, String((e as any).id || ''))
    if (!n) return { result: 'No such item; call map for ids.' }
    const pv = previewOf(L, n)
    return { result: `${n.name} — ${fmtTok(n.tok || 0)}${n.lock ? `\nLocked: ${n.lock}` : ''}${n.warn ? `\n${n.warn}` : ''}\n\n${pv.slice(0, 4000)}${pv.length > 4000 ? '\n[…]' : ''}` }
  })

  on('tool.call', { tool: 'mcp__ctxtree__stage' }, async ($, e) => {
    const L = await ensureLive($)
    const items = (Array.isArray((e as any).items) ? (e as any).items : []) as { id: string }[]
    const r = entriesFor(L, items.map(it => String(it.id)), 'claude')
    if (r.entries.length) await setPlan($, mergeEntries(planMem.entries, r.entries.filter(x => !marksOf().has(x.key))))
    const save = planMem.entries.reduce((s, x) => s + (x.save || 0), 0)
    return { result: `Staged ${r.entries.length} deletion(s); the plan now holds ${planMem.entries.length} (~${fmtTok(save)} tokens).${r.skipped.length ? `\nNot staged:\n- ${r.skipped.join('\n- ')}` : ''}\nNothing is deleted yet: the user reviews the plan in ctxtree and presses Apply there, which writes a fork without them.` }
  })

  on('tool.call', { tool: 'mcp__ctxtree__unstage' }, async ($, e) => {
    const ids = (e as any).ids as string[] | undefined
    await setPlan($, ids && ids.length ? withoutKeys(live, planMem.entries, planMem.entries.filter(x => ids.includes(x.id) || ids.includes(x.key)).map(x => x.key)) : [])
    return { result: `The plan now holds ${planMem.entries.length} deletion(s).` }
  })
}
