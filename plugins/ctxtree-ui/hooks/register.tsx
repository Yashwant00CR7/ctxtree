// ctxtree-ui: the band above the prompt, the pane (tree, types, details and a
// cushion treemap of the session's context) and the review dialog whose Apply
// writes a fork without what is marked and opens it in vTower. The plan, the
// map and the fork are the ctxtree core plugin's; this module draws them and
// turns keys and clicks into its noun's calls.
//
// Keyboard: the pane's hotkeys (letters and digits) and its scroll keys work as
// soon as it opens; after a click on the tree, the tree takes every key (Space
// and the arrows included). Esc hands the keyboard back to the prompt.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { CtxtreeUiState, CtxtreeUiDetail } from '../types'
import { readerRows, rowOf, clampTop } from './lines.js'

const PANE = 'ctxtree', REVIEW = 'ctxtree-review'
const UI0: CtxtreeUiState = {
  view: 'task', expandedTask: [], expandedType: [], sel: '', sort: 'tok', filter: '', filtering: false,
  menu: false, wide: false, side: 'map', dimType: '', undo: [], msg: '',
  detail: { sel: '', open: [], all: [], top: 0, cur: 0 },
  hover: '',
}
const ui = atom({ plugin: 'ctxtree-ui', key: 'ui' } as const, UI0)
const note = atom({ plugin: 'ctxtree-ui', key: 'note' } as const, '')

// The window's top row, per view: kept here, not in state, because a render
// may not write state and the window has to stay put while the selection moves.
const tops: Record<string, number> = { task: 0, type: 0 }
// What the last render laid out, so a treemap click maps to the same layout.
let lastMap = { columns: 0, rows: 0 }
// ... and where the Details reader sat: its width, its height, its first body column.
let lastReader = { width: 40, height: 10, x0: 0 }

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)))
const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
const expandedOf = (s: CtxtreeUiState) => (s.view === 'task' ? s.expandedTask : s.expandedType)
const withExpanded = (s: CtxtreeUiState, list: string[]): CtxtreeUiState => (s.view === 'task' ? { ...s, expandedTask: list } : { ...s, expandedType: list })
const SORTS: CtxtreeUiState['sort'][] = ['tok', 'turn', 'name']
const SORT_LABEL = { tok: 'size', turn: 'story order', name: 'name' }

// Where things go in a body `C` columns wide and `R` rows tall.
function sizes(C: number, R: number) {
  // the side column carries whole messages and tool output: give it room
  const side = C >= 110 ? Math.min(90, Math.round(C * 0.42)) : 0
  const main = Math.max(30, C - side - (side ? 1 : 0))
  const avail = Math.max(6, R - 5) // header, column header, separator, two footer rows
  const treeRows = Math.max(4, Math.round(avail * 0.5))
  const mapRows = Math.max(0, avail - treeRows)
  return { side, main, treeRows, mapRows, mapCols: main }
}

// Everything a key, click or press can do, written once. `io` holds closures
// over the calling hook's `$` (the engine wants `$` spelled at each call).
type Io = {
  get: () => Promise<CtxtreeUiState>
  set: (s: CtxtreeUiState) => Promise<unknown>
  rows: (a: any) => Promise<any>
  mark: (a: any) => Promise<{ count: number }>
  hit: (a: any) => Promise<{ id: string; ancestors: string[] }>
  planCount: () => Promise<number>
  details: (a: any) => Promise<any>
  timeline: (a: any) => Promise<{ entries: any[] }>
  openPane: (wide: boolean) => Promise<unknown>
  openReview: () => Promise<unknown>
}

