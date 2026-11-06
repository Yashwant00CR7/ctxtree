// A transparent region over the treemap Raster (which takes no input): it
// reports where the pointer went down, and the cell it moves to (once per
// cell, so the hooks redraw only when the block under it changes).
type Props = { w: number; h: number }

export default function Overlay(props: Props, surface: any) {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    surface.setState(1)
    let at = ''
    surface.onPointer((ev: any) => {
      if (ev.type === 'down') surface.post({ hit: true, x: ev.x, y: ev.y, button: ev.button || 'left' })
      else if (ev.type === 'move' && !ev.button && `${ev.x},${ev.y}` !== at) { at = `${ev.x},${ev.y}`; surface.post({ hover: true, x: ev.x, y: ev.y }) }
      else if (ev.type === 'leave') { at = ''; surface.post({ hover: true, leave: true }) }
    })
  }
  return <Box width={props.w} height={props.h} />
}
