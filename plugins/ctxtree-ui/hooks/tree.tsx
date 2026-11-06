// The tree rows, drawn on the surface so the pointer works (click to select,
// click the triangle to open, double-click to open, right-click for the menu)
// and, once clicked, every key reaches it (Space and arrows included). It
// posts what happened; the hooks module decides what it means.
type Row = {
  id: string; depth: number; name: string; t: string; tok: number; n: number; turn: number; pct: number
  kids: boolean; open: boolean; mark: '' | 'some' | 'all'; lock: string; stale: number; err: number; latest: number
}
type Props = { rows: Row[]; sel: number; width: number; colors: Record<string, string> }

let cur: Props = { rows: [], sel: -1, width: 80, colors: {} }
let last = { id: '', at: 0 }

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
const bar = (p: number, w: number) => {
  const eighths = Math.max(0, Math.min(w * 8, Math.round(p * w * 8)))
  const full = '█'.repeat(Math.floor(eighths / 8)), rest = eighths % 8
  return (full + (rest ? '▏▎▍▌▋▊▉'[7 - rest] : '')).padEnd(w, ' ')
}
const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w, ' '))

export default function Tree(props: Props, surface: any) {
  cur = props
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(1)
    surface.onPointer((ev: any) => {
      if (ev.type !== 'down') return
      const row = cur.rows[ev.y]
      if (!row) return
      const now = Date.now()
      const dbl = last.id === row.id && now - last.at < 450
      last = { id: row.id, at: now }
      const onTriangle = row.kids && ev.x >= 1 + row.depth * 2 && ev.x <= 2 + row.depth * 2
      surface.post({ click: row.id, button: ev.button || 'left', toggle: onTriangle || (dbl && row.kids), dbl })
    })
    surface.onKey((ev: any) => surface.post({ key: ev.key, shift: !!ev.shift, ctrl: !!ev.ctrl }))
  }
  const w = Math.max(30, props.width - 1)
  const nameW = Math.max(12, w - 27)
  return (
    <Box flexDirection="column" width={w + 1}>
      {props.rows.map((r, i) => {
        const mark = r.mark === 'all' ? '✕' : r.mark === 'some' ? '◐' : ' '
        const head = `${'  '.repeat(r.depth)}${r.kids ? (r.open ? '▾' : '▸') : ' '} `
        const name = fit(head + r.name + (r.stale ? '  · out of date' : ''), nameW)
        const cols = ` ${bar(r.pct, 6)} ${fmt(r.tok).padStart(7)} ${(r.kids ? String(r.n) : '').padStart(5)} ${(r.turn ? String(r.turn) : '').padStart(4)}`
        return (
          <Box key={r.id}>
            <Text color={props.colors[r.t] || 'gray'}>{mark === ' ' ? '■' : mark}</Text>
            <Text inverse={i === props.sel} strikethrough={r.mark === 'all'} dimColor={!!r.lock || r.mark === 'all'} color={r.err ? 'red' : undefined} wrap="truncate-end">{name + cols}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