async function perform(io: Io, action: string, arg?: any) {
  let s = await io.get()
  const base = { view: s.view, expanded: expandedOf(s), sort: s.sort, filter: s.filter, sel: s.sel, top: tops[s.view] || 0, count: 1, move: 0 }
  const moveBy = async (n: number) => { const r = await io.rows({ ...base, move: n }); if (r.selId) await io.set({ ...s, sel: r.selId, menu: false }) }
  const markSel = async (op: 'toggle' | 'mark' | 'unmark', ids = [s.sel]) => {
    if (!ids[0]) { const r = await io.rows(base); ids = [r.selId] }
    const before = await io.planCount()
    const r = await io.mark({ ids, op })
    const added = r.count > before
    if (r.count === before) return io.set({ ...s, menu: false, msg: 'Nothing there can be deleted.' })
    return io.set({ ...s, menu: false, msg: '', undo: [...s.undo.slice(-49), { ids, op: added ? 'unmark' : 'mark' }] })
  }
  switch (action) {
    case 'move': return moveBy(arg)
    case 'home': return moveBy(-1e9)
    case 'end': return moveBy(1e9)
    case 'expand': case 'collapse': {
      const r = await io.rows(base)
      const row = r.selRow
      if (!row) return
      const ex = expandedOf(s)
      if (action === 'expand') {
        if (row.kids && !row.open) return io.set(withExpanded({ ...s, sel: row.id }, [...ex, row.id]))
        if (row.open) return moveBy(1)
        return
      }
      if (row.open) return io.set(withExpanded({ ...s, sel: row.id }, ex.filter(x => x !== row.id)))
      if (r.parent) return io.set({ ...s, sel: r.parent })
      return
    }
    case 'select': return io.set({ ...s, sel: arg, menu: false })
    case 'toggle': {
      const ex = expandedOf(s)
      return io.set(withExpanded({ ...s, sel: arg, menu: false }, ex.includes(arg) ? ex.filter(x => x !== arg) : [...ex, arg]))
    }
    case 'mark': return markSel('toggle')
    case 'mark-ids': return markSel('toggle', arg)
    case 'm:toggle': return markSel('toggle')
    case 'm:drop': return markSel('mark')
    case 'm:unmark': return markSel('unmark')
    case 'menu': return io.set({ ...s, menu: !s.menu })
    case 'close-menu': return io.set({ ...s, menu: false })
    case 'undo': {
      const step = s.undo[s.undo.length - 1]
      if (!step) return io.set({ ...s, msg: 'Nothing to undo.' })
      await io.mark({ ids: step.ids, op: step.op })
      return io.set({ ...s, undo: s.undo.slice(0, -1), msg: '' })
    }
    case 'sort': return io.set({ ...s, sort: SORTS[(SORTS.indexOf(s.sort) + 1) % SORTS.length] ?? 'tok' })
    case 'view': return io.set({ ...s, view: arg, menu: false })
    case 'filter': return io.set({ ...s, filtering: true })
    case 'filter-set': return io.set({ ...s, filter: String(arg || ''), filtering: false })
    case 'side': return io.set({ ...s, side: s.side === arg ? 'map' : arg })
    case 'dim': return io.set({ ...s, dimType: s.dimType === arg ? '' : arg })
    case 'wide': { const w = !s.wide; await io.set({ ...s, wide: w }); return io.openPane(w) }
    case 'review': return io.openReview()
    case 'hit': {
      if (!lastMap.columns) return
      const r = await io.hit({ view: s.view, columns: lastMap.columns, rows: lastMap.rows, x: arg.x, y: arg.y })
      if (!r.id) return
      const ex = expandedOf(s)
      const next = withExpanded({ ...s, sel: r.id, menu: arg.button === 'right' }, [...new Set([...ex, ...r.ancestors])])
      return io.set(next)
    }
  }
}

// ---- the Details reader: what the selection is, then its timeline
// The reader's state for a selection: kept while the selection stays, fresh
// when it moves (a single item opens at once; a task starts closed).
function detailOf(s: CtxtreeUiState, sel: string, leaf: boolean): CtxtreeUiDetail {
  const d = s.detail
  if (d && d.sel === sel) return d
  return { sel, open: leaf ? [sel] : [], all: [], top: 0, cur: 0 }
}

function headOf(det: any) {
  if (!det || !det.name) return [{ text: 'Select an item.', style: 'dim' }]
  const h: { text: string; style: string }[] = [{ text: det.name, style: 'title' }]
  if (det.path && det.path.length) h.push({ text: det.path.join(' › '), style: 'dim' })
  h.push({ text: `${fmt(det.tok)} tokens${det.turn ? ` · turn ${det.turn}` : ''}`, style: 'dim' })
  if (det.stale) h.push({ text: det.stale, style: 'warn' })
  if (det.lock) h.push({ text: det.lock, style: 'dim' })
  else if (det.info) h.push({ text: det.info, style: 'dim' })
  if (det.warn) h.push({ text: det.warn, style: 'warn' })
  return h
}

async function readerModel(io: Io, s: CtxtreeUiState, sel: string, width: number) {
  const det = sel ? await io.details({ id: sel }) : null
  const leaf = !!det && det.name !== '' && det.kind !== 'task'
  const d = detailOf(s, sel, leaf)
  const { entries } = sel ? await io.timeline({ id: sel, open: d.open, all: d.all }) : { entries: [] as any[] }
  const cur = Math.max(0, Math.min(d.cur, entries.length - 1))
  const rows = readerRows({ head: headOf(det), entries, width, open: d.open, cur: entries.length ? cur : -1 })
  return { d: { ...d, cur }, entries, rows }
}

