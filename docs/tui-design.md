# ctxtree TUI — technical design

Status: draft for decision, 2026-10-05. Nothing built. Target: Claude Code 2.1.289 mod API
(early access; the bundled `claude-code.d.ts` is the authority).
Companion to [`mod-spec.md`](mod-spec.md), whose decisions (live edits, the Apply gate, the
interview, two plugins) all still hold. This document replaces its "keep the web UI"
decision.

## Goal

Everything the web UI does, inside the Claude Code terminal, in two phases:

| Phase | Covers | Web UI |
|---|---|---|
| 1 | **The session you're in**: tree (by task, by type), types list, details, treemap, delete marks, undo, review, live Apply | stays, for phase-2 features |
| 2 | **Every other session**: session picker, fork ops (uncompact, switch branch, slim), boot overhead, lineage and revert | retired when this ships |

The TUI and the Claude interview are two ways into **one plan**. A mark you make in the
tree and an item Claude stages are the same kind of entry, shown in the same review,
applied by the same press.

## What the terminal can draw

From the 2.1.289 declarations. Numbers are the engine's.

| Element | What it gives us | Limits |
|---|---|---|
| `Pane` (`$.ui.open`) | A window. In the **fullscreen** layout it docks beside the transcript, floor to ceiling, at a width we request (`columns`). On the main screen it opens inline above the prompt (`rows`). `focus` + `closeOnEscape` + `holdToasts` make it behave as a dialog | Opened by the person, it seats at any width. Opened unasked, from 144 columns only |
| `Raster` | A grid of cells, each one character plus foreground and background color (24-bit). With `▀` half blocks, every cell is two vertical "pixels": a cushion-shaded treemap. `$.ui.blit` repaints it without a render pass (hover, selection) | 512 × 256 cells. No input of its own |
| `Image` | Real pixels (`{ rgba, width, height }`, ≤ 2 MiB decoded, so about 800 × 600) over a box of cells, via the kitty graphics protocol | kitty and Ghostty only; elsewhere its `alt` text. No input of its own |
| `Client` | A region drawn by our own surface module, with local state, a frame clock, **keys** (`onKey`: arrows, Enter, Tab, letters, modifiers) and **pointer** (`onPointer`: down / move / up / enter / leave, left / middle / right button, sub-cell position on kitty, Ghostty, iTerm2, WezTerm, foot) | 20,000 nodes, 32 deep, 100,000 characters per tree. **No `Raster` or `Image` inside.** Keys arrive only after a click gives it focus |
| `Box` / `Text` | Layout, colors, bold, dim, strikethrough; `position: "absolute"` with cell offsets paints over neighbours (popups, context menus); `hover` styles | Same tree bounds |
| `Button`, `Input`, `Select` | Pressable controls with hotkeys; text fields; pickers | Keys while the site holds the keyboard |
| `Markdown`, `Code` | Rendered text; syntax-highlighted source with a line gutter | `Code` ≤ 10,000 characters |
| `ui.scroll` event | The person's wheel or scroll keys over a pane body, so a virtualised list scrolls on the wheel | — |

Two consequences shape the design:
- **Mouse input exists only in Claude Code's fullscreen terminal layout.** The main screen
  is keyboard-only, so every action needs a key.
- **The picture and the input are different elements.** The treemap is a `Raster` (or
  `Image`). Clicking on it needs either an invisible `Client` laid over it with
  `position: "absolute"` (unproven, spike S2), or keyboard navigation between rectangles.

## Architecture

```
┌──────────────────── Claude Code process ────────────────────────┐
│  ctxtree (core plugin)                ctxtree-ui (plugin)        │
│  · tools: map, inspect, stage,        · Pane: tree, types,       │
│    restore (Claude's way in)            details, treemap         │
│  · the plan ($.state)                 · Client modules:          │
│  · session.compact hook:                tree.tsx, menu.tsx       │
│    rebuild + apply live               · band, review dialog      │
│  · noun $.ctxtree (approve, plan)     · Apply press              │
│            │  $.http.fetch({ socketPath })   │                   │
└────────────┼─────────────────────────────────┼───────────────────┘
             ▼                                 ▼
   ctxtree engine sidecar: node bin/ctxtree.js serve --socket <run dir>/ctxtree.sock
   (today's src/ unchanged: scan, session, map, surgery, fork, boot, restructure)
             │ reads / writes
             ▼
   ~/.claude/projects/**.jsonl   ~/.claude/ctxtree/{lineage.jsonl, profiles, originals}
```

