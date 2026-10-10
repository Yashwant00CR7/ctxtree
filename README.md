# ctxtree 🌳

> **Context Surgeon & WizTree Visualizer for the LLM Context Window** — Edit paragraph contexts with surgical precision, eliminate continuity jumps, and reclaim wasted tokens across your Claude Code sessions.

---

## The Core Purpose: Jump-Free Context Surgery

Long LLM coding sessions accumulate massive amounts of token bloat: 50k file reads, repetitive command outputs, failed debugging rabbit holes, and redundant dialogue. 

However, **blindly deleting or wiping chunks breaks the narrative flow ("creates jumps")**. In future turns or when resuming, the assistant gets confused, loses critical variable names or file structures, and either re-reads the entire file or asks repetitive questions.

**ctxtree solves this fundamentally**:
- **See the Bloat**: WizTree-style interactive squarified treemap & lever tree showing where tokens are concentrated.
- **Granular Paragraph Editor**: Click any card in the chronological narrative stream to edit user prompts, assistant reasoning, or tool outputs directly.
- **Continuity Bridge Engine**: Automatically detects downstream references (e.g. `server.go` referenced in turn 24) and suggests bridges that keep those terms, so later turns still have what they refer to. (A keyword heuristic: it flags risk, it does not prove continuity.)
- **Region Synthesizer**: Condense a 15-turn debugging detour into a single clean milestone.
- **In-Place Fork & Resume**: Non-destructively forks the session with fast APFS copy-on-write clone (`cp -c -R`), outputting the exact `claude --resume <fork-uuid>` command.
- **Delete anything WizTree-style**: right-click any node in the tree or rectangle in the treemap — tool results, MCP servers, skills, CLAUDE.md files, built-in tool schemas, system-prompt sections — queue it, and delete it all in one verified fork.
- **Act on grey content**: content resume never loads can't be "deleted" for savings, so ctxtree offers what works on it: **uncompact** (bring the real history back in place of the lossy summary), **switch** to a rewind branch you left, or **slim** the fork.

---

## Features

### 📖 1. Context Surgeon & Narrative Stream
- **Paragraph-by-Paragraph Timeline**: Chronological narrative organized by genuine prompt regions.
- **Inline Rich Editor**: Edit, rewrite, or trim any paragraph with a live token counter.
- **🛡️ Continuity Guard**: Analyzes future turns to detect downstream references (symbols, file paths, variables). Flags anchors as `🟢 Safe`, `🟡 Anchor`, or `🔴 Critical Anchor` so you never accidentally break dialogue flow.
- **🌉 Smart Continuity Bridges**:
  - *File Reads*: Preserves imports, exports, and structure (`[Context Bridge: Inspected server.go (defines TripHandler, StartServer)...]`).
  - *Bash Outputs*: Preserves command intent and clean result summary.
  - *Code Condenser*: Keeps head and tail (15 lines each) while cleanly omitting the middle.
- **✨ Milestone Synthesizer**: Collapse multi-step trial-and-error detours into a cohesive milestone turn.

### 🌳 2. WizTree Visualizer & Treemap
- **⚡ 1-Second Scanner**: Scans your entire Claude Code history (`~/.claude/projects/`, 150MB+ across 60+ sessions) in **under 1.0 second**.
- **Dual Accounting**:
  - **Distinct Size**: Raw tokens of a paragraph.
  - **Allocated**: `Size × turns resident` — reveals how an early command multiplies its token cost across every subsequent turn.
- **Interactive Treemap**: Squarified treemap with authentic WizTree 3D bevels, instant hover tooltips, and click-to-jump into the paragraph editor.
- **Actionable Lever Tree**: Breaks context down by `boot overhead`, `tool results`, `conversation`, and `subagent contexts`.

### ✂️ 3. Safe Forking & Lineage
- **Verified before it exists**: every fork is checked against the invariants below in memory, written to a hidden temp file, read back, checked again, and only then renamed into place.
- **APFS Clone**: Clones `~/.claude/file-history` copy-on-write (~100ms, near-zero extra disk) so undo still works inside the fork.
- **Lineage Manifest**: Tracks all parent-child forks in `~/.claude/ctxtree/lineage.jsonl` with revert capability.

---

## Deleting boot overhead

