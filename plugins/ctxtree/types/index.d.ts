// The ctxtree core plugin's contract: its state (read by ctxtree-ui and any
// plugin) and the $.ctxtree noun (the pane's way to change the plan).

// One marked deletion: a map action (core/map.js). `drop` takes a whole unit
// (a task, a tool step, an attachment) out of the fork; `img` takes an image
// out of your message; `boot` removes setup overhead. Keyed as the web UI keys
// its marks (view.js actKey).
export type CtxtreeEntry = {
  key: string
  k: 'drop' | 'img' | 'boot'
  id: string
  fp?: string
  // the task this entry can only go with (your message, Claude's last words)
  task?: string
  by: 'you' | 'claude'
  name: string
  t: string
  tok: number
  save: number
  problem?: string
}

export type CtxtreePlan = {
  entries: CtxtreeEntry[]
}

// What the last Apply wrote: a fork of this session, opened in vTower when it
// is installed.
export type CtxtreeFork = {
  forkSid: string
  at: number
  saved: number
  resumeCmd: string
  opened: boolean
}

export type CtxtreeStatus = {
  version: number
  tokens: number
  window: number
  turns: number
  busy: boolean
  applying: 'idle' | 'writing'
  lastApply: CtxtreeFork | null
  error: string
}

export type CtxtreeRow = {
  id: string
  depth: number
  name: string
  sub: string
  t: string
  tok: number
  n: number
  turn: number
  pct: number
  kids: boolean
  open: boolean
  mark: '' | 'some' | 'all'
  save: number
  lock: string
  warn: string
  stale: number
  err: number
  latest: number
  deletable: boolean
}

export type CtxtreeView = 'task' | 'type'

export type CtxtreeRowsArgs = {
  view: CtxtreeView
  expanded: string[]
  sort: string
  filter: string
  sel: string
  top: number
  count: number
  move: number
}

export type CtxtreeRows = {
  rows: CtxtreeRow[]
  top: number
  sel: number
  selId: string
  total: number
  version: number
  title: string
  selRow: CtxtreeRow | null
  parent: string
}

export type CtxtreeTreemapArgs = {
  view: CtxtreeView
  columns: number
  rows: number
  sel: string
  dimType: string
  hover?: string
}

export type CtxtreeHitArgs = {
  view: CtxtreeView
  columns: number
  rows: number
  x: number
  y: number
}

export type CtxtreeType = { t: string; name: string; tok: number; n: number; color: number }

export type CtxtreeDetails = {
  id: string
  name: string
  kind: string
  tok: number
  turn: number
  info: string
  warn: string
  lock: string
  stale: string
  preview: string
  truncated: boolean
  path: string[]
}

// One step of a task's timeline (core/timeline.js). A tool call's parts are
// what Claude sent and what came back; their text is filled for the entries
// asked to be open, 20,000 characters unless all of it was asked for.
export type CtxtreeTimelinePart = {
  id: string
  role: 'sent' | 'got'
  chars: number
  text?: string
  next?: number
}

export type CtxtreeTimelineEntry = {
  id: string
  kind: 'prompt' | 'reply' | 'tool' | 'attach' | 'image' | 'other'
  name: string
  t: string
  tok: number
  turn: number
  deletable: boolean
  lock: string
  err?: boolean
  stale?: string
  text?: string
  chars?: number
  truncated?: boolean
  count?: number
  parts?: CtxtreeTimelinePart[]
  mark?: '' | 'some' | 'all'
}

export type CtxtreeTimelineArgs = {
  id: string
  open: string[]
  all: string[]
}

export type CtxtreeReviewItem = CtxtreeEntry & { ok: boolean }

// The plan, checked by building the fork in memory (nothing is written).
export type CtxtreeReview = {
  items: CtxtreeReviewItem[]
  // tokens the fork resumes without, measured on the built fork
  save: number
  // the fork verified: every call pairs, the turns alternate, the chain holds
  verified: boolean
  problems: string[]
  tasks: number
  vtower: boolean
}

export type Ctxtree = {
  refresh: (args: { why: string }) => Promise<{ version: number }>
  rows: (args: CtxtreeRowsArgs) => Promise<CtxtreeRows>
  treemap: (args: CtxtreeTreemapArgs) => Promise<{ cells: string; version: number }>
  hit: (args: CtxtreeHitArgs) => Promise<{ id: string; ancestors: string[] }>
  types: (args: { view: CtxtreeView }) => Promise<CtxtreeType[]>
  details: (args: { id: string }) => Promise<CtxtreeDetails>
  timeline: (args: CtxtreeTimelineArgs) => Promise<{ entries: CtxtreeTimelineEntry[] }>
  mark: (args: { ids: string[]; op: 'toggle' | 'mark' | 'unmark' }) => Promise<{ count: number }>
  unstage: (args: { keys: string[] }) => Promise<{ count: number }>
  review: (args: { why: string }) => Promise<CtxtreeReview>
  // writes the fork and opens it in vTower
  approve: (args: { why: string }) => Promise<{ ok: boolean; problems: string[]; fork?: CtxtreeFork }>
  open: (args: { forkSid: string }) => Promise<{ ok: boolean; error: string }>
}

declare module 'claude-code' {
  interface EngineInterface {
    ctxtree: Ctxtree
  }
  interface PluginState {
    ctxtree: {
      plan: CtxtreePlan
      status: CtxtreeStatus
    }
  }
}
