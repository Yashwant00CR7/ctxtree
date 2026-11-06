# ctxtree TUI — technical design

Status: phase 1 built 2026-10-10 on Claude Code 2.1.296 (`plugins/ctxtree`,
`plugins/ctxtree-ui`, shared core in `plugins/ctxtree/core`). Automated suites green:
unit, `claude plugin test`, `verify:cc`, `verify:tui` (40 checks driving the real CLI in a
pty), `verify:real`. The manual check in vTower ([`tui-manual-check.md`](tui-manual-check.md))
is next. Target: the Claude Code mod API (early access; the bundled `claude-code.d.ts` is
the authority).
Companion to [`mod-spec.md`](mod-spec.md). Its decisions still hold: live edits, the Apply
gate, the interview, two plugins, and shared core with two adapters. This document
replaces its "keep the web UI" decision.

## Decisions

Settled with the user on 2026-10-10.

| # | Decision | Choice |
|---|---|---|
| D1 | Engine | **In the mod.** No Node sidecar. The pure engine logic becomes a shared core with no Node imports, used by the mod and the CLI; file access stays in thin adapters (`mod-spec.md`'s "shared core, two adapters") |
| — | Data source (phase 1) | **The live API**: `$.session.messages({ as: 'api' })` + `$.session.usage({ breakdown: 'full' })`. What Claude sees now, with no file read and no 4 MiB cap. Compacted-away history is not shown in phase 1 |
| D3/D4 | Layout and mouse | **Fullscreen layout only** (`/tui fullscreen`). In the classic layout `/ctxtree` prints a text summary and suggests switching. Every action still has a key |
| D3 | Pane | **Docked** beside the transcript (about 60% of the width). `z` toggles full width. Below about 140 columns, Types and Details become tabs |
| D2 | Treemap | **`Raster`** half blocks with cushion shading. Clicks through an absolute `Client` overlay if S2 passes, else `h` `j` `k` `l` only. `Image` is out: the user's terminal (vTower, xterm.js 6) loads no image addon |
| D5 | Phase 1 | Claude's tools and the shared plan; tree (by task, by type), types, details; treemap; marks, undo, review, live Apply; restore after apply. The context meter and nudge band follow right after phase 1 |
| — | Bridges from the pane | `d` → "Bridge…" asks Claude to draft the text with `$.model.fork` (a tool-less side completion over the session's own transcript: no turn, nothing added to the context). The draft shows in review, editable, before Apply. Claude's `stage` tool can still stage bridges during the interview |
| — | Originals for restore | One file per block under `~/.claude/ctxtree/originals/<session>/`, kept **30 days**, pruned at `session.start` |
| — | Staging by Claude | A band above the prompt: `N staged · −Xk   [1] open   [2] review`. Digits because only a digit reaches the band from the prompt; neither applies anything (Apply lives inside review). If the pane is open, the marks appear in it live. The pane never opens by itself |
| — | Apply during a turn | **Queued** until Claude is idle (`$.command.run({ command: 'compact' })`, which the engine holds until the turn ends; proven live). The band shows it, with a cancel button |
| — | Done means | Unit tests, hermetic end-to-end tests and pty-driven pane tests all pass; then the user runs a short manual checklist in vTower |

## Goal

Everything the web UI does, inside the Claude Code terminal, in two phases:

| Phase | Covers | Web UI |
|---|---|---|
| 1 | **The session you're in**: tree (by task, by type), types list, details, treemap, delete marks, undo, review, live Apply, restore | stays, for phase-2 features |
| 2 | **Every other session**: session picker, fork ops (uncompact, switch branch, slim), boot overhead, lineage and revert | retired when this ships |

The TUI and the Claude interview are two ways into **one plan**. A mark you make in the
tree and an item Claude stages are the same kind of entry, shown in the same review,
applied by the same press.

## What the terminal can draw

From the 2.1.289 declarations (re-checked in S0). Numbers are the engine's.

| Element | What it gives us | Limits |
|---|---|---|
| `Pane` (`$.ui.open`) | A window. In the **fullscreen** layout it docks beside the transcript, floor to ceiling, at a width we request (`columns`). `focus` + `closeOnEscape` + `holdToasts` make it behave as a dialog | Opened by the person, it seats at any width. Opened unasked, from 144 columns only |
| `Raster` | A grid of cells, each one character plus foreground and background color (24-bit). With `▀` half blocks, every cell is two vertical "pixels": a cushion-shaded treemap. `$.ui.blit` repaints it without a render pass (hover, selection) | 512 × 256 cells. No input of its own. **1,024 distinct color pairs at once**; the rest snap to the nearest. Under a terminal that doesn't advertise truecolor (vTower: `TERM=xterm-color`, no `COLORTERM`) Claude Code paints it from the 256-color palette |
| `Client` | A region drawn by our own surface module, with local state, a frame clock, **keys** (`onKey`, every key including Space) and **pointer** (`onPointer`: down / move / up / enter / leave, three buttons, no focus needed) | 20,000 nodes, 32 deep, 100,000 characters per tree. **No `Raster` inside.** Keys arrive only after a click gives it focus; Escape never arrives and hands the keyboard to the prompt |
| `Box` / `Text` | Layout, colors, bold, dim, strikethrough; `position: "absolute"` with cell offsets paints over neighbours (popups, menus); `hover` styles | Same tree bounds |
| `Button`, `Input`, `Select` | Pressable controls with hotkeys; text fields; pickers | A hotkey is one digit or one lowercase letter, live while the pane (or band) holds the keyboard. From the prompt, only a bare digit typed into an empty composer presses a **band** Button |
| `Markdown`, `Code` | Rendered text; syntax-highlighted source with a line gutter; `Code format: 'diff'` | A drawing draws its first 100,000 text characters |
| `ui.scroll` event | The wheel, arrows, PgUp/PgDn, Home/End over a pane body (`e.by`, and `e.pointer.row` for the wheel). A hook that draws its own rows answers `{}` and moves its selection | Arrows raise it only while the content is taller than the body, so the pane always draws one spare row |

Two consequences shape the design:
- **Mouse input exists only in the fullscreen layout**, which is why phase 1 targets it.
  Every action still has a key.
- **The picture and the input are different elements.** The treemap is a `Raster`.
  Clicking on it needs an invisible `Client` laid over it with `position: "absolute"`
  (spike S2), or keyboard navigation between rectangles.

## Architecture

```
┌──────────────────────────── Claude Code process ─────────────────────────────┐
│  ctxtree (core plugin)                      ctxtree-ui (plugin)               │
│  · core/: the shared engine (pure)          · Pane: tree, types, details,     │
│    map, tree, tokens, findings,               treemap                         │
│    addressing, rebuild                      · Client modules: tree.tsx,       │
│  · tools: map, inspect, stage, restore        menu.tsx, overlay.tsx           │
│  · the plan ($.state)                       · band, review dialog             │
│  · session.compact hook: rebuild + apply    · Apply press                     │
│  · turn.complete: run a queued apply        │                                 │
│  · noun $.ctxtree (mark, approve, …) ◄──────┘  (the UI reads $.state directly)│
│        │ $.session.messages / usage    │ $.fs (originals only)                │
└────────┼───────────────────────────────┼─────────────────────────────────────┘
         ▼                               ▼
   the live context window       ~/.claude/ctxtree/originals/<session>/<block>.json

   CLI and web UI (Node): src/ adapters → the same core/ modules → ~/.claude/projects/**.jsonl
```

### The shared core

The engine's logic is mostly pure already. File access sits at the edges: `map.js` reads
and stats the transcript, and `tokens.js` loads and saves calibration. The refactor:

- **`core/`** (inside the core plugin, so it ships with it): no `node:` imports. Session
  model, block classification, task grouping, tree building, token estimates, findings,
  plan addressing (`tool_use_id`, or position + fingerprint), and the message rebuild.
- **Mod adapter**: turns `$.session.messages({ as: 'api' })` into the core's session
  model, and anchors the estimates to `$.session.usage` totals.
- **Node adapter** (`src/`): turns a `.jsonl` transcript into the same model. The CLI, the
  web UI and the fork engine keep working, importing `core/` instead of their own copies.

One source of truth for classification and token math. The mod never reads transcripts in
phase 1, so the 4 MiB `$.fs.read` cap and the missing rename don't apply. Phase 2 (other
sessions, forks) has to solve them: ranged reads if the API has them, otherwise a fork
helper process. That is decided in phase 2.

### Where each edit lands

| Marked item, current session | How it applies |
|---|---|
| Tool result, tool call input, prompt, reply (phase 1) | **Live**: the plan → approve → `$.session.compact()` → core hook rebuilds every message |
| Boot overhead: MCP server, skill, CLAUDE.md, system prompt section (phase 2) | Live through `prompt.compose`, `prompt.section`, `tool.describe`, `prompt.context` hooks, or a fork plus launch profile. To be decided |
| Grey content: uncompact, switch branch (phase 2) | Live or a fork. Spike S6 |
| Slim (phase 2) | Fork only: it changes the file, not the context |
| **Any item in another session** (phase 2) | Fork, then a resume command (or `/resume`, spike S6) |

## Screen

The pane opens with `/ctxtree` or `o` on the band, with `focus` and `closeOnEscape`. It
docks beside the fullscreen transcript, and `z` widens it to the full screen:

```
┌ ctxtree · "fix login bug" · 142.3k → 98.1k tokens (−44.2k) ─── By task │ By type ┐
│ Name                                     %parent   Tokens  Items  Last │ Types    │
│ ▾ Context window                           100%   142.3k    412    48 │ ■ Read   │
│   ▾ 3 · fix the OAuth refresh              31%     44.1k     87    19 │ ■ Bash   │
│     ▸ Read src/auth/token.js  out of date  ██▌      9.8k      3    12 │ ■ Edit   │
│     ̶▸̶ ̶R̶a̶n̶ ̶n̶p̶m̶ ̶t̶e̶s̶t̶                   ██       7.2k      4    17 │ ■ MCP    │
│   ▸ 4 · add rate limiting                  22%     31.0k     64    33 │──────────│
│   ▸ Setup                                  18%     25.6k     41     0 │ Details  │
├──────────────────────────────────────────────────────────────────────┤ Read …   │
│▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│ 9.8k tok │
│ cushion-shaded treemap (Raster), selection outlined, marks hatched   │ Deleting │
│▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄│ replaces │
└ 2 marked · −44.2k   [u] undo   [r] review   [a] apply   [?] keys ────────────────┘
```

Below 140 columns, Types and Details collapse into the treemap row as tabs (`t`, `i`).

The band above the prompt, shown whenever the plan is not empty:

```
ctxtree · 3 staged · −12.4k   [1] open   [2] review
ctxtree · applying when Claude finishes · −12.4k   [2] review   [cancel]
```

## Components → elements

| Web UI | TUI | Elements | Notes |
|---|---|---|---|
| Header, session title, meter | Header row | `Box`, `Text` | Meter as text: `142.3k → 98.1k (−44.2k)` |
| View toggle (by task / by type) | Header segment | `Button` ×2, hotkeys `1` `2` | |
| Tree, with columns, sort, expand, marks | `tree.tsx` | **`Client`** | Virtualised: only visible rows are drawn (about 50 rows × 6 cells, well under 20,000 nodes). The %-of-parent bar uses block characters. Marks: strikethrough + dim. Wheel through `ui.scroll` |
| Right-click menus (delete all, ≥ size, keep latest, shrink, bridge…) | `menu.tsx` popup | `Box` `position: "absolute"` inside the tree's `Client` | Opened by right-click or `d`; arrows + Enter |
| Types list (WizTree's extension list) | Side list | `Client`, or `Select` | Selecting a type highlights its rectangles in the treemap (`$.ui.blit`) |
| Details (what it is, what deleting does, how long it lasts, preview) | Side panel | `Markdown`, `Code` | Preview capped at 6,000 characters, as today |
| Treemap (squarified, cushion-shaded, labelled bands) | Bottom region | **`Raster`**, with `overlay.tsx` (a transparent `Client`) on top for clicks | Layout and shading computed in the core. Labels are characters in cells |
| Status bar: selection, marked count, undo, review | Footer | `Text`, `Button` | |
| Review drawer (build in memory, verify, commit) | Review dialog pane | `Pane` (`focus`, `closeOnEscape`, `holdToasts`) | Same review card as Claude's plans. Bridge drafts are editable `Input`s. Verification is the core's dry-run rebuild |
| Create fork, resume command | Phase 2 | `Button`, `$.ui.copy` | |
| Session picker (⌘K) | Phase 2 | `Pane` + `Input` + `Client` list | |
| Forks, lineage, revert | Phase 2 | `Client` list | |
| Toasts | Toasts | `$.ui.toast` | |

## Input

Spike S1 settled the keyboard model: a `Client` gets keys only after a click, so the
keyboard lives at the pane level. Two modes, one map:

- **Pane mode** (after `/ctxtree`, which opens the pane with `focus`): Button hotkeys
  (one lowercase letter or digit each) and `ui.scroll` for movement. The pane always
  draws one spare row so the arrows reach `ui.scroll`.
- **Tree mode** (after clicking the tree): the tree `Client` gets every key, Space and
  arrows included, and posts them to the hooks. Esc hands the keyboard to the prompt; a
  click on the pane takes it back.

Escape always returns the keyboard to the prompt. With a menu open, it closes the menu and
the pane stays (a `ui.close` hook answers `{ deny }`); the pane is re-focused by a click
or `ctrl+x tab`.

| Key | Action | Mouse |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | Move selection | Click a row; wheel moves it |
| `l` / `h` (tree mode also `→` / `←`) | Expand / collapse | Click the ▸ triangle |
| `x` (tree mode also Space) | Mark / unmark | — |
| `d` | Menu for the selection: drop, shrink, bridge…, delete all, ≥ size, keep latest | Right-click |
| `u` | Undo the last mark | — |
| `s` | Cycle sort column | Click a column header |
| `f` | Filter the tree by name (an `Input`) | — |
| `t` / `i` | Types / details tab when narrow | Click the tab |
| `o` | Zoom the treemap into the selected band | Double-click a rectangle |
| `r` | Open review (Apply lives inside it: `a`) | Footer button |
| `1` / `2` | By task / by type | Header buttons |
| `z` | Docked ⇄ full width (a request; a width you dragged wins) | — |
| `k` | Key help | — |
| `Esc` | Close a menu, else hand the keyboard back (and close the pane) | — |

The treemap mirrors the tree's selection: selecting a row outlines its rectangle, and
clicking a rectangle selects its row. There is no separate treemap cursor.

**The band** sits above the prompt and can't hold the keyboard. From the prompt, only a
bare digit typed into an empty composer presses a band Button, so the band's buttons are
`1` (open) and `2` (review), and never apply anything themselves. Apply happens only
inside the review dialog.

## State

| Value | Where | Why |
|---|---|---|
| The map (nodes, sizes, flags) | Core plugin memory, rebuilt on `turn.complete`; the rows the pane needs are published to `$.state` (any plugin reads any plugin's state, and a read during a render subscribes the redraw) | One build per turn; the pane reads only what it draws |
| Selection, expanded set, scroll offset, sort, view, filter, width | `$.state` atoms in `ctxtree-ui` | Survive hot reloads; each write redraws only its readers |
| The plan (marks + Claude-staged items + bridge drafts) | `$.state` in `ctxtree`, exposed through `$.ctxtree` | One plan, two editors (tree and Claude) |
| Queued apply | `$.state` in `ctxtree` | Run at the next `turn.complete`; cancelled by Esc or undo |
| Undo stack | `$.state` in `ctxtree-ui` | Per session |
| Originals for restore | `$HOME/.claude/ctxtree/originals/<session>/<block>.json`, written at Apply (`$.fs.write` creates the folders; `~` is not expanded, so the path starts from `$.env.get('HOME')`) | Outlive the session for 30 days. One small file per block keeps every read far under 4 MiB. Pruned at `session.start` with `$.process.run(['find', …, '-mtime', '+30', '-delete'])` |

## Data flow

1. **Open.** `/ctxtree` → `ctxtree-ui` opens the pane → `$.ctxtree.map()` → rows for the
   visible window. In the classic layout, a text summary instead.
2. **The session grows while you look.** On `turn.complete` the core rebuilds the map
   from `$.session.messages`, and the pane redraws. Marks are keyed by `tool_use_id` or
   position + fingerprint (`mod-spec.md` § Addressing), so they survive the rebuild. A
   mark whose block changed is flagged, never moved.
3. **Mark.** `Space` / menu → plan entry in `ctxtree`'s state → meter, band and treemap
   hatching update. Claude's `stage` calls land in the same plan.
4. **Bridge.** "Bridge…" → the core drafts text for the selected blocks with
   `$.model.fork({ prompt })` (no turn, no tool, nothing added to the context) → the
   draft lands in the plan as `bridge(text)` → it appears in review, editable.
5. **Review.** `r` → the review dialog: the plan, tokens, continuity warnings, editable
   bridge drafts, and the core's dry-run (every entry resolves exactly once; tool calls
   and results stay paired).
6. **Apply.** `a` in the review dialog (a press in `ctxtree-ui`) → `$.ctxtree.approve()`
   → the originals are written → `ctxtree-ui` calls `$.session.compact()` when Claude is
   idle, or `$.command.run({ command: 'compact' })` while a turn runs (queued by the engine
   until idle; arrives as trigger `manual`, so the core hook keys on the approved plan, not
   the trigger) → the core's hook rebuilds every message and applies the plan → a toast
   with the tokens freed → the map rebuilds. The hook passes `precompute` and `auto`
   through untouched.
7. **Restore.** From the review history or `restore` (Claude's tool): read the originals,
   then the same rebuild path puts them back in place.

## Performance budget

| Path | Target | How |
|---|---|---|
| Open the pane | < 300 ms | The map is already built at the last `turn.complete` |
| Scroll / move selection | One frame | `Client` local state; only the visible window is drawn |
| Hover or select in the treemap | One frame | `$.ui.blit` repaints the Raster with no render pass |
| Rebuild after a turn | < 300 ms on a 1,000-message session | Pure core over the live messages |

## Risks and spikes

Run 2026-10-10 on Claude Code 2.1.296: the declarations read in full (S0), then live in a
hermetic sandbox (throwaway config and `HOME`, mock API) driving the real `claude` in a
pseudo-terminal, read back through xterm.js 6 (the emulator vTower uses).

| # | Question | Result |
|---|---|---|
| S0 | Has the mod API changed since 2.1.289? | Mostly additions. Changes adopted above: `precompute` compaction trigger (passed through), Raster 1,024-color-pair palette, `Code` has no 10k source cap, `$.model.fork` for drafts, `$.process.run` for deletes and renames, digit-only band hotkeys from the prompt |
| S1 | Can a `Client` get the keyboard without a click? | **No** (declared, and confirmed live). After a click it gets every key, Space included; Esc returns the keyboard to the prompt, not the pane. Keyboard model above |
| S2 | Does an absolute-positioned `Client` over a `Raster` receive the pointer? | **Yes.** The overlay got `down`/`up` at the right cell, and the Raster stayed visible under it |
| S3 | Does a large Raster count toward the 100,000-character bound? | **No.** A 512 × 256 Raster drew, and `$.ui.blit` repainted it (`{}`) |
| S5 | Wheel and keys through `ui.scroll` | **Yes:** wheel `by=±1` with the pointer's row, PgDn `by=bodyRows`. Arrows only while the content is taller than the body |
| S7 | vTower: fullscreen, half blocks, color, mouse | Fullscreen with mouse is the default on 2.1.296 here. vTower's environment (`TERM=xterm-color`, no `COLORTERM`) gets 256 colors; `COLORTERM=truecolor` gives 24-bit |
| S8 | Enough per block from the live API? | **Yes.** `messages({ as: 'api' })` has blocks intact (tool_use id/name/input, tool_result, images, thinking); newest 4,096 messages. `usage()` is free and gives the context total; `breakdown: 'full'` costs token-count requests, so it is not called per rebuild |
| S9 | Can the mod import the plain `.js` core? | **Yes**, inside its own plugin folder (live: `import … from '../core/shared.js'`). Not across plugins |
| S10 | Can `$.fs` write under `$HOME/.claude/ctxtree/`? | **Yes.** Write, read back, and `rm -rf` through `$.process.run` all worked |
| — | Apply from `ctxtree-ui`'s press | **Works:** the core hook ran (`trigger: plugin`) and the next API request carried the rebuilt messages. Queued `$.command.run({ command: 'compact' })` also reached it (`trigger: manual`) |
| — | Compaction from a plugin's own press | **Still skipped**, `.catch` included (never asked). The two-plugin split stays |
| — | `z` width toggle | **Works:** re-opening with `columns` resized the dock (400 asked → 175, the most a 200-column terminal allowed; 60 back) |
| — | Esc with a menu open | `ui.close` answering `{ deny }` keeps the pane; the keyboard goes to the prompt |
| S6 | (Phase 2) Move the session to a fork in-process? Uncompact live? | Not run yet |

## Repository layout

```
.claude-plugin/marketplace.json     lists both plugins (publishable later)
plugins/ctxtree/                    core plugin: core/, hooks/register.tsx, tools, tests
plugins/ctxtree-ui/                 UI plugin: hooks/register.tsx, tree.tsx, menu.tsx, overlay.tsx
src/                                Node adapters, CLI, web UI server (imports plugins/ctxtree/core)
```

## Built: what differs from the plan above

- Engine calls must be spelled `$.noun.method(...)` inside a hook: `$` can't be captured,
  passed or stored. So the logic lives in pure helpers, and the `$.ctxtree` noun's
  methods are stubs answered by the core plugin's own hooks on `ctxtree.<method>`.
- `ctxtree-ui` reads the plan and status from the core's state and calls the noun for
  rows (a window at a time, with `move` so selection runs over the full list), the
  treemap's cells, hit-testing, types, details, marks, bridge drafts, review, approve,
  cancel, restore and unstage.
- Apply: `$.session.compact()` when Claude is idle, else `$.command.run({ command:
  'compact' })` (queued by the engine). The core hook keys on the approved plan; a
  `.catch` makes a failed apply skip instead of falling through to a summarising
  compaction. `precompute` and `auto` pass through.
- During a turn a typed `/ctxtree review` waits in the prompt queue; the band's `2`
  works at once, so the band is the way to apply while Claude works.
- Images and documents can't be carried by a rebuilt message (SessionMessage has text
  and tool blocks only), so Apply removes every image in the conversation. The review
  counts them from `$.session.messages({ as: 'api' })` and warns. Keeping them would
  need handle-kept messages, which revert on resume (mod-spec spike).
- The pane opens at about 60% of the terminal (`e.presentation.columns`). Below 110
  columns there is no side column: `t` / `i` / `k` swap the treemap for types,
  details or keys, and the same key brings the map back.

## Details timeline and side tabs (2026-10-28)

Decided with the user on 2026-10-28, after their first look at the web UI: the Types
box crowded out the content they wanted to read.

| Decision | Choice |
|---|---|
| Types box | A **tab behind Details**, both full height of the side column. Web: click, or `i` / `t`. Pane: `i` / `t` / `k` at any width |
| A task in Details | **Its timeline**: your message in full, then each tool call as one row (name, tokens, out-of-date, error, mark), with Claude's replies in between. A row opens in place to show what Claude sent and what came back. Each row marks on its own, the same marks the tree uses |
| Large output | The first **20,000 characters**, then "Show all" (web) or `a` (pane) loads the rest. Replaces the old 6,000 cap |
| Where | Web UI and pane, from one core function (`core/timeline.js`) |

- The task's items are now kept in the order they happened (an attachment sits where it
  arrived), and runs of attachments fold into one line.
- Web: `/api/timeline?sid&id`, and `/api/block` takes `offset` and `full=1`.
- Pane: `$.ctxtree.timeline({ id, open, all })` returns the entries, with text only for
  the open calls. The reader (`hooks/lines.js` lays it out, `hooks/reader.tsx` draws a
  window of it) takes its keys after a click: ↑↓/`j` `k` move, Enter/`l` open, `a` all of
  it, `e` open every call, `x`/Space mark, PgUp/PgDn and the wheel scroll. The side
  column is now about 42% of the pane (it was 28%).

## Live Apply is off where Claude Code's security default runs (2.1.312) — superseded 2026-11-05

Found 2026-10-28. Claude Code 2.1.312 bundles `cc-plugin-sec-default`. It sits outermost
on machines with managed settings (this Mac has
`/Library/Application Support/ClaudeCode/managed-settings.json`) and in Team and
Enterprise organizations, and it sends `session.compact` past every plugin a person
installs (`ctxtree: session.compact bypassed by cc-plugin-sec-default`). ctxtree's rebuild
never runs, and **Claude Code's own summarising compaction runs instead.**

ctxtree now reads the plugin order at `engine.create`. When the security default sits
above it, `approve` refuses, the review says why and shows no Apply, and the status
carries the reason (`status.blocked`). The pane suite checks that refusal and reports
the Apply scenarios as cut short. Only managed settings (`prependPlugins`) can move the
security default. The way through is the fallback in `mod-spec.md`: Apply writes a
verified fork and you resume it.

## Hard delete, and Apply always writes a fork (2026-11-05)

Decided with the user (one question at a time, each answered):

- **Hard delete only.** A delete leaves no trace in the fork: no placeholder note, no
  call. Two sizes: a **task** (your message to your next one: every record between,
  but boot attachments and the prompt snapshot) and a **tool step** (the assistant
  message that called a tool, every call in it, their results, and records Claude
  Code wrote about those calls: hook output, progress). Your message and Claude's
  last words only go with their task; an attachment goes alone; an image comes out
  of your message and your words stay. Placeholder ("tombstone") and shrink deletes
  are gone from both UIs. Old forks keep theirs.
- `restructure.js` `planDrop` drops whole API messages (every record sharing a
  message id), closes over call ↔ result, re-links what follows onto the nearest
  kept record, drops the `last-prompt` and `queue-operation` copies of a deleted
  prompt, and pins the leaf: the fork resumes at the last kept message of the
  resumed chain (a rewound branch written later would otherwise take over, so it
  leaves the fork). `verifyStructure` adds: Claude's turns and yours still
  alternate (counted before and after the drop), something is left to resume, and
  the leaf is the pinned one. Every fork leaves Claude Code's request journal
  (`api-request`, `api-request-blob`, `api-request-shape`, 2.1.312+) behind: it
  copies message text, and resume rebuilds requests from the messages.
- The map hands out `act.k === 'drop'` with a unit key (`task:…`, `step:<message
  id>`, `att:<uuid>`), `img`, or `boot`; `map.units` (not serialised) names each
  unit's records. Leaves of one unit share its key; each act carries its leaf's own
  tokens, so totals add up once. Marking a task-bound act marks the whole task;
  keeping any part of a marked task keeps the task (both UIs and the plugin).
- **Apply always writes a fork**, in the web UI and the pane. The live rebuild at
  `session.compact`, bridge, restore, and the guard for `cc-plugin-sec-default` are
  removed (`core/plan.js` is gone). The pane maps the session's transcript file (as
  the web UI does) so its marks name what the fork writer deletes. The mod reads it
  with `$.process.spawn(['cat', …])` (`$.fs.read` stops at 4 MiB), builds the fork
  with `core/fork.js` (the server's own builder), writes a hidden temp file, reads it
  back, `mv -n`s it into place, appends to `~/.claude/ctxtree/lineage.jsonl`, and
  opens `vtower://resume/<fork>?cwd=<folder>` with `open`.
- **vTower contract** (the user builds the vTower side): the link names the session
  and its folder, never a command; vTower checks both, opens a tab there and runs
  `ctxtree resume <fork>`, so a launch profile applies. The pane opens the fork at
  once after Apply; the web UI's Fork created screen and Forks list have Open in
  vTower (the server runs `open`). `CTXTREE_NO_VTOWER=1` turns it off.
- Pane treemap: a dark seam on each block's right and bottom edge, three
  brightness tiers by size, the size printed in nearly every block, a grey outline
  on the block under the pointer, and the footer names it with its share.
- Web UI: Bash calls are named by their own description, files by a short path;
  the tree is only as tall as its rows (the divider sets the most) and the treemap
  takes the rest of the left column; Details/Types run the full height; ✕ on rows
  and blocks, ⌫ anywhere; the server watches `~/.claude/projects` (incremental
  rescan, 48 ms) and the page polls `/api/version`, reloading the open session in
  place when nothing is marked.

Verified: `npm test` 78, `claude plugin test` 6, `verify:cc` 55 (three forks
resumed by the real CLI: a step, a task, the latest task), `verify:real` (every
task alone 470/470, sampled steps 1,589/1,589, all but the latest task 82/82 across
88 real sessions), `verify:tui` 42 (a fork written from the pane, opened through a
stand-in `open`, resumed by the real CLI).

## Phase plan

1. Spikes S0–S3, S5, S7–S10 (done 2026-10-10).
2. Shared core: extract the pure logic into `plugins/ctxtree/core/`; `src/` imports it;
   the existing 56 tests still pass. (Done.)
3. `ctxtree` core plugin: mod adapter, map, plan, noun, compact hook, queued apply,
   originals, Claude tools (from `mod-spec.md`).
4. `ctxtree-ui`: band, pane shell, header, footer, tree `Client`, details.
5. Treemap `Raster` and overlay, types list, selection sync.
6. Marks, menus, undo, bridges, review dialog, Apply, restore.
7. Tests: unit, hermetic end-to-end, pty-driven pane. Then the manual checklist in vTower.

Steps 3 to 7 are done (2026-10-10) except the manual checklist.
8. Phase 2: spike S6, session picker, fork ops, boot overhead, lineage. Then retire the
   web UI.
