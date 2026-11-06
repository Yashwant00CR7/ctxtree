# ctxtree 🌳

<p align="center">
  <strong>WizTree for Claude's Context Window</strong><br>
  Scan, visualize, and surgically delete token bloat across your Claude Code sessions with zero narrative jumps.
</p>

<p align="center">
  <a href="https://github.com/Yashwant00CR7/ctxtree/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat-square" alt="Node >= 18"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success.svg?style=flat-square" alt="Zero External Dependencies">
  <img src="https://img.shields.io/badge/Claude%20Code-Mod%20%7C%20Plugin-7C3AED.svg?style=flat-square" alt="Claude Code Mod">
  <img src="https://img.shields.io/badge/tests-78%2F78%20passed-22C55E.svg?style=flat-square" alt="78/78 Tests Passed">
  <img src="https://img.shields.io/badge/Continuity-Zero--Jump-0284C7.svg?style=flat-square" alt="Continuity Zero-Jump">
</p>

---

<p align="center">
  <img src="docs/walkthrough/img/web-01-overview.png" alt="ctxtree Web UI Overview - WizTree for Claude's Context Window" width="100%">
</p>

> [!TIP]
> **Also available directly inside your terminal session!** Run `/ctxtree` within Claude Code to dock an interactive terminal map right beside your live chat transcript without leaving your workflow.

---

## Table of Contents

