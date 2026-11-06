# ctxtree walkthrough

ctxtree is **WizTree for Claude's context window**: it shows what fills the context of a
Claude Code session, block by block, and lets you take out what no longer earns its
place: stale file reads, old test runs, huge logs, long tool inputs. You can drop them,
shrink them, or replace them with a short summary.

There are two ways to use it:

| | **Inside Claude Code: the ctxtree mod** | **Outside: the CLI and the web UI** |
|---|---|---|
| Works on | the session you are in, live | any session on disk |
| How an edit lands | the conversation Claude sees is rebuilt in place; you keep working | a verified **fork** (a new session) you resume |
| Extra powers | Claude can map the window and plan a cleanup with you | boot overhead (MCP servers, skills, CLAUDE.md), compacted history, rewound branches, lineage |
| Start | `/ctxtree` | `npx ctxtree` |

Every screenshot here was taken from the real Claude Code (2.1.296) and the real ctxtree,
driven by a script on a demo project (`acme-api`) in a sandbox: an afternoon of fixing a
login bug, adding a rate limiter, reading a 1,800-line server log, looking at a
screenshot and editing the README. The script is `test/tui/shots/` (see
[Regenerating these screenshots](#regenerating-these-screenshots)).

**Contents**

1. [The ideas in two minutes](#1-the-ideas-in-two-minutes)
2. [Install and open](#2-install-and-open)
3. [Reading the map](#3-reading-the-map)
4. [Editing the context](#4-editing-the-context)
5. [Asking Claude to clean up](#5-asking-claude-to-clean-up)
6. [Applying while Claude works](#6-applying-while-claude-works)
7. [Terminals and layouts](#7-terminals-and-layouts)
8. [How it works](#8-how-it-works)
9. [Outside Claude Code: the web UI and CLI](#9-outside-claude-code-the-web-ui-and-cli)
10. [Recipes: using it efficiently](#10-recipes-using-it-efficiently)
11. [Reference](#11-reference)

---

## 1. The ideas in two minutes

**What fills the window.** Every request Claude Code sends carries three things:

- **Setup**: the system prompt, the tool definitions, MCP servers, skills, CLAUDE.md
  and memory. Loaded before your first message, sent every turn.
- **Tool results**: every file read, command output, search result and web page, kept
  for the rest of the session even when a later turn made it out of date.
- **The conversation**: your prompts, Claude's replies, and the tool calls themselves
  (including the full contents of every file Claude wrote).

Tool results are usually the bulk, and most of them stop mattering an hour later.
Claude Code's own `/compact` throws the details of *everything* away for a summary;
ctxtree removes *exactly what you choose* and leaves the rest word for word.

**The three edits.**

| Edit | Works on | What Claude sees afterwards |
|---|---|---|
| **Drop** | a tool result, a prompt, a reply | a one-line tombstone: `[ctxtree: removed Read result for /…/acme-api/logs/server.log (~34,529 tokens) to reclaim context. Re-run it if you need it again.]` The call stays, so Claude knows it happened and can re-run it. |
| **Shrink** | a tool call's input | long strings (file contents written, edit text) cut to their first line plus a note; the call and its result stay paired |
| **Bridge** | a tool result, a prompt, a reply | a short summary, drafted by Claude and editable by you, in place of the original |

**The safety rules.** Nothing changes until you press **Apply** in the review. Claude
can plan a cleanup but has no way to apply it. Every edit is checked against the
conversation as it is at that moment; anything that no longer matches is refused, never
moved. Everything removed is saved and can be **restored** for 30 days.

---

## 2. Install and open

**Run it from the repo** (two plugins: the core and the UI):

```bash
claude --plugin-dir plugins/ctxtree --plugin-dir plugins/ctxtree-ui
```

**Or install it** once; it stays read from your working copy, so edits apply after
`/reload-plugins`:

```bash
claude plugin marketplace add ~/path/to/ctxtree
claude plugin install ctxtree@ctxtree
claude plugin install ctxtree-ui@ctxtree
```

The pane needs Claude Code's **fullscreen layout** (the default in 2.1.296; switch with
`/tui fullscreen`). Here is the session we will clean up, before opening anything:

![A Claude Code session in the fullscreen layout, after five tasks](walkthrough/img/01-session.png)

Type **`/ctxtree`**. The pane docks beside the transcript:

![The ctxtree pane docked beside the transcript](walkthrough/img/02-overview.png)

1. **Header**: tokens in the context now, out of the window (and, once you mark
   things, what it would drop to). Then the session's title.
2. **View**: `1` by task, `2` by type.
3. **The tree**: one row per task (the prompts you typed), with what Claude did for
   each inside. Columns: `%parent` bar, tokens, items, the turn it was last touched.
4. **The treemap**: every block in the window as a rectangle sized by tokens, shaded
   like WizTree. Blue here is Setup; red is file reads.
5. **Side column**: details of the selection (switches to types or keys).
6. **Status line**: what is marked and how much it frees; messages.
7. **Key bar**: every key the pane answers.

`Esc` hands the keyboard back to the prompt (and closes the pane). Nothing you do in the
pane interrupts Claude: you can browse while it works.

---

## 3. Reading the map

### By task

Each task is a prompt you typed, with everything Claude did for it. Open one with `l`
(or click its ▸):

![A task opened in the by-task view](walkthrough/img/03-by-task.png)

1. The task: *"The login keeps failing right after a token refresh"*.
2. **out of date**: Claude read `src/auth/token.js` and later edited it, so the copy in
   the context is stale. Re-reads and re-runs are flagged the same way. Stale items are
   the safest things to drop.

Rows in **red** are tool calls that failed (here, the first test run). A tool call and
its result show as one row ("Read src/auth/token.js"); `Claude:` and `You:` rows are the
conversation.

### Details

Select a row (arrows, or click) and the side column explains it: where it sits, its
size and turn, what deleting it does, and a preview of the content:

![Details of a stale file read](walkthrough/img/04-details.png)

### By type

`2` regroups the same blocks by kind: Setup, Tool results (by tool), Conversation:

![The by-type view with tool results open](walkthrough/img/05-by-type.png)

This is the view for questions like "which tool is filling my context?". Here the
answer is obvious: one **Read** of `logs/server.log`.

### The treemap

Click any rectangle to select it; the tree opens to it and the details follow. The
selected block is outlined in white:

![Clicking the server log's block in the treemap](walkthrough/img/06-treemap-click.png)

Labels sit on the bands of each group (`Setup 81.4k`, `Tool results`) and on blocks big
enough to carry them.

### Types

`t` lists every type with its colour and total. Click a type to highlight it in the
treemap (the rest dims); click it again to clear:

![The types list, with Bash results highlighted](walkthrough/img/07-types.png)

### Keys, filter, sort

`k` shows the keys in the side column (`i` goes back to details):

![The keys](walkthrough/img/08-keys.png)

`f` opens a filter: type part of a name, Enter. The tree keeps only the matches and the
path to them; `f` then an empty Enter clears it.

![Typing a filter](walkthrough/img/09-filter-typing.png)

![The tree filtered to "token"](walkthrough/img/10-filtered.png)

`s` cycles the sort: by **size** (default), by **story order** (the order things
happened), by **name**.

---

## 4. Editing the context

### Mark

Select a row and press **`x`** (or **Space** once you have clicked the tree). Marking a
group marks everything in it. Marked rows get **✕** and strikethrough, partly marked
groups **◐**; the treemap hatches them; the header shows what the context would drop to:

![The test runs and the server log marked](walkthrough/img/11-marked.png)

1. Marked rows.
2. The status line: how many and how much.
3. **The band** appears above the prompt: the plan is waiting for you.

`u` undoes the last mark (repeatedly). A mark on something that can't be removed (Setup,
a tool call with nothing long in it) says so instead.

### The menu: drop, shrink, bridge

**`d`** (or right-click a row) opens the menu for the selection:

![The menu on a large tool call](walkthrough/img/12-menu.png)

- **1 drop**: replace it with a one-line note (or **unmark** if it is marked).
- **2 shrink tool-call inputs** (1): for a call that *sent* something big. Here Claude
  wrote a long `rateLimit.js`: the copy in its input is cut to the first line; the file
  on disk is untouched.
- **3 bridge…** (2): Claude drafts a short summary to stand in for the item.
- **4** closes the menu.

### Bridges

A bridge keeps what later work depends on and drops the bulk. Choose **bridge…** and
Claude drafts it from the session's own context (a side request: it starts no turn and
adds nothing to the conversation):

![A bridge drafted for src/auth/session.js](walkthrough/img/13-bridge-drafted.png)

You can edit the text in the review before applying.

### The band

Back at the prompt (`Esc`), the band shows the plan. From an **empty prompt**, **`1`**
opens the pane and **`2`** opens the review:

![The band above the prompt](walkthrough/img/14-band.png)

The band only offers digits because only a digit reaches it from the prompt, and
neither digit applies anything: a stray `2` at the start of a prompt just opens the
review.

### Review

The review is the plan as it would apply **now**: every entry re-checked against the
conversation, with what it frees and who staged it:

![The review dialog](walkthrough/img/15-review.png)

1. **Images**: this conversation holds one (the screenshot). Apply rebuilds every
   message from its text and tool calls, so images go too, and the review says so.
2. The bridge text, editable: change it and press Enter.
3. **Apply** (`a`). Also: `[ remove ]` takes one item out of the plan; `q` closes.

An entry whose block changed since it was planned shows in red with the reason, and is
skipped.

### Apply

Press **`a`**. A toast says how much was freed; Claude Code shows *Conversation
compacted*. That compaction is ctxtree's own: no summary is written, and every message
is kept except the edits you approved.

![Right after Apply](walkthrough/img/16-applied.png)

1. The toast: tokens freed.
2. Claude Code's notice. On the left you can see the rebuilt conversation, ending with
   ctxtree's note.

Reopen the map and it shows the context Claude has now: the dropped log is a 51-token
tombstone (dimmed, "Already removed in this session"), the bridged file a short
summary, and the header 40k lower.

![The map after Apply](walkthrough/img/17-after.png)

### What Claude is told

One note, as the last message, so Claude knows the context changed and re-reads instead
of guessing:

![The note Claude sees](walkthrough/img/18-note.png)

### Restore

Everything Apply replaced is saved, one small file per block, under
`~/.claude/ctxtree/originals/<session>/` for 30 days. `/ctxtree review` lists it under
**Removed earlier in this session**: restore one item, or press **`e`** for all, then
**`a`** to put it back in place.

![Restoring from the review](walkthrough/img/19-restore.png)

### Wide

**`z`** widens the pane to the whole terminal (and back). If you drag the pane's width
yourself, your width wins.

![The pane at full width](walkthrough/img/20-wide.png)

---

## 5. Asking Claude to clean up

You can skip the pane entirely and just ask:

> Free up some context: drop the old test runs and that big server log, I don't need them anymore.

Claude has five ctxtree tools: **`map`** (the tree as text, with ids and sizes),
**`inspect`** (one item's content), **`stage`** (add drops, shrinks or bridges to the
plan), **`unstage`** and **`restore`**. It has **no apply tool**: it can only stage.

![Claude maps the context and stages two edits](walkthrough/img/21-claude-stages.png)

1. Claude maps the window (by type), then looks inside the Read group.
2. It stages the Bash group (all three test runs) and the server log.
3. The band shows the staged plan; Claude tells you how to review it.

Press **`2`** on the band: the review shows each item and who staged it.

![The review of Claude's plan](walkthrough/img/22-claude-review.png)

Press **`a`**. The edits apply, and so does one more thing: **the cleanup conversation
itself is removed**, your request, Claude's map and stage calls and its reply, leaving
only the note. Work you did after the cleanup is kept.

![After applying Claude's plan](walkthrough/img/23-claude-applied.png)

Good prompts:

- "What's taking the most context? Propose what to drop." (Claude maps and suggests; you
  decide.)
- "Bridge the README read and drop every out-of-date file read."
- "Restore the server log." (Claude stages the restore; you apply it.)

---

## 6. Applying while Claude works

You can mark and review while Claude is busy. If you press Apply mid-turn, ctxtree
**queues** it: rebuilding the conversation under a running turn would cut Claude off.

While Claude works, a typed `/ctxtree review` waits in the prompt queue, but the
band's `2` answers at once: press `2`, then `a`.

![An apply queued during a turn](walkthrough/img/24-queued.png)

1. The review: *Claude is working: the edit applies when the turn ends.*
2. The band: *applying when Claude finishes*, with **cancel**.

When the turn ends, the edit applies.

![The queued apply, applied](walkthrough/img/25-queued-done.png)

---

## 7. Terminals and layouts

### Narrow terminals

Below about 110 columns there is no side column. **`t`**, **`i`** and **`k`** swap the
treemap for types, details or keys; the same key again brings the map back.

![A narrow pane](walkthrough/img/26-narrow.png)

![Details in place of the treemap](walkthrough/img/27-narrow-details.png)

### The classic layout

The pane needs the fullscreen layout. In the classic one, `/ctxtree` prints a summary
and tells you how to switch; Claude's tools and the band still work.

![/ctxtree in the classic layout](walkthrough/img/28-classic.png)

### Colours

The treemap is drawn in 24-bit colour where the terminal says it supports it. A
terminal that doesn't (vTower sets `TERM=xterm-color` and no `COLORTERM`) gets the
256-colour palette: still readable, with coarser shading.

![The treemap in 256 colours](walkthrough/img/29-colors-256.png)

For full colour, add to `~/.zshrc`:

```bash
export COLORTERM=truecolor
```

---

## 8. How it works

![How the ctxtree mod fits into Claude Code](walkthrough/img/diagram-architecture.png)

- **Two plugins.** Claude Code never runs a plugin's own compaction hook when that same
  plugin starts the compaction. So the UI plugin presses Apply and the core plugin's
  hook does the rebuild.
- **The map is what Claude sees.** The core reads `$.session.messages({ as: 'api' })`,
  the exact request the next turn sends, and rebuilds the map after every turn. Token
  sizes are estimated per block and scaled to Claude Code's own count of the messages.
- **One plan.** Your marks and Claude's staged items are the same kind of entry. A tool
  block is addressed by its `tool_use_id`; a prompt or reply by position plus a
  fingerprint of its text. If that no longer holds exactly once, the entry is refused.
- **The shared engine.** `plugins/ctxtree/core/` (map, plan, rebuild, treemap) has no
  Node APIs; the CLI and web UI import the same files.

![What happens when you press Apply](walkthrough/img/diagram-apply.png)

**Why it's efficient**

- Only the rows you can see are drawn; the tree can hold thousands of blocks.
- The map is built once per turn; the treemap layout is cached per size and view.
- Reading the map, the plan and the token counts sends nothing to the API. Only a
  bridge draft makes a request, and it reuses the session's cached prefix.
- An Apply makes **no** API request: it is a local rebuild, not a summarising
  compaction.

**Limits**

- Images, documents and earlier thinking blocks don't survive a rebuild (a rebuilt
  message carries text and tool calls only). The review warns when the conversation has
  any.
- The mod edits the session you are in. Other sessions, boot overhead, compacted
  history and branches go through the web UI (next section).

---

## 9. Outside Claude Code: the web UI and CLI

`npx ctxtree` (or `node bin/ctxtree.js` in the repo) scans every session under
`~/.claude/projects` and opens the web UI. It reaches what the mod can't: other
sessions, **boot overhead**, and **grey content**, the parts of a session file that
resume never loads. Its edits are written as **forks**: new sessions next to the
original, which is never modified. (These screenshots use a second demo session with
two MCP servers, two skills, CLAUDE.md, auto-memory, a rewound branch and a
`/compact`.)

### The map

The same tree, types, details and cushion treemap, for any session:

![The web UI](walkthrough/img/web-01-overview.png)

The session picker (click the title, or ⌘K) searches every session by prompt or project:

![The session picker](walkthrough/img/web-02-sessions.png)

![By type, with the server log selected](walkthrough/img/web-03-by-type.png)

### Boot overhead

**Setup** breaks down what loads before your first message: built-in tools, system
prompt, skills, MCP servers (with their tool count), the agent listing, CLAUDE.md and
memory. Each removable item says how to remove it and how long the removal lasts:

![Setup: skills, MCP servers and CLAUDE.md](walkthrough/img/web-04-setup.png)

Removing boot overhead needs a **launch profile**: a small settings file that the fork's
resume command passes, so Claude Code doesn't load it again.

### Menus

Right-click (or the context-menu key) a row or a type: **delete all**, delete the whole
parent, **≥ size** (only the big ones), **keep last N** (tool output of all but the
latest tasks), **copy name**:

![A right-click menu on a group of results](walkthrough/img/web-05-menu.png)

### Grey content: what resume never loads

**Not in resumed context** holds what the file keeps but `claude --resume` does not send:

- **Before the compaction**: the history a `/compact` summarised away. **Restore into
  context (uncompact)** puts it back in place of the summary; **Remove all of this from
  the fork's file** (slim) drops it from disk.

![Before the compaction: uncompact or slim](walkthrough/img/web-06-grey.png)

- **Rewound** branches: a timeline you rewound away from. **Switch to this branch**
  makes the fork resume it instead.

![A rewound branch](walkthrough/img/web-07-branch.png)

### Mark, review, fork

Mark with Delete/Backspace or the details' Delete button. The meter shows before and
after:

![The log and an MCP server marked](walkthrough/img/web-08-marked.png)

**Review deletion** builds the whole fork in memory and verifies it (every tool call
still pairs with its result, the resumed chain is intact) before anything is written:

![The review drawer, verified](walkthrough/img/web-09-review.png)

**Create fork** writes it and gives you the resume command (with `--settings` when a
launch profile is needed), or opens the fork right there:

![Fork created](walkthrough/img/web-10-forked.png)

**Forks** lists every session ctxtree wrote, with its parent; **Revert** deletes a fork
(the original is never touched):

![Forks and lineage](walkthrough/img/web-11-forks.png)

Resume a fork from its project directory with the command shown, or:

```bash
npx ctxtree resume <fork id or prefix>
```

### The CLI

`--scan-only` prints a report across all sessions: **proven savings** (an MCP server
loaded every turn but never called; byte-identical results loaded twice) and **inferred**
ones (one huge read resident for many turns):

![ctxtree --scan-only](walkthrough/img/cli-01-scan.png)

`--boot <session>` lists the boot overhead a session resumes with:

![ctxtree --boot](walkthrough/img/cli-02-boot.png)

`--context <session>` audits prompt regions and the heaviest blocks, with what later
turns still refer to:

![ctxtree --context](walkthrough/img/cli-03-context.png)

Also: `--bridge <session>` (bridge heavy tool output into a fork; `--threshold`,
`--dry-run`), `--preview <session>`, `--port`, `--no-open`.

---

## 10. Recipes: using it efficiently

**After a long debugging session.** By type → Tool results. The biggest groups are
usually Bash (test runs) and Read. Drop the test runs except the last one (each run
row says its turn), drop every read marked *out of date*. One Apply.

**Before starting something new in the same session.** By task. Bridge each finished
task's big reads ("what we found, which files"), drop its test output. Claude keeps the
decisions and loses the bulk.

**A single huge output** (a log, a `git diff`, a web page). Click the biggest block in the
treemap, `x`, `2`, `a`. Ten seconds.

**Let Claude propose, you decide.** "What's taking the most context? Stage what you
think we can drop and tell me why." Review shows the plan; `[ remove ]` what you want to
keep; `a`.

**Keep an eye on it.** The header's number is what the next request carries. Mark
freely: nothing happens until Apply, `u` undoes marks, and restore undoes an Apply.

**Many sessions, or setup bloat.** `npx ctxtree --scan-only` across everything; for an
MCP server you never call, remove it in the web UI and resume the fork with its
profile.

---

## 11. Reference

### Pane keys

| Key | Action |
|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End`, wheel | move the selection |
| `l` / `h` (`→` / `←` once the tree has focus) | open / close |
| `x` (Space once the tree has focus) | mark / unmark |
| `d`, right-click | menu: `1` drop, `2` shrink, `3` bridge…, `4` close |
| `u` | undo the last mark |
| `r` | review |
| `1` / `2` | by task / by type |
| `s` | sort: size, story order, name |
| `f` | filter (Enter; empty Enter clears) |
| `t` / `i` / `k` | types / details / keys (narrow: in place of the treemap) |
| `z` | wide ⇄ docked |
| `Esc` | back to the prompt (closes the pane; with the menu open, closes the menu) |
| click a row / its ▸ / a treemap block | select / open / select in the map |

The pane takes its letter keys as soon as it opens. Click the tree to give it every key
(Space and arrows included).

### Band and review keys

| Where | Key | Action |
|---|---|---|
| Band (empty prompt) | `1` / `2` | open the pane / the review |
| Review | `a` | apply |
| | `c` | cancel a queued apply |
| | `e` | restore everything removed earlier (then `a`) |
| | `q` | close |

### Commands

| Command | Does |
|---|---|
| `/ctxtree` | open the pane (classic layout: print a summary) |
| `/ctxtree review` | open the review |

### Claude's tools

| Tool | Input | Does |
|---|---|---|
| `mcp__ctxtree__map` | `view` (`task`/`type`), `under` (an id), `limit` | the tree as text, with ids, sizes, *out of date* and *staged* flags |
| `mcp__ctxtree__inspect` | `id` | up to 4,000 characters of one item |
| `mcp__ctxtree__stage` | `items: [{ id, op: drop/shrink/bridge, text? }]` | adds to the plan; never applies |
| `mcp__ctxtree__unstage` | `ids` (none = all) | removes from the plan |
| `mcp__ctxtree__restore` | `keys` (none = list) | stages restoring removed items |

### Files

| Path | What |
|---|---|
| `~/.claude/ctxtree/originals/<session>/` | originals of applied edits (restore), kept 30 days |
| `~/.claude/ctxtree/lineage.jsonl` | forks the web UI wrote |
| `~/.claude/ctxtree/profiles/` | launch profiles for forks that removed boot overhead |

### Troubleshooting

- **`/ctxtree` prints a summary instead of the pane**: switch to the fullscreen layout
  (`/tui fullscreen`).
- **Keys type into the prompt**: the pane doesn't have the keyboard. Click the pane (or
  `ctrl+x tab`), or reopen it with `/ctxtree`.
- **An item in the review is red**: the conversation changed since it was planned (or
  two messages now match). It is skipped; mark it again from the pane.
- **"Not applied: …" toast**: Apply refused rather than risk a broken conversation. The
  reason says what, and nothing changed.
- **The treemap looks banded**: set `COLORTERM=truecolor` (see [Colours](#colours)).

### Regenerating these screenshots

```bash
npm install                              # @xterm/headless, for the terminal rig
node test/tui/shots/shots.mjs            # the mod (scenes A–F), ~10 minutes
node test/tui/shots/web-shots.mjs        # the web UI and CLI
node test/tui/shots/diagrams.mjs         # the two diagrams
```

All three run in a throwaway sandbox (config dir, `HOME`, a stand-in API) and never
touch `~/.claude`. They need Claude Code, Python 3 and Google Chrome.