// Keys and clicks in the reader.
async function readerAct(io: Io, action: string, arg?: any) {
  const s = await io.get()
  const sel = s.sel || (await io.rows({ view: s.view, expanded: expandedOf(s), sort: s.sort, filter: s.filter, sel: '', top: 0, count: 1, move: 0 })).selId
  const { width, height } = lastReader
  const m = await readerModel(io, s, sel, width)
  let d = m.d
  const e = m.entries[d.cur]
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])
  const show = (i: number) => {
    const r = rowOf(m.rows, i)
    const top = r < d.top ? r : r >= d.top + height - 1 ? r - 2 : d.top
    return { ...d, cur: i, top }
  }
  switch (action) {
    case 'move': d = show(Math.max(0, Math.min(m.entries.length - 1, d.cur + arg))); break
    case 'page': {
      const top = clampTop(m.rows, d.top + arg * Math.max(1, height - 1), height)
      const first = m.rows.slice(top).find(r => r.hdr)
      d = { ...d, top, cur: first ? first.e : d.cur }
      break
    }
    case 'home': d = { ...d, top: 0, cur: 0 }; break
    case 'end': d = { ...d, top: clampTop(m.rows, 1e9, height), cur: Math.max(0, m.entries.length - 1) }; break
    case 'scroll': d = { ...d, top: clampTop(m.rows, d.top + arg, height) }; break
    case 'toggle': if (e && e.kind === 'tool') d = { ...d, open: toggle(d.open, e.id) }; else if (e && e.truncated) d = { ...d, all: [...d.all, e.id] }; break
    case 'close': if (e) d = { ...d, open: d.open.filter(x => x !== e.id) }; break
    case 'all': if (e) d = { ...d, open: [...new Set([...d.open, e.id])], all: [...new Set([...d.all, e.id])] }; break
    case 'open-all': {
      const tools = m.entries.filter(x => x.kind === 'tool').map(x => x.id)
      const every = tools.length > 0 && tools.every(id => d.open.includes(id))
      d = { ...d, open: every ? [] : tools }
      break
    }
    case 'mark':
      if (!e || !e.deletable) return io.set({ ...s, detail: d, msg: (e && e.lock) || 'Nothing there can be deleted.' })
      await io.set({ ...s, detail: d })
      return perform(io, 'mark-ids', e.ids || [e.id])
    case 'click': {
      const r = m.rows[d.top + arg.y]
      if (!r || r.e < 0) return
      d = { ...d, cur: r.e }
      const hit = m.entries[r.e]
      if (arg.button === 'right') { await io.set({ ...s, detail: d }); return readerAct(io, 'mark') }
      if (r.hdr && hit && hit.kind === 'tool') d = { ...d, open: toggle(d.open, hit.id) }
      break
    }
  }
  return io.set({ ...s, sel, detail: d, menu: false })
}

// Keys the reader reports once it has the focus; others go to the pane's own.
const READER_KEYS: Record<string, [string, any?]> = {
  up: ['move', -1], down: ['move', 1], k: ['move', -1], j: ['move', 1], pageup: ['page', -1], pagedown: ['page', 1],
  home: ['home'], end: ['end'], return: ['toggle'], right: ['toggle'], l: ['toggle'], left: ['close'], h: ['close'],
  ' ': ['mark'], space: ['mark'], x: ['mark'], a: ['all'], e: ['open-all'],
}

// Keys the tree reports once it has the focus.
const TREE_KEYS: Record<string, [string, any?]> = {
  up: ['move', -1], down: ['move', 1], pageup: ['move', -10], pagedown: ['move', 10], home: ['home'], end: ['end'],
  left: ['collapse'], right: ['expand'], h: ['collapse'], l: ['expand'], return: ['expand'],
  ' ': ['mark'], space: ['mark'], x: ['mark'], d: ['menu'], u: ['undo'], r: ['review'], s: ['sort'], f: ['filter'], z: ['wide'],
  t: ['side', 'types'], i: ['side', 'details'], k: ['side', 'keys'], 1: ['view', 'task'], 2: ['view', 'type'],
}

// While the menu is open, its digits (the pane's menu Buttons take them when
// the pane has the keyboard; these, when the tree has it).
const MENU_KEYS: Record<string, [string, any?]> = {
  1: ['m:toggle'], 2: ['close-menu'], q: ['close-menu'],
}