MCP tool schemas, MCP server instructions, the skill and agent listings, CLAUDE.md
files and the system prompt look like config that Claude Code re-injects on every
launch. On current Claude Code (verified on 2.1.283) they are not: they are written
into the transcript, and a resume replays them.

- Each is an `attachment` record on the conversation chain. Its `rendered` field is
  the exact text sent; resume sends it verbatim (without it, the text is rebuilt from
  `attachment`). The system prompt is the latest `prompt_snapshot`, sent as-is until
  the session compacts again.
- On resume Claude Code diffs what the transcript says was announced against what is
  configured, and appends the difference. Deleting an announcement alone therefore
  just gets it re-announced at the end.
- That diff is **by name** for MCP instructions, skills and agents: ctxtree keeps the
  name, drops the text, and nothing is re-announced — no config change at all.
- It is **by content** for CLAUDE.md, and tools come from the live tool pool. For
  those, the fork gets a **launch profile**: a `--settings` overlay with
  `claudeMdExcludes`, `autoMemoryEnabled: false`, `skillOverrides` and
  `permissions.deny` (a bare-name deny removes a tool — inline schema or deferred
  name — from the request). Your settings files are never edited.

So a fork that removed boot overhead must be resumed with its profile:

```bash
npx ctxtree resume <fork-id-prefix>
# = cd <project> && claude --resume <fork> --settings ~/.claude/ctxtree/profiles/<fork>.json
```

Without the profile nothing breaks, but Claude Code re-announces what was removed.

| Removed item | In the fork's transcript | Launch profile | Lasts |
|---|---|---|---|
| MCP server | instructions text dropped (name kept); tool names/schemas dropped | `permissions.deny: ["mcp__<server>"]` | tools: every launch via the profile; instructions: until the fork compacts |
| Built-in tool | dropped from the recorded tool list | `permissions.deny: ["<Tool>"]` | every launch via the profile |
| Skill | listing line dropped (name kept) | `skillOverrides: {name: "user-invocable-only"}` (you can still run `/name`) | every launch; plugin skills until the fork compacts |
| CLAUDE.md | file dropped from the instructions record | `claudeMdExcludes: [path]` | every launch via the profile |
| Auto memory (MEMORY.md) | dropped | `autoMemoryEnabled: false` | every launch via the profile |
| Agent listing entry | line dropped (type kept) | — | until the fork compacts |
| System prompt section | dropped from the latest `prompt_snapshot` | — | until the fork compacts |

claude.ai connectors and plugin MCP servers are removed the same way (deny rules work
for any server). Managed (policy) instructions cannot be excluded and are shown as such.

## Grey content: what resume never loads

Content before the last compaction, on a rewind branch you left, or a stray result of
an interrupted call costs **0 tokens** on resume, so deleting it saves nothing. What
you can do with it:

- **Uncompact** — drop the compaction boundary and its lossy summary, continue the
  conversation from the last pre-compaction message, and drop the boot overhead
  Claude Code re-announced after compacting (it is already announced in the restored
  history). The context grows, so queue tombstones for the restored history's heavy
  results in the same fork: a surgical compaction instead of a lossy one.
- **Switch branch** — make a rewind branch you left the resumed one; the branch you
  were on stays in the parent session.
- **Slim** — drop every record resume never loads. The resumed request is
  byte-identical; the file is smaller and parses faster.

## The interface

`ctxtree` opens one session at a time, laid out like WizTree, organised two ways:

- **By task** (the default): one folder per thing you asked for, oldest first, named
  with your own words and holding everything Claude did for it. A tool call and its
  result are one item in plain words ("Read src/app.js", "Ran npm test", "Wrote
  ui/style.css"). Each task shows when it was, the files it touched, how it ended
  (Claude's last reply), and two signals for "do I still need this?":
  - **out of date**: an item a later turn replaced (the file was read again or
    changed, or the same command ran again). Deleting these costs nothing.
  - **not mentioned since**: nothing after the task names the files it worked on.

  Right-click a task: *Clear its tool output* (keeps what you asked and what Claude
  answered, so Claude still knows it happened) or *Delete the whole task*.
  Right-click the root: *Clear tool output of older tasks — keep last 1 / 2 / 3 / 5 / 10*,
  or *Delete every out-of-date copy*.
- **By type**: the same context by kind.

Both views share the same marks.

- **Tree** (top left): in the type view, the resumed context as folders — *Setup* (system prompt,
  built-in tools, MCP servers, skills, agents, CLAUDE.md), *Tool results* (by tool,
  then by file or command, then each run), *Conversation* (your messages, Claude's
  replies, tool calls) and *Other attachments*. Columns: % of parent, tokens,
  items, last turn. Sort by any column. A second, grey tree holds what resume
  never loads (before a compaction, rewound branches, interrupted calls).
- **Types** (top right): the same context by kind, like WizTree's extension list.
  Click one to light up its rectangles in the map.
- **Details** (right): what the selection is, what deleting it does, how long the
  removal lasts, and the first 6,000 characters of the content.
- **Treemap** (bottom): squarified, cushion-shaded, one rectangle per item, with
  a labelled band for every group that fits one.

**Deleting.** Right-click anything in the tree, the type list or the map, or select
it and press <kbd>⌫</kbd>. A group offers *Delete all*, *Delete only the larger
ones* (≥ 1k / 2.5k / 5k / 10k …) and *Delete older copies, keep the latest* (files
that were read again, commands that ran again). Marked items are struck through
and hatched; the meter shows before → after. <kbd>⌘Z</kbd> undoes.
**Review deletion** builds the whole fork in memory and verifies it before you
commit; **Create fork** writes it and gives you the resume command.
Grey groups offer *Restore into context (uncompact)*, *Switch to this branch* and
*Remove from the fork's file* instead of a delete that would save nothing.

What each leaf deletes:

| Item | What happens in the fork |
|---|---|
| Tool result | Replaced by a one-line note; the call stays, so Claude knows it ran |
| Tool call | Long strings in its input (file contents written, edit text) cut to their first line and a note; the call and its pairing stay |
| Your message / Claude's reply / image | Replaced by a one-line note |
| Setup item | Removed from the transcript, plus a launch profile where Claude Code would load it again |

Token counts are anchored to Claude Code's own measurement: the last reply on the
resumed chain records the exact size of the request (input + cache read + cache
write), and the per-item estimates are scaled to it. Only the split is estimated.

The previous interface (paragraph editor, bridges, continuity checks) is still at
`/classic/`.

---

## Quick Start

Run directly via `npx` or Node.js (requires Node 18+ with zero external dependencies):

```bash
# Start local server and launch Context Surgeon & WizTree UI
npx ctxtree

# Audit paragraphs, prompt regions, and continuity anchors for a session in terminal
npx ctxtree --context [session-id]

# Bridge heavy tool output into a fork (session id or unique prefix required)
npx ctxtree --bridge <sid-prefix> [--threshold 2500] [--dry-run]

# Terminal overview of all sessions
npx ctxtree --cli

# What boot overhead a session resumes with, and what is outside its context
npx ctxtree --boot <sid-prefix>

# Resume a fork with its launch profile
npx ctxtree resume <fork-id-prefix>

# Custom port
npx ctxtree --port 4000 --no-open
```

Then open `http://localhost:3888` in your browser.

---

## Resuming a Cleaned Session

Once you edit or bridge paragraphs in the UI, click **"🚀 Fork Session Without Jumps"**. `ctxtree` forks the session and provides the exact resume command:

```bash
claude --resume <fork-session-uuid>
```

The fork continues from the same point with your edits in place. The parent session is never modified. Run the command from the project directory: a resumed conversation runs its tools wherever you launch it. If the fork removed boot overhead, the command includes `--settings <profile>` — use it (or `npx ctxtree resume <fork>`) every time you resume that fork.

---

## How forks stay safe

ctxtree only ever writes **new** files. A fork is a copy of the parent transcript under a new session id, built in two layers that are each verified before anything is written.

**Structure** (uncompact, switch, slim) may drop records and re-chain what follows them. It must leave every kept record identical except a planned `parentUuid`, in original order, with no parent pointing at a dropped record, tool calls still paired on the resumed chain, and the expected leaf and resumed chain (slim: the resumed chain and its content exactly unchanged).

**Content** (edits, tombstones, boot removals) then rewrites blocks and attachment records. Before the fork is renamed into place it must pass:

- same number of records, in the same order; `uuid` / `parentUuid` chain untouched; every record not edited reproduced exactly
- a boot removal touches only a record's `attachment` / `rendered`, the removed text is gone from what is sent, and the item no longer appears in the fork's boot inventory
- same resume leaf and same resumed chain
- identical `tool_use` ids and `tool_result` pairing
- every record that carried the parent's session id re-stamped (ids inherited from earlier resumes are kept, as Claude Code does)
- every edit landed exactly where it was addressed; every **unedited** block byte-identical
- no empty text blocks, and every `tool_use` input still a JSON object

Edits are addressed by record `uuid` and carry a fingerprint of the text you saw, so an edit can never land on a different message, and a block that changed after you loaded it is refused rather than overwritten.

**What "in context" means.** `claude --resume` loads the chain from the newest message back to the last compaction. Content before a compaction, or on a branch you rewound away from, is not loaded — across a typical history that is more than half of all transcript content. ctxtree hides it by default ("Outside resumed context" filter) and reports savings only for what resume actually loads. Three details, each checked by resuming a real session against a recording API stand-in: a compaction's *preserved segment* (its last turn kept verbatim) is spliced in after the summary; results of *parallel tool calls*, which hang off the chain beside their call, are merged back into the turn; and the records written after the last message (the latest `prompt_snapshot`) are loaded too.

**Locked blocks.** Signed thinking blocks are never rewritten: finished-turn thinking is dropped from what the API sees (so editing it saves nothing), and a session that stopped mid tool-call needs its latest thinking block unchanged.

**Revert** deletes only files ctxtree created, and refuses to delete a fork you have resumed and kept working in unless you force it.

**The local server** listens on `127.0.0.1` only, answers only to `localhost` Host headers, sends no CORS headers, requires a per-process token that is embedded in the page it serves, and locks scripts to its own origin with a Content-Security-Policy.

```bash
npm test               # engine + server security tests (sandboxed; never touches ~/.claude)
npm run verify:real    # build & verify edits, boot removals, uncompact, switch and slim on every real session; dry run, writes nothing
npm run verify:cc      # end-to-end against the real `claude` CLI: builds forks, resumes them with `claude -p`,
                       # and checks the exact request Claude Code sends (local API stand-in, throwaway config dir, no API credit)
npx ctxtree --bridge <sid-prefix> --dry-run   # see what a bridge would do, write nothing
```

`verify:cc` is the one to re-run after a Claude Code update: every boot-removal and
structural rule above has a check there, so a change in how Claude Code records or
replays context shows up as a failing line rather than a silent regression.

## Architecture

```text
ctxtree/
├── bin/
│   └── ctxtree.js        # CLI launcher, terminal reports, and context auditor
├── src/
│   ├── session.js        # One transcript parser: addresses, resumed chain, locks, grey-content kinds
│   ├── fork.js           # The only writer: structure + content layers, verify, atomic write, revert
│   ├── boot.js           # Boot inventory, attachment surgery, launch profiles
│   ├── restructure.js    # Uncompact, branch switch, slim
│   ├── map.js            # The session as one deletable tree; token anchoring; block preview
│   ├── surgery.js        # Tree node -> deletions; the one fork call the UI uses
│   ├── sessionEditor.js  # Editor view, continuity heuristics & bridge generator
│   ├── paths.js          # Claude directory paths & slug resolvers
│   ├── attach.js         # Attachment parser (MCP schemas, system prompt, skills)
│   ├── tokens.js         # Multivariate calibration engine
│   ├── scan.js           # Fast streaming JSONL parser
│   ├── model.js          # Ground-truth anchored session model
│   ├── tree.js           # Lever tree & project breakdown builder
│   ├── regions.js        # Verbatim prompt region boundary detector
│   ├── findings.js       # Two-tier reclaim rule engine
│   ├── prune.js          # Tombstone by tool_use_id (via fork.js)
│   └── server.js         # Zero-dependency HTTP server & REST API
└── ui/
    ├── index.html        # Tree, types, details and treemap
    ├── style.css         # Light and dark themes
    ├── app.js            # Virtualised tree, cushion treemap, delete marks, review drawer
    └── classic/          # The previous interface (paragraph editor and bridges)
```

---

## License

MIT © Yashwant00CR7