### Why an engine sidecar

The mod environment can't run the engine directly on real transcripts:
- `$.fs.read` caps at **4 MiB** per read, and `$.process.run` caps output at 4 MiB. Long
  sessions are bigger than that.
- `$.fs` has **no rename or delete**, so forks can't be written atomically.
- `src/` uses `node:fs`, `node:crypto` and `child_process` (the APFS clone).

`$.process.spawn` can keep one child alive for the whole session (started in
`session.start`, killed with the module), and `$.http.fetch` can talk to it over a **Unix
socket** (`socketPath`). The existing `server.js` already exposes exactly what the web UI
uses (`/api/sessions`, `/api/map`, `/api/block`, `/api/fork`, `/api/forks`,
`/api/revert`, `/api/refresh`). It only needs a `--socket` mode.

What this buys:
- The engine and its invariants stay as they are: one source of truth for the CLI, the
  web UI during the transition, and the TUI.
- **The "shared core, two adapters" refactor in `mod-spec.md` is no longer needed.**
  The mod keeps only what must run in-process: rendering, input, plan state, and the
  compact-hook rebuild (small and pure).
- A Unix socket under the session's run directory needs no port, token or CORS. Only the
  user's processes can reach it.

What it costs:
- **Node on `PATH`**, checked at `session.start`. Without it, the TUI and fork ops are off
  and Claude's interview still works on live messages only (`$.session.messages`).
- One process per Claude Code session (idle, holding the parsed model in memory).
- Spike S4 must confirm the socket path, startup time and lifetime.

### Where each edit lands

| Marked item, current session | How it applies |
|---|---|
| Tool result, tool call input, prompt, reply (phase 1) | **Live**: the plan → approve → `$.session.compact()` → core hook rebuilds every message |
| Boot overhead: MCP server, skill, CLAUDE.md, system prompt section (phase 2) | Live through `prompt.compose`, `prompt.section`, `tool.describe`, `prompt.context` hooks, or a fork plus launch profile. To be decided |
| Grey content: uncompact, switch branch (phase 2) | Live (the rebuilt list can carry the restored history, read by the sidecar) or a fork. Spike S6 |
| Slim (phase 2) | Fork only: it changes the file, not the context |
| **Any item in another session** (phase 2) | Fork through the sidecar, then a resume command (or `/resume`, spike S6) |

## Screen

The pane opens with `/ctxtree` (or `o` from the band), with `focus` and `closeOnEscape`.
Docked beside a fullscreen transcript at 100+ columns, or as a takeover dialog (decision D3):

```
┌ ctxtree · "fix login bug" · 142.3k → 98.1k tokens (−44.2k) ─── By task │ By type ┐
│ Name                                     %parent   Tokens  Items  Last │ Types    │
│ ▾ Resumed context                          100%   142.3k    412    48 │ ■ Read   │
│   ▾ 3 · fix the OAuth refresh              31%     44.1k     87    19 │ ■ Bash   │
│     ▸ Read src/auth/token.js  out of date  ██▌      9.8k      3    12 │ ■ Edit   │
│     ̶▸̶ ̶R̶a̶n̶ ̶n̶p̶m̶ ̶t̶e̶s̶t̶                   ██       7.2k      4    17 │ ■ MCP    │
│   ▸ 4 · add rate limiting                  22%     31.0k     64    33 │──────────│
│   ▸ Setup                                  18%     25.6k     41     0 │ Details  │
│ ▸ Outside resumed context (grey)            —      61.0k    203     — │ Read …   │
├──────────────────────────────────────────────────────────────────────┤ 9.8k tok │
│▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│ Deleting │
│ cushion-shaded treemap (Raster), selection outlined, marks hatched   │ replaces │
│▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄│ it with… │
└ 2 marked · −44.2k   [u] undo   [r] review   [a] apply   [?] keys ────────────────┘
```

