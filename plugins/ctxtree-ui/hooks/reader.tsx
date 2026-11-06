// The Details reader: a window of rows the hooks laid out (lines.js). A click
// says which row; once clicked, every key reaches it. It posts what happened;
// the hooks module decides what it means.
type Line = { t: string; s: string; c?: boolean }
type Props = { lines: Line[]; width: number }

const STYLE: Record<string, Record<string, unknown>> = {
  title: { bold: true },
  dim: { dimColor: true },
  warn: { color: 'yellow' },
  label: { dimColor: true, bold: true },
  prompt: { color: '#e2b04c', bold: true },
  reply: { color: '#d98a5a', bold: true },
  tool: { bold: true },
  gone: { dimColor: true, strikethrough: true },
  msg: {},
  body: { dimColor: true },
}

let cur: Props = { lines: [], width: 40 }

export default function Reader(props: Props, surface: any) {
  cur = props
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(1)
    surface.onPointer((ev: any) => {
      if (ev.type !== 'down' || !cur.lines[ev.y]) return
      surface.post({ click: ev.y, button: ev.button || 'left' })
    })
    surface.onKey((ev: any) => surface.post({ key: ev.key, shift: !!ev.shift, ctrl: !!ev.ctrl }))
  }
  return (
    <Box flexDirection="column" width={props.width}>
      {props.lines.map((l, i) => (
        <Text key={`l${i}`} {...(STYLE[l.s] || {})} inverse={!!l.c} wrap="truncate-end">{l.t || ' '}</Text>
      ))}
    </Box>
  )
}
