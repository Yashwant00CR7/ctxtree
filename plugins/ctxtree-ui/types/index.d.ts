// ctxtree-ui's state: where the person is in the pane. The plan itself is the
// ctxtree core plugin's (read from its state, changed through $.ctxtree).

export type CtxtreeUiUndo = { ids: string[]; op: 'mark' | 'unmark' }

// The Details reader: which selection it shows, the tool calls opened in it,
// the ones loaded in full, the first row in view and the entry under the cursor.
export type CtxtreeUiDetail = {
  sel: string
  open: string[]
  all: string[]
  top: number
  cur: number
}

export type CtxtreeUiState = {
  view: 'task' | 'type'
  expandedTask: string[]
  expandedType: string[]
  sel: string
  sort: 'tok' | 'turn' | 'name'
  filter: string
  filtering: boolean
  menu: boolean
  wide: boolean
  side: 'map' | 'types' | 'details' | 'keys'
  dimType: string
  undo: CtxtreeUiUndo[]
  msg: string
  detail: CtxtreeUiDetail
  // the treemap block under the pointer ('' when none)
  hover: string
}

declare module 'claude-code' {
  interface PluginState {
    'ctxtree-ui': {
      ui: CtxtreeUiState
      note: string
    }
  }
}