- [The Core Purpose: Jump-Free Context Surgery](#the-core-purpose-jump-free-context-surgery)
- [Two Ways to Use ctxtree](#two-ways-to-use-ctxtree)
- [Interactive WizTree Treemap](#-interactive-wiztree-treemap)
- [Task-Oriented Narrative](#-task-oriented-narrative)
- [Surgical Deletion & Tombstones](#-surgical-deletion--tombstones)
- [Live Inside Claude Code (The TUI Mod)](#-live-inside-claude-code-the-tui-mod)
- [Architecture & Continuity Guard](#-architecture--continuity-guard)
- [Deleting Boot Overhead](#-deleting-boot-overhead)
- [Grey Content: What Resume Never Loads](#-grey-content-what-resume-never-loads)
- [Instant Terminal CLI](#-instant-terminal-cli)
- [Quick Start](#-quick-start)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [Safety Invariants & Verification](#-safety-invariants--verification)
- [Architecture & Repo Map](#-architecture--repo-map)
- [License](#-license)

---

## The Core Purpose: Jump-Free Context Surgery

Long LLM coding sessions accumulate immense token bloat: 50k-token file reads, repetitive command logs, failed test suites, and obsolete debugging rabbit holes. 

Standard compaction (`/compact`) is a blunt instrument: **it wipes out the fine-grained code structure, imports, and error stack traces**, leaving Claude disoriented and forced to re-read files or ask repetitive questions. Conversely, blindly deleting chunks breaks conversation continuity ("creates jumps"), triggering hallucinations and broken downstream references.

**`ctxtree` solves this fundamentally:**
1. **Find the Culprits Instantly**: Interactive cushion-shaded squarified treemaps and lever trees expose exactly which file read or bash log is monopolizing your tokens.
2. **Surgical Precision**: Drop stale tool results, shrink bloated inputs, or bridge prompt regions while leaving the rest of the conversation byte-for-byte identical.
3. **Continuity Bridge Engine**: Automatically analyzes downstream turns for symbols, file paths, and identifiers, inserting safe narrative bridges so Claude never loses continuity.
4. **Zero Risk**: Edits land in verified, non-destructive forks with instant copy-on-write transcript cloning (APFS `cp -c -R`). The parent session is never touched.

---

## Two Ways to Use ctxtree

| Feature | ⚡ Live Inside Claude Code (TUI Mod) | 🌐 Outside (Web UI & CLI) |
|---|---|---|
| **Target** | Active running session in real-time | Any past or present session on disk |
| **How Edits Land** | Conversation rebuilt in place or forked; keep working | Verified, non-destructive session fork |
| **Interface** | Fullscreen terminal split-pane docked beside chat | Browser-based WizTree dashboard + terminal reports |
| **Claude Collaboration** | Ask Claude to plan cleanups with you (`AskUserQuestion`) | Manual point-and-click or automated CLI flags |
| **Special Powers** | Non-blocking background browsing while Claude generates | Boot overhead removal, uncompact, branch switcher, slim |
| **Command** | `/ctxtree` | `npx ctxtree` |

---

## 🌳 Interactive WizTree Treemap

`ctxtree` delivers the iconic **WizTree** experience for your LLM context window:

<p align="center">
  <img src="docs/walkthrough/img/web-03-by-type.png" alt="WizTree By-Type View showing 34k log file" width="49%">
  <img src="docs/walkthrough/img/06-treemap-click.png" alt="Selecting Treemap Block in TUI" width="49%">
</p>

- **Squarified Cushion Treemap**: Blocks are proportional to token consumption. Category color-coding immediately separates Setup (blue), Tool Results (red/orange), Conversation (green), and Attachments.
- **Dual Accounting**:
  - **Distinct Size**: Raw token footprint of an individual paragraph or output.
  - **Allocated Tokens**: `Distinct Tokens × Turns Resident`. Reveals how an early 10k-token read quietly multiplied into 300k+ billed tokens over 30 conversation turns.
- **Instant Hit Testing**: Click any rectangle in either the Web UI or the terminal TUI to instantly highlight its corresponding row in the tree, view full block metadata, and inspect the raw text preview.

---

## 📖 Task-Oriented Narrative

Rather than scrolling through raw message arrays, `ctxtree` groups your context into high-level user tasks—the actual requests you typed:

<p align="center">
  <img src="docs/walkthrough/img/03-by-task.png" alt="Task-Oriented Narrative View" width="80%">
</p>

### Intelligent Stale Detection
- **`[out of date]` Flags**: When a file read in Turn 3 is edited in Turn 14, `ctxtree` flags the Turn 3 read as stale. Dropping it is 100% safe because Claude already has the newer state.
- **`[not mentioned since]` Signals**: Detects files or tools that were touched during an early investigation and never referenced again.
- **Failed Steps Highlighted in Red**: Readily spot failed test runs and error traces that have already been resolved.

---

## ✂️ Surgical Deletion & Tombstones

When cleaning a session, `ctxtree` offers three distinct, non-destructive editing operations:

<p align="center">
  <img src="docs/walkthrough/img/web-08-marked.png" alt="Items Marked for Deletion with Hatching" width="49%">
  <img src="docs/walkthrough/img/16-applied.png" alt="Surgical Deletion Applied" width="49%">
</p>

### 1. Drop (Smart Tombstone)
Replaces voluminous tool outputs with an informative tombstone. Claude knows the command was run, but doesn't waste 30k tokens carrying the raw text:
```text
[ctxtree: removed Read result for /acme-api/logs/server.log (~34,529 tokens) to reclaim context. Re-run it if you need it again.]
```

### 2. Shrink
Condenses massive tool inputs (e.g. huge file write payloads) down to the first line and a concise byte/line count note. The `tool_use` and `tool_result` pair remains completely intact.

### 3. Continuity Bridge
Drafts a concise contextual bridge preserving key symbols, variable names, and architectural decisions identified by the Continuity Guard:

<p align="center">
  <img src="docs/walkthrough/img/13-bridge-drafted.png" alt="Drafted Continuity Bridge" width="70%">
</p>

---

## ⚡ Live Inside Claude Code (The TUI Mod)

Use `ctxtree` without ever leaving your terminal! The native Claude Code mod docks an interactive split-pane directly inside Claude Code:

<p align="center">
  <img src="docs/walkthrough/img/02-overview.png" alt="Live ctxtree TUI Mod Docked in Claude Code" width="49%">
  <img src="docs/walkthrough/img/21-claude-stages.png" alt="Claude Collaboratively Staging a Cleanup" width="49%">
</p>

### Features of the TUI Mod
- **Fullscreen Docked Layout**: Opens alongside your chat via `/ctxtree` (works with `/tui fullscreen`).
- **Non-Blocking Operation**: Browse, mark, and inspect context while Claude is actively thinking or writing code.
- **Claude Stages, You Apply**: Ask Claude naturally: *"Free up some context by dropping stale test runs."* Claude uses the internal `mcp__ctxtree__map` and `mcp__ctxtree__stage` tools to formulate a plan. **Only you can press `a` (Apply)**—the model cannot execute deletions autonomously.
- **Proactive Context Gauge**: A live status-line meter informs you when context utilization crosses critical thresholds.

---

## 🛡️ Architecture & Continuity Guard

`ctxtree` is engineered with extreme paranoia around transcript integrity:

<p align="center">
  <img src="docs/walkthrough/img/diagram-architecture.png" alt="ctxtree System Architecture" width="85%">
</p>

### How Forks Stay Safe
1. **Verification Before Disk**: Every fork is verified in-memory across 8 strict invariants before any bytes touch disk.
2. **Atomic Write**: The new transcript is written to a hidden temporary file, re-read and validated, and then atomically renamed into place.
3. **APFS Copy-on-Write**: File history (`~/.claude/file-history`) is cloned copy-on-write in ~100ms with near-zero disk usage. Undo (`/undo`) continues to work flawlessly in the forked session.
4. **Lineage Tracking**: Parent-child lineage is logged in `~/.claude/ctxtree/lineage.jsonl`. You can safely revert or backtrack at any time.

<p align="center">
  <img src="docs/walkthrough/img/diagram-apply.png" alt="Transcript Apply Diagram" width="70%">
</p>

---

## 📦 Deleting Boot Overhead

MCP schemas, MCP instructions, skill listings, CLAUDE.md files, and system prompts are recorded into transcripts and replayed on resume. `ctxtree` can surgically eliminate them:

| Overhead Item | In the Fork's Transcript | Launch Profile Overlay | Persistence |
|---|---|---|---|
| **MCP Server** | Instructions dropped; names kept | `permissions.deny: ["mcp__<server>"]` | Until fork compacts |
| **Built-in Tool** | Dropped from recorded tool list | `permissions.deny: ["<Tool>"]` | Permanent via profile |
| **Skill Listing** | Line dropped; name retained | `skillOverrides: {name: "user-invocable-only"}` | Permanent via profile |
| **CLAUDE.md** | Dropped from instructions record | `claudeMdExcludes: [path]` | Permanent via profile |
| **Auto-Memory** | `MEMORY.md` dropped | `autoMemoryEnabled: false` | Permanent via profile |
| **System Prompt** | Section trimmed from `prompt_snapshot` | — | Until fork compacts |

Resume the fork using its generated profile:
```bash
npx ctxtree resume <fork-prefix>
```

---

## 🌫️ Grey Content: What Resume Never Loads

Content before the last compaction or on an abandoned rewind branch costs **0 tokens** on resume. Deleting it saves nothing, but `ctxtree` lets you operate on it:

- **Uncompact**: Strip away the lossy compaction summary, restore genuine message history, and apply surgical tombstones in the same fork.
- **Switch Branch**: Seamlessly jump to an abandoned rewind branch while preserving the current branch in the parent session.
- **Slim**: Remove unreferenced orphan records to speed up transcript parsing while preserving identical resume semantics.

---

## 💻 Instant Terminal CLI

Auditing your context window requires zero setup:

<p align="center">
  <img src="docs/walkthrough/img/cli-01-scan.png" alt="Fast CLI Scan" width="49%">
  <img src="docs/walkthrough/img/cli-02-boot.png" alt="CLI Boot Overhead Inspection" width="49%">
</p>

- **Sub-Second Global Scan**: Scans 60+ projects and 150MB+ of transcript data in **under 1.0 second**.
- **CLI Commands**:
  ```bash
  # Launch the interactive Web UI
  npx ctxtree

  # Fast summary of all sessions across projects
  npx ctxtree --cli

  # Audit boot overhead for a session
  npx ctxtree --boot <session-id-prefix>

  # Inspect paragraphs, prompt regions, and continuity anchors
  npx ctxtree --context <session-id-prefix>

  # Automatically bridge heavy tool outputs (dry run)
  npx ctxtree --bridge <session-id-prefix> --threshold 2500 --dry-run
  ```

---

## 🚀 Quick Start

### Option A: Use the Web UI & CLI (Zero Dependencies)
Requires **Node.js >= 18**:
```bash
# Run immediately via npx
npx ctxtree

# Or clone and start locally
git clone git@github-personal:Yashwant00CR7/ctxtree.git
cd ctxtree
npm start
```
Then open `http://localhost:3888` in your browser.

### Option B: Install the Claude Code Mod
```bash
# Method 1: Load directly from local directory
claude --plugin-dir plugins/ctxtree --plugin-dir plugins/ctxtree-ui

# Method 2: Install via plugin marketplace
claude plugin marketplace add /path/to/ctxtree
claude plugin install ctxtree@ctxtree
claude plugin install ctxtree-ui@ctxtree
```
Inside Claude Code:
1. Ensure fullscreen layout: `/tui fullscreen`
2. Open the ctxtree pane: `/ctxtree`

---

## ⌨️ Keyboard Shortcuts

### TUI Mod (Inside Claude Code)
| Key | Action |
|---|---|
| `/ctxtree` | Open or close the docked ctxtree pane |
| `↑` `↓` `PgUp` `PgDn` | Navigate through tasks and blocks |
| `l` / `h` | Expand / collapse tree folders |
| `x` or `Space` | Mark / unmark selected block for deletion |
| `d` / Right-Click | Context menu: drop, shrink, or keep |
| `1` / `2` | Switch view: **By Task** / **By Type** |
| `t` · `i` · `k` | Switch side-panel: **Types** · **Details** · **Keys** |
| `f` / `s` / `u` | Filter text / Cycle sort / Undo |
| `r` | Open deletion review dialog |
| `a` | **Apply**: Write verified fork & resume |
| `Esc` | Return focus to Claude Code prompt |

### Web UI
| Key | Action |
|---|---|
| `Click` | Select node in tree or rectangle in treemap |
| `Right-Click` | Open surgery menu (Drop, Shrink, Keep latest, etc.) |
| `⌫` or `Delete` | Mark / unmark selected item |
| `⌘Z` / `Ctrl+Z` | Undo last marking |
| `⌘F` / `Ctrl+F` | Focus filter input |

---

## 🔒 Safety Invariants & Verification

Before any fork is written, `ctxtree` validates all of the following invariants:
- **Chain Consistency**: Turn alternation (`user` ⇄ `assistant`) is strictly preserved; no orphan parent references.
- **Tool Pairing**: Every `tool_use` is guaranteed to pair with its exact `tool_result` by ID.
- **Locked Thinking**: Claude's signed reasoning/thinking blocks are never tampered with or modified.
- **Input Validity**: All `tool_use` payloads remain strictly valid JSON objects.
- **Local Sandbox Security**: The web server binds strictly to `127.0.0.1`, validates `Host: localhost`, enforces script-locking Content Security Policy (CSP), and requires a per-process authentication token.

### Running the Test Suite
```bash
# Run unit & security test suite (78 tests, ~1s)
npm test

# Verify dry runs on real local sessions without writing to disk
npm run verify:real

# End-to-end integration test against real Claude Code CLI (sandboxed API)
npm run verify:cc

# End-to-end headless TUI tests
npm run verify:tui
```

---

## 🏗️ Architecture & Repo Map

```text
ctxtree/
├── bin/
│   └── ctxtree.js          # CLI launcher, terminal reports, and scanner
├── src/
│   ├── session.js          # Shared transcript parser: chains, grey-content, addresses
│   ├── fork.js             # Atomic fork writer, invariant verification, rollback
│   ├── boot.js             # Boot overhead analysis, attachment surgery, profiles
│   ├── restructure.js      # Structural operations: uncompact, branch switch, slim
│   ├── map.js              # Deletable context tree model & token anchoring
│   ├── surgery.js          # Node-to-deletion translation layer
│   ├── sessionEditor.js    # Continuity heuristics & bridge synthesis
│   ├── server.js           # Zero-dependency loopback HTTP server & REST API
│   ├── scan.js             # Sub-second streaming JSONL parser
│   ├── model.js            # Ground-truth anchored session model
│   └── tokens.js           # Multi-tier token estimation & calibration
├── ui/
│   ├── index.html          # WizTree interface (Tree, Types, Details, Treemap)
│   ├── style.css           # High-contrast light & dark themes
│   └── app.js              # Virtualized tree, cushion treemap renderer, delete review
├── plugins/
│   ├── ctxtree/            # Claude Code Mod Core: live map, planning tools, fork engine
│   │   └── core/           # Runtime-agnostic shared core (runs in Node & Claude Mod)
│   └── ctxtree-ui/         # Claude Code Mod UI: docked pane, treemap overlay, review
├── docs/
│   ├── walkthrough.md      # Comprehensive illustrated walkthrough
│   ├── mod-spec.md         # Architecture specification for Claude Code Mod
│   ├── tui-design.md       # Terminal UI design decisions
│   └── walkthrough/img/    # Complete high-resolution visual assets
└── test/                   # Comprehensive 78-test suite with zero regressions
```

---

## 📜 License

MIT © [Yashwant00CR7](https://github.com/Yashwant00CR7)