const KEYS_HELP = [
  '↑ ↓ PgUp PgDn Home End   move',
  'l / h  (→ / ← in the tree)  open / close',
  'x  (Space in the tree)    mark / unmark',
  'd  (right-click)          menu: delete / keep',
  'u                         undo the last mark',
  'r                         review; a writes the fork',
  's   sort      f   filter',
  '1 / 2   by task / by type',
  'i / t / k   details / types / these keys',
  'z   wide ⇄ docked',
  'Esc   back to the prompt (and close)',
  'Click the tree to give it the keyboard;',
  'click the treemap to select a block.',
  '',
  'Details (click it for the keyboard):',
  '↑ ↓ / j k   previous / next item',
  'Enter / l   open / close a tool call',
  'a           load all of a long output',
  'e           open / close every tool call',
  'x  Space    mark / unmark that item',
  'PgUp PgDn or the wheel   scroll',
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctxtree', description: 'See what fills the context and delete from it into a fork (pane; /ctxtree review for the plan)', argumentHint: '[review]' })
    return next(e)
  })

  on('command.run', { command: 'ctxtree' }, async ($, e) => {
    const s = await read($, ui)
    if (String(e.args || '').trim() === 'review') {
      await $.ui.open({ id: REVIEW, title: 'ctxtree review', focus: true, closeOnEscape: true, holdToasts: true })
      return { text: 'review open · a writes the fork · Esc closes' }
    }
    if (!e.presentation || !e.presentation.isFullscreen) {
      const st = (await $.state.get({ plugin: 'ctxtree', key: 'status' })).value
      const types = await $.ctxtree.types({ view: 'type' })
      const top = types.slice(0, 6).map(t => `  ${t.name}: ${fmt(t.tok)}`).join('\n')
      return { text: `ctxtree: ~${fmt(st ? st.tokens : 0)} tokens in context.\n${top}\nThe ctxtree pane needs the fullscreen layout: run /tui fullscreen, then /ctxtree.` }
    }
    const cols = Math.max(90, Math.min(160, Math.round((e.presentation.columns || 160) * 0.6)))
    await $.ui.open({ id: PANE, title: 'ctxtree', focus: true, closeOnEscape: true, columns: s.wide ? 400 : cols })
    return { text: 'pane open · k for keys · Esc closes' }
  })

  // ---- the band: shown while something is staged or a fork is being written
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = (await $.state.get({ plugin: 'ctxtree', key: 'plan' })).value
    const st = (await $.state.get({ plugin: 'ctxtree', key: 'status' })).value
    const writing = !!(st && st.applying === 'writing')
    if (e.props.hasSurvey || ((!p || !p.entries.length) && !writing)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const n = p ? p.entries.length : 0
    const save = p ? p.entries.reduce((a, x) => a + (x.save || 0), 0) : 0
    const bad = p ? p.entries.filter(x => x.problem).length : 0
    const s = await read($, ui)
    return (
      <Box gap={2}>
        <Text>
          <Text bold>ctxtree</Text>
          {writing ? ' · writing the fork…' : ` · ${n} marked · −${fmt(save)} tokens${bad ? ` · ${bad} no longer here` : ''}`}
        </Text>
        <Button key="band-open" hotkey="1" plain label="open" onPress={() => $.ui.open({ id: PANE, title: 'ctxtree', focus: true, closeOnEscape: true, columns: s.wide ? 400 : 100 })} />
        <Button key="band-review" hotkey="2" plain label="review" onPress={() => $.ui.open({ id: REVIEW, title: 'ctxtree review', focus: true, closeOnEscape: true, holdToasts: true })} />
      </Box>
    )
  })

  // ---- the pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster, Client, Input, Markdown } = $.ui.resolve(e) as any
    const s = await read($, ui)
    const st = (await $.state.get({ plugin: 'ctxtree', key: 'status' })).value
    const p = (await $.state.get({ plugin: 'ctxtree', key: 'plan' })).value
    const C = e.props.bodyColumns, R = e.props.scroll.bodyRows
    const L = sizes(C, R)
    const rows = await $.ctxtree.rows({ view: s.view, expanded: expandedOf(s), sort: s.sort, filter: s.filter, sel: s.sel, top: tops[s.view] || 0, count: L.treeRows, move: 0 })
    tops[s.view] = rows.top
    const sel = rows.selId
    const types = await $.ctxtree.types({ view: s.view })
    const colors: Record<string, string> = {}
    for (const t of types) colors[t.t] = hex(t.color)
    let tm: { cells: string } | null = null
    if (L.mapRows >= 3 && (L.side > 0 || s.side === 'map')) {
      tm = await $.ctxtree.treemap({ view: s.view, columns: L.mapCols, rows: L.mapRows, sel, dimType: s.dimType, hover: s.hover || '' })
      lastMap = { columns: L.mapCols, rows: L.mapRows }
    } else lastMap = { columns: 0, rows: 0 }
    // Wide: a side column (details by default). Narrow: the treemap's place shows
    // types, details or keys while one is chosen (t / i / k; again for the map).
    const sideKind = L.side ? (s.side === 'map' ? 'details' : s.side) : s.side
    const marked = p ? p.entries.length : 0
    const save = p ? p.entries.reduce((a, x) => a + (x.save || 0), 0) : 0
    const tokens = st ? st.tokens : 0
    const selRow = rows.selRow
    // the footer names the block under the pointer (else the selection)
    const pointed = s.hover ? await $.ctxtree.details({ id: s.hover }) : null

    // The numbers first, then as much of the session's title as fits beside the view toggle.
    const nums = ` · ${fmt(tokens)}${st && st.window ? ` / ${fmt(st.window)}` : ''} tokens${marked ? ` → −${fmt(save)}` : ''}${s.filter ? ` · filter “${s.filter}”` : ''}`
    const room = Math.max(0, C - 8 - nums.length - (s.menu ? 0 : 26) - 5)
    const title = rows.title && room > 8 ? ` · “${rows.title.length > room ? `${rows.title.slice(0, room - 1)}…` : rows.title}”` : ''
    const header = (
      <Box justifyContent="space-between" width={C}>
        <Text wrap="truncate-end">
          <Text bold>ctxtree</Text>{nums}<Text dimColor>{title}</Text>
        </Text>
        {!s.menu && (
          <Box gap={1} flexShrink={0} marginLeft={1}>
            <Button key="v-task" hotkey="1" plain label={s.view === 'task' ? '[By task]' : 'By task'} onPress={() => update($, ui, x => ({ ...x, view: 'task' as const }))} />
            <Button key="v-type" hotkey="2" plain label={s.view === 'type' ? '[By type]' : 'By type'} onPress={() => update($, ui, x => ({ ...x, view: 'type' as const }))} />
          </Box>
        )}
      </Box>
    )

    const io: Io = {
      get: () => read($, ui),
      set: (v) => update($, ui, () => v),
      rows: (a) => $.ctxtree.rows(a),
      mark: (a) => $.ctxtree.mark(a),
      hit: (a) => $.ctxtree.hit(a),
      planCount: async () => { const v = (await $.state.get({ plugin: 'ctxtree', key: 'plan' })).value; return v ? v.entries.length : 0 },
      details: (a) => $.ctxtree.details(a),
      timeline: (a) => $.ctxtree.timeline(a),
      openPane: (w) => $.ui.open({ id: PANE, title: 'ctxtree', columns: w ? 400 : 100 }),
      openReview: () => $.ui.open({ id: REVIEW, title: 'ctxtree review', focus: true, closeOnEscape: true, holdToasts: true }),
    }
    const key = (k: string, hotkey: string, label: string, action: string, arg?: any) => (
      <Button key={k} hotkey={hotkey} plain label={label} onPress={() => perform(io, action, arg)} />
    )

    const sideW = L.side || L.main
    // Details and Types share the side column as tabs (i / t; k for the keys)
    const tabs = (
      <Text wrap="truncate-end">
        <Text bold={sideKind === 'details'} inverse={sideKind === 'details'}> Details </Text>
        <Text dimColor> │ </Text>
        <Text bold={sideKind === 'types'} inverse={sideKind === 'types'}> Types </Text>
        <Text dimColor> │ </Text>
        <Text bold={sideKind === 'keys'} inverse={sideKind === 'keys'}> Keys </Text>
        <Text dimColor>   i · t · k</Text>
      </Text>
    )
    const readerH = Math.max(3, (L.side ? L.treeRows + 1 + L.mapRows : L.mapRows) - 1)
    const rd = sideKind === 'details' ? await readerModel(io, s, sel, sideW - 1) : null
    const rdTop = rd ? clampTop(rd.rows, rd.d.top, readerH) : 0
    if (rd) lastReader = { width: sideW - 1, height: readerH, x0: L.side ? L.main + 1 : 0 }
    const sideBody = sideKind === 'map' ? null
      : sideKind === 'types' ? (
        <Box flexDirection="column">
          <Text bold>Types {s.dimType ? '(highlighting)' : ''}</Text>
          {types.slice(0, Math.max(3, R - 6)).map(t => (
            <Button key={`ty:${t.t}`} plain onPress={() => perform(io, 'dim', t.t)}>
              <Text color={hex(t.color)}>■ </Text>
              <Text inverse={s.dimType === t.t} wrap="truncate-end">{`${t.name}`.slice(0, sideW - 12).padEnd(sideW - 12)} {fmt(t.tok).padStart(6)}</Text>
            </Button>
          ))}
        </Box>
      ) : sideKind === 'keys' ? (
        <Box flexDirection="column"><Text bold>Keys</Text>{KEYS_HELP.map(l => <Text dimColor wrap="truncate-end">{l}</Text>)}</Box>
      ) : rd ? (
        <Client key="reader" module="./reader.tsx" width={sideW} height={readerH}
          props={{ width: sideW - 1, lines: rd.rows.slice(rdTop, rdTop + readerH).map(r => ({ t: r.text, s: r.style, c: !!r.cur })) }} />
      ) : <Text dimColor>Select an item.</Text>
    const side = sideBody && <Box flexDirection="column">{tabs}{sideBody}</Box>

    const colHead = `  ${'Name'.padEnd(Math.max(12, L.main - 28))} ${'%parent'.padEnd(6)} ${'Tokens'.padStart(7)} ${'Items'.padStart(5)} ${'Turn'.padStart(4)}`
    const menu = s.menu && selRow ? (
      <Box position="absolute" top={2 + Math.max(0, rows.sel - rows.top) + 1} left={4} flexDirection="column" borderStyle="round" backgroundColor="black">
        <Text bold wrap="truncate-end">{selRow.name.slice(0, 40)}</Text>
        {selRow.deletable ? key('m1', '1', selRow.mark === 'all' ? 'keep' : 'delete (gone from the fork)', selRow.mark === 'all' ? 'm:unmark' : 'm:drop') : <Text dimColor>{(selRow.lock || 'Nothing here can be deleted.').slice(0, 60)}</Text>}
        {selRow.deletable && selRow.warn && <Text dimColor wrap="truncate-end">{selRow.warn.slice(0, 60)}</Text>}
        {key('m2', '2', 'close menu', 'close-menu')}
      </Box>
    ) : null

    return (
      <Box flexDirection="column" width={C}>
        {header}
        {s.filtering ? (
          <Input key="filter" label="Filter" placeholder="part of a name; Enter to apply, empty to clear" value={s.filter} autoFocus onSubmit={(v: string) => perform(io, 'filter-set', v)} />
        ) : <Text dimColor wrap="truncate-end">{colHead}</Text>}
        <Box flexDirection="row">
          <Box flexDirection="column" width={L.main}>
            <Client key="tree" module="./tree.tsx" props={{ rows: rows.rows, sel: rows.sel - rows.top, width: L.main, colors }} width={L.main} height={L.treeRows} />
            {(tm || (!L.side && sideBody)) && <Text dimColor>{'─'.repeat(Math.max(0, L.main))}</Text>}
            {!L.side && sideBody && <Box flexDirection="column" height={L.mapRows} overflow="hidden">{side}</Box>}
            {tm && !(!L.side && sideBody) && (
              <Box position="relative" width={L.mapCols} height={L.mapRows}>
                <Raster key="map" columns={L.mapCols} rows={L.mapRows} cells={tm.cells} />
                <Box position="absolute" top={0} left={0}>
                  <Client key="overlay" module="./overlay.tsx" props={{ w: L.mapCols, h: L.mapRows }} width={L.mapCols} height={L.mapRows} />
                </Box>
              </Box>
            )}
          </Box>
          {L.side > 0 && <Box flexDirection="column" width={L.side} height={L.treeRows + 1 + L.mapRows} overflow="hidden" marginLeft={1}>{side}</Box>}
        </Box>
        <Text wrap="truncate-end">
          {marked ? <Text bold color="red">{marked} marked · −{fmt(save)} </Text> : <Text dimColor>nothing marked </Text>}
          {s.msg && (marked > 0 || !/review/.test(s.msg)) ? <Text color="yellow">{s.msg}</Text>
            : pointed && pointed.name ? <Text>{`${pointed.name} · ${fmt(pointed.tok)} tokens${tokens ? ` · ${Math.max(0.1, Math.round((1000 * pointed.tok) / tokens) / 10)}% of the context` : ''}`}</Text>
              : <Text dimColor>{`sort: ${SORT_LABEL[s.sort]}`}</Text>}
        </Text>
        <Box gap={1} flexWrap="wrap">
          {key('k-x', 'x', 'mark', 'mark')}
          {key('k-d', 'd', 'menu', 'menu')}
          {key('k-u', 'u', 'undo', 'undo')}
          {key('k-r', 'r', 'review', 'review')}
          {key('k-h', 'h', 'close', 'collapse')}
          {key('k-l', 'l', 'open', 'expand')}
          {key('k-s', 's', 'sort', 'sort')}
          {key('k-f', 'f', 'filter', 'filter')}
          {key('k-t', 't', 'types', 'side', 'types')}
          {key('k-i', 'i', 'details', 'side', 'details')}
          {key('k-k', 'k', 'keys', 'side', 'keys')}
          <Button key="k-e" hotkey="e" plain label="open all" onPress={() => readerAct(io, 'open-all')} />
          {key('k-z', 'z', s.wide ? 'dock' : 'wide', 'wide')}
        </Box>
        {menu}
        {/* spare rows: content taller than the body is what lets the arrows reach
            ui.scroll; the hook answers every scroll itself, so they never show */}
        <Box height={4}><Text> </Text></Box>
      </Box>
    )
  })

  // The pane's scroll keys and wheel move the selection; the pane never scrolls itself.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const s = await read($, ui)
    // the wheel over the side column scrolls the Details reader
    if (e.pointer && lastReader.x0 > 0 && e.pointer.column >= lastReader.x0 && (s.side === 'map' || s.side === 'details')) {
      const io = {
        get: () => read($, ui), set: (v: CtxtreeUiState) => update($, ui, () => v), rows: (a: any) => $.ctxtree.rows(a),
        details: (a: any) => $.ctxtree.details(a), timeline: (a: any) => $.ctxtree.timeline(a),
      } as unknown as Io
      await readerAct(io, 'scroll', Math.sign(e.by) * Math.max(3, Math.abs(e.by)))
      return {}
    }
    const by = Math.abs(e.by) >= e.contentRows ? Math.sign(e.by) * 1e9 : Math.abs(e.by) >= e.bodyRows ? Math.sign(e.by) * 10 : e.by
    const r = await $.ctxtree.rows({ view: s.view, expanded: expandedOf(s), sort: s.sort, filter: s.filter, sel: s.sel, top: tops[s.view] || 0, count: 1, move: by })
    if (r.selId && r.selId !== s.sel) await update($, ui, x => ({ ...x, sel: r.selId, menu: false }))
    return {}
  })

  // Clicks and keys from the tree, clicks on the treemap.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const d = (e.data || {}) as any
    const io: Io = {
      get: () => read($, ui),
      set: (v) => update($, ui, () => v),
      rows: (a) => $.ctxtree.rows(a),
      mark: (a) => $.ctxtree.mark(a),
      hit: (a) => $.ctxtree.hit(a),
      planCount: async () => { const v = (await $.state.get({ plugin: 'ctxtree', key: 'plan' })).value; return v ? v.entries.length : 0 },
      details: (a) => $.ctxtree.details(a),
      timeline: (a) => $.ctxtree.timeline(a),
      openPane: (w) => $.ui.open({ id: PANE, title: 'ctxtree', columns: w ? 400 : 100 }),
      openReview: () => $.ui.open({ id: REVIEW, title: 'ctxtree review', focus: true, closeOnEscape: true, holdToasts: true }),
    }
    if (e.element === 'reader' && d.click !== undefined) await readerAct(io, 'click', { y: d.click, button: d.button })
    else if (e.element === 'reader' && d.key) {
      const r = READER_KEYS[d.key]
      if (r) await readerAct(io, r[0], r[1])
      else { const m = TREE_KEYS[d.key]; if (m && !['move', 'home', 'end', 'expand', 'collapse', 'mark'].includes(m[0])) await perform(io, m[0], m[1]) }
    } else if (e.element === 'overlay' && d.hit) await perform(io, 'hit', d)
    else if (e.element === 'overlay' && d.hover) {
      const s = await read($, ui)
      const id = d.leave || !lastMap.columns ? '' : (await $.ctxtree.hit({ view: s.view, columns: lastMap.columns, rows: lastMap.rows, x: d.x, y: d.y })).id
      if (id !== (s.hover || '')) await update($, ui, x => ({ ...x, hover: id }))
    }
    else if (e.element === 'tree' && d.click) {
      if (d.toggle) await perform(io, 'toggle', d.click)
      else await perform(io, 'select', d.click)
      if (d.button === 'right') await perform(io, 'menu')
    } else if (e.element === 'tree' && d.key) {
      const s = await read($, ui)
      const m = s.menu && MENU_KEYS[d.key] ? MENU_KEYS[d.key] : TREE_KEYS[d.key]
      if (m) await perform(io, m[0], m[1])
    }
    return {}
  })

  // Esc with the menu open closes the menu, not the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      const s = await read($, ui)
      if (s.menu) { await update($, ui, x => ({ ...x, menu: false })); return { deny: 'menu closed' } }
    }
    return next(e)
  })

  // ---- the review dialog: the plan, checked on a fork built in memory, and
  // Apply, which writes that fork and opens it in vTower
  on('ui.render', { component: 'Pane', requestId: REVIEW }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e) as any
    const rv = await $.ctxtree.review({ why: 'render' })
    const st = (await $.state.get({ plugin: 'ctxtree', key: 'status' })).value
    const msg = await read($, note)
    const C = e.props.bodyColumns
    const writing = !!(st && st.applying === 'writing')
    const ok = rv.items.filter(i => i.ok)
    const last = st && st.lastApply
    const apply = async () => {
      await update($, note, () => '')
      const r = await $.ctxtree.approve({ why: 'review' })
      if (!r.ok) { await update($, note, () => `Not written:\n${r.problems.join('\n')}`); return }
      const f = r.fork!
      await update($, note, () => `Fork ${f.forkSid.slice(0, 8)} written, −${fmt(f.saved)} tokens. ${f.opened ? 'It is opening in a new vTower tab.' : `Resume it with:\n${f.resumeCmd}`}\nThis session is unchanged.`)
    }
    return (
      <Box flexDirection="column" width={C}>
        <Text bold>ctxtree review · {rv.items.length} item{rv.items.length === 1 ? '' : 's'}{rv.verified ? ` · −${fmt(rv.save)} tokens` : ''}</Text>
        <Text dimColor wrap="wrap">Apply writes a fork of this session with these deleted completely: no note is left, so the resumed Claude will not know they happened.{rv.vtower ? ' The fork opens in a new vTower tab.' : ' ctxtree gives you the command to resume it.'} This session is not changed.</Text>
        {rv.tasks > 0 && <Text color="yellow" wrap="wrap">{rv.tasks} whole task{rv.tasks === 1 ? ' goes' : 's go'}: your message, everything Claude did for it, and its replies.</Text>}
        {rv.items.length === 0 && <Text dimColor>Nothing marked. Mark items in the pane (/ctxtree, then x) or ask Claude to plan a cleanup.</Text>}
        {rv.items.length > 0 && <Text color={rv.verified ? 'green' : 'red'} wrap="wrap">{rv.verified ? 'Verified on a full build of the fork: every tool call still pairs with its result, the turns alternate, the resumed chain is intact.' : `Not verified:\n${rv.problems.join('\n')}`}</Text>}
        {rv.items.map(i => (
          <Box flexDirection="column" key={`it:${i.key}`}>
            <Box gap={1}>
              <Text color={i.ok ? undefined : 'red'}>{i.ok ? '•' : '✕'}</Text>
              <Text wrap="truncate-end">{i.name.slice(0, Math.max(10, C - 34))}</Text>
              <Text dimColor>−{fmt(i.save)} · by {i.by === 'claude' ? 'Claude' : 'you'}</Text>
              <Button key={`rm:${i.key}`} label="keep" onPress={async () => { await $.ctxtree.unstage({ keys: [i.key] }) }} />
            </Box>
            {i.problem && <Text color="red" wrap="wrap">   {i.problem}</Text>}
          </Box>
        ))}
        {msg && <Text color="yellow" wrap="wrap">{msg}</Text>}
        <Box gap={2}>
          {ok.length > 0 && rv.verified && !writing && <Button key="rv-apply" hotkey="a" variant="primary" label={`Write the fork${rv.vtower ? ' and open it' : ''} (a)`} onPress={apply} />}
          {writing && <Text dimColor>writing the fork…</Text>}
          {last && rv.vtower && !writing && <Button key="rv-open" hotkey="o" plain label={`open fork ${last.forkSid.slice(0, 8)} in vTower`} onPress={async () => { const r = await $.ctxtree.open({ forkSid: last.forkSid }); if (!r.ok) await update($, note, () => r.error) }} />}
          <Button key="rv-close" hotkey="q" plain label="close" onPress={async () => { await update($, note, () => ''); await $.ui.close({ id: REVIEW }) }} />
        </Box>
      </Box>
    )
  })
}