Below 140 columns, Types and Details collapse into the treemap row as tabs (`t`, `i`).

## Components → elements

| Web UI | TUI | Elements | Notes |
|---|---|---|---|
| Header, session title, meter | Header row | `Box`, `Text` | Meter as text: `142.3k → 98.1k (−44.2k)` |
| View toggle (by task / by type) | Header segment | `Button` ×2, hotkeys `1` `2` | |
| Tree, with columns, sort, expand, marks | `tree.tsx` | **`Client`** | Virtualised: only visible rows are drawn (about 50 rows × 6 cells, well under 20,000 nodes). The %-of-parent bar uses block characters. Marks: strikethrough + dim. Wheel through `ui.scroll` |
| Right-click menus (delete all, ≥ size, keep latest; uncompact / switch / slim on grey) | `menu.tsx` popup | `Box` `position: "absolute"` inside the tree's `Client` | Opened by right-click or `m`; arrows + Enter |
| Types list (WizTree's extension list) | Side list | `Client`, or `Select` | Selecting a type highlights its rectangles in the treemap (`$.ui.blit`) |
| Details (what it is, what deleting does, how long it lasts, preview) | Side panel | `Markdown`, `Code` | Preview capped at 6,000 characters, as today |
| Treemap (squarified, cushion-shaded, labelled bands) | Bottom region | **`Raster`** (default) or **`Image`** (kitty/Ghostty) | Layout and shading computed by the sidecar (it has the sizes) or by the mod. Labels are characters in cells |
| Status bar: selection, marked count, undo, review | Footer | `Text`, `Button` | |
| Review drawer (build in memory, verify, commit) | Review dialog pane | `Pane` (`focus`, `closeOnEscape`, `holdToasts`) | Same review card as Claude's plans; the sidecar dry-run fork verifies |
| Create fork, resume command | Phase 2 | `Button`, `$.ui.copy` | Copies `claude --resume <fork>` to the clipboard |
| Session picker (⌘K) | Phase 2 | `Pane` + `Input` + `Client` list | Fuzzy filter over `/api/sessions` |
| Forks, lineage, revert | Phase 2 | `Client` list | |
| Toasts | Toasts | `$.ui.toast` | |

## Input

Every action has a key. The mouse is a shortcut, available only in fullscreen.

| Key | Action | Mouse |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | Move selection | Click a row; wheel scrolls |
| `→` / `←` | Expand / collapse | Click the ▸ triangle |
| `Enter` | Show details; on a treemap band, zoom into it | Double-click |
| `Space` | Mark / unmark | — |
| `d` or `⌫` | Delete menu for the selection | Right-click |
| `u` | Undo the last mark | — |
| `s` | Cycle sort column | Click a column header |
| `/` | Filter the tree by name | — |
| `Tab` | Move focus: tree → types → details → treemap | Click a region |
| `h` `j` `k` `l` in the treemap | Move to the neighbouring rectangle | Click a rectangle (spike S2) |
| `r` / `a` | Open review / apply | Buttons in the footer |
| `1` / `2` | By task / by type | Header buttons |
| `?` | Key help | — |
| `Esc` | Close a menu, then the pane | — |

## State

| Value | Where | Why |
|---|---|---|
| The map (nodes, sizes, flags) | Sidecar memory, fetched per view | Too big for a `$.state` value; rows are fetched per scroll window |
| Selection, expanded set, scroll offset, sort, view, filter | `$.state` atoms in `ctxtree-ui` | Survive hot reloads; each write redraws only its readers |
| The plan (marks + Claude-staged items) | `$.state` in `ctxtree`, exposed through the `$.ctxtree` noun | One plan, two editors (tree and Claude) |
| Undo stack | `$.state` in `ctxtree-ui` | Per session |
| Dropped originals for restore | Sidecar, under `~/.claude/ctxtree/originals/` | Outlive the session; no 4 MiB cap |

## Data flow

1. **Open.** `/ctxtree` → `ctxtree-ui` opens the pane → `GET /api/map?sid=<current>` over the socket → rows for the visible window.
2. **The session grows while you look.** On `turn.complete` the core plugin calls
   `/api/refresh`, and the pane redraws with new turns appended. Marks are keyed by
   `tool_use_id` or position + fingerprint (`mod-spec.md` § Addressing), so they survive
   the refresh. A mark whose block changed is flagged, never moved.
3. **Mark.** `Space` / menu → plan entry in `ctxtree`'s state → meter and treemap hatching
   update.
4. **Review.** `r` → the review dialog: the plan, tokens, continuity warnings, and the
   sidecar's dry-run verification.
5. **Apply.** `a` (a press in `ctxtree-ui`) → `$.ctxtree.approve(planId)` →
   `$.session.compact()` → the core plugin's hook rebuilds every message and applies the
   plan → a toast with tokens freed → `/api/refresh`.

## Performance budget

| Path | Target | How |
|---|---|---|
| Open the pane on a 5 MB session | < 1 s | Sidecar already holds the parsed model (warmed at `session.start`) |
| Scroll / move selection | One frame | `Client` local state; only the visible window is drawn |
| Hover or select in the treemap | One frame | `$.ui.blit` repaints the Raster with no render pass |
| Refresh after a turn | < 300 ms | Incremental parse of appended records |

## Risks and spikes

Each is a small throwaway test in the spike sandbox, before phase 1 is built.

| # | Question | If it fails |
|---|---|---|
| S1 | Can a `Client` get the keyboard without a click (pane opened with `focus`, `$.ui.focus`)? | Keyboard-first breaks on the main screen. Fallback: `Button` hotkeys and `Select` for navigation, with the `Client` for mouse only |
| S2 | Does an absolute-positioned `Client` over a `Raster` receive the pointer? | Treemap is keyboard-selected only, or drawn as flat-colored text runs inside a `Client` (no cushion shading) |
| S3 | Does a large Raster's `cells` string count toward the 100,000-character tree bound? | Smaller treemap, or draw it once and update with `$.ui.blit` only |
| S4 | Sidecar over a Unix socket: `$.http.fetch` with `socketPath`, startup time, lifetime under `$.process.spawn`, response size | `$.process.run` one-shot calls (slower), or a localhost port with the existing token |
| S5 | Scrolling by wheel through `ui.scroll` in a pane that draws its own virtual rows | Keys only |
| S6 | Can the mod move the session to a fork in-process (`$.command.run({ command: "resume" })`)? Can uncompact be applied live? | Phase-2 fork ops copy a resume command instead |
| S7 | Does your terminal support kitty graphics (kitty, Ghostty)? 24-bit color? | `Raster` only. Without truecolor, a reduced palette |

## Open decisions

To settle after this document:

- **D1 Engine:** sidecar over a Unix socket (this document's recommendation), or the
  in-mod core from `mod-spec.md`.
- **D2 Treemap:** `Raster` everywhere, `Image` where supported with `Raster` fallback, or
  text runs in a `Client` (interactive, flat).
- **D3 Layout:** docked beside the transcript, a full takeover dialog, or both (a key
  toggles).
- **D4 Mouse:** fullscreen required for mouse, keyboard everywhere (recommended), or
  keyboard only.
- **D5 Phase-1 cut line:** confirm what ships first (the table under *Goal*).

## Phase plan

1. Spikes S1–S5 and S7.
2. Sidecar: `serve --socket`, warm-up, incremental refresh, the `/api/map` window query.
3. `ctxtree` core plugin: plan, noun, compact hook, Claude tools (from `mod-spec.md`).
4. `ctxtree-ui`: pane shell, header, footer, tree `Client`, details.
5. Treemap `Raster`, types list, selection sync.
6. Marks, menus, undo, review dialog, Apply.
7. Phase 2: spike S6, session picker, fork ops, boot overhead, lineage. Then retire the
   web UI.
