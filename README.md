# ctxtree

<p align="center">
  <strong>Visualizer and surgical context editor for Claude Code sessions.</strong><br>
  Scan, inspect, and prune token bloat across your coding sessions without losing conversational continuity.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat-square" alt="Node >= 18"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success.svg?style=flat-square" alt="Dependencies: 0">
  <img src="https://img.shields.io/badge/Claude%20Code-Mod%20%7C%20Plugin-7C3AED.svg?style=flat-square" alt="Claude Code Mod">
  <img src="https://img.shields.io/badge/tests-78%2F78%20passing-brightgreen.svg?style=flat-square" alt="78/78 Passing">
</p>

---

<p align="center">
  <img src="docs/walkthrough/img/web-01-overview.png" alt="ctxtree Web UI Overview" width="100%">
</p>

---

## Quickstart

Run directly with Node.js (requires Node 18+, zero external npm dependencies):

```bash
# Launch the interactive web dashboard on http://localhost:3888
npx ctxtree

# Or run a terminal context audit across all sessions
npx ctxtree --cli
```

### Using Inside Claude Code

To dock an interactive context pane directly beside your Claude Code chat:

```bash
claude plugin marketplace add /path/to/ctxtree
claude plugin install ctxtree@ctxtree ctxtree-ui@ctxtree
```

Then run `/ctxtree` in any Claude Code session (requires `/tui fullscreen` layout).

---

## Background

Long coding agent sessions accumulate substantial context overhead: verbose test logs, superseded file reads, and inactive tool schemas. Because LLM context windows bill tokens on every turn (`input tokens × turns resident`), an early 20,000-token file inspection continues burning latency and token budget on every subsequent interaction.

Claude Code provides `/compact` to manage context size, but compaction is global and lossy: exact line references, compiler stack traces, and import signatures are summarized away, often causing the model to lose continuity or repeat work.

`ctxtree` provides targeted context surgery:

- **WizTree-style treemap**: Visualizes token consumption by category (setup, tool results, conversation) and identifies which outputs are consuming memory.
- **Surgical deletion**: Drops stale tool results into lightweight tombstones while preserving caller/callee alternation, so Claude remembers the action succeeded without carrying the raw tokens.
- **Continuity guard**: Checks downstream turns for variable and file path references before allowing deletions.
- **Non-destructive forks**: Writes verified session forks in ~35ms using APFS copy-on-write cloning (`cp -c -R`). The parent session is never modified.

---

## Comparison: `/compact` vs `ctxtree`

| Dimension | Standard `/compact` | `ctxtree` |
|---|---|---|
| **Mechanism** | Lossy global text summary | Targeted pruning of individual tool outputs and messages |
| **Transcripts** | In-place history replacement | Non-destructive APFS forks with full rollback |
| **Continuity** | Risk of losing variable names and imports | Continuity guard flags downstream references |
| **Stale tracking** | None | Flags files re-read or superseded in later turns |
| **Boot overhead** | Re-announces MCP schemas on resume | Generates launch profiles to exclude unneeded tools |
| **Collaboration** | Fully autonomous | Claude stages candidates; human applies |
| **Interface** | Command trigger | Interactive web treemap, terminal CLI, and docked TUI mod |

---

## Features

### 1. Interactive Treemap & Dual Token Accounting

`ctxtree` renders a cushion-shaded squarified treemap where block areas are proportional to token consumption:

<p align="center">
  <img src="docs/walkthrough/img/web-03-by-type.png" alt="WizTree By-Type View" width="49%">
  <img src="docs/walkthrough/img/06-treemap-click.png" alt="Selecting Treemap Block in TUI" width="49%">
</p>

- **Category Separation**: Visualizes Setup (blue), Tool Results (red/orange), Conversation (green), and Attachments.
- **Dual Accounting**:
  - **Distinct Size**: Raw token footprint of an individual output.
  - **Allocated Tokens (`Distinct × Turns Resident`)**: Measures actual cumulative impact across turns.
- **Hit Testing**: Clicking any rectangle in the Web UI or terminal TUI highlights its row in the tree and displays metadata and text previews.

---

### 2. Task-Oriented Narrative

Sessions are grouped by user requests rather than raw API message arrays:

<p align="center">
  <img src="docs/walkthrough/img/03-by-task.png" alt="Task-Oriented Narrative View" width="85%">
</p>

- **Automatic Stale Detection (`[out of date]`)**: When a file read in Turn 3 is edited in Turn 14, the Turn 3 read is flagged as stale and safe to drop.
- **Abandonment Tracking (`[not mentioned since]`)**: Highlights investigation artifacts that were touched once and never referenced again.
- **Failed Steps**: Isolates resolved test runs and compiler errors.

---

### 3. Surgical Deletions & Tombstones

`ctxtree` provides three non-destructive editing operations:

<p align="center">
  <img src="docs/walkthrough/img/web-08-marked.png" alt="Items Marked for Deletion" width="49%">
  <img src="docs/walkthrough/img/16-applied.png" alt="Deletion Applied Confirmation" width="49%">
</p>

1. **Drop (Tombstone)**:
   Replaces voluminous tool outputs with a one-line tombstone. The `tool_use` record remains intact to preserve alternation:
   ```text
   [ctxtree: removed Read result for /acme-api/logs/server.log (~34,529 tokens) to reclaim context. Re-run it if you need it again.]
   ```
2. **Shrink**:
   Truncates oversized tool inputs (such as full-file write payloads) to their first line with a summary note.
3. **Bridge**:
   Replaces verbose debugging detours with a concise milestone summary while preserving symbol references identified by the continuity guard:

<p align="center">
  <img src="docs/walkthrough/img/13-bridge-drafted.png" alt="Drafted Continuity Bridge" width="70%">
</p>

---

### 4. Claude Code TUI Mod

Dock an interactive context pane directly inside Claude Code:

<p align="center">
  <img src="docs/walkthrough/img/02-overview.png" alt="Live ctxtree TUI Mod in Claude Code" width="49%">
  <img src="docs/walkthrough/img/21-claude-stages.png" alt="Claude Staging a Cleanup" width="49%">
</p>

- **Docked Pane**: Runs side-by-side with your active chat via `/ctxtree`.
- **Non-Blocking**: Inspect context and navigate tokens while Claude is thinking or generating code.
- **Permission Boundary**: Claude can inspect context and stage candidate deletions (`mcp__ctxtree__stage`), but only the user can press <kbd>a</kbd> (Apply) to execute the fork.
- **Action Band**: When a cleanup plan is staged, a non-intrusive action bar docks above your prompt:

<p align="center">
  <img src="docs/walkthrough/img/14-band.png" alt="Action Band docked above prompt" width="75%">
</p>

---

### 5. Architecture & Safety Invariants

Every fork is verified against 8 structural invariants before being written:

<p align="center">
  <img src="docs/walkthrough/img/diagram-architecture.png" alt="System Architecture Diagram" width="85%">
</p>

- **Structural Integrity**: Enforces strict user/assistant alternation, tool call pairing, cryptographic thinking block immutability, and JSON payload validity.
- **Atomic Staging**: Transcripts are written to a hidden temporary sibling file, re-read and validated, then atomically renamed into place.
- **APFS Copy-on-Write**: File history (`~/.claude/file-history`) is cloned via APFS `cp -c -R` in ~35ms with zero duplicate disk usage.
- **Lineage & Rollback**: Parent-child lineage is logged in `~/.claude/ctxtree/lineage.jsonl`. Unmodified original transcripts are preserved under `~/.claude/ctxtree/originals/`.

<p align="center">
  <img src="docs/walkthrough/img/diagram-apply.png" alt="Transcript Apply Diagram" width="70%">
</p>

---

### 6. Terminal CLI & Boot Inspection

Audit and manage session contexts directly from the terminal:

<p align="center">
  <img src="docs/walkthrough/img/cli-01-scan.png" alt="Fast CLI Scan" width="49%">
  <img src="docs/walkthrough/img/cli-02-boot.png" alt="CLI Boot Overhead Inspection" width="49%">
</p>

```bash
# Summarize sessions across all projects
npx ctxtree --cli

# Inspect boot overhead (MCP schemas, skills, system prompt)
npx ctxtree --boot <session-id-prefix>

# Audit prompt regions and continuity anchors
npx ctxtree --context <session-id-prefix>

# Bridge heavy tool outputs (dry run)
npx ctxtree --bridge <session-id-prefix> --threshold 2500 --dry-run
```

---

## Deleting Boot Overhead

MCP schemas, skill listings, CLAUDE.md files, and system prompt snapshots are written into the transcript and replayed on resume. `ctxtree` can prune them from the fork and generate a matching **Launch Profile**:

| Overhead Item | In the Fork's Transcript | Launch Profile Overlay | Persistence |
|---|---|---|---|
| **MCP Server** | Instructions dropped; names retained | `permissions.deny: ["mcp__<server>"]` | Until fork compacts |
| **Built-in Tool** | Dropped from recorded tool list | `permissions.deny: ["<Tool>"]` | Permanent via profile |
| **Skill Listing** | Line dropped; name retained | `skillOverrides: {name: "user-invocable-only"}` | Permanent via profile |
| **CLAUDE.md** | Dropped from instructions record | `claudeMdExcludes: [path]` | Permanent via profile |
| **Auto-Memory** | `MEMORY.md` dropped | `autoMemoryEnabled: false` | Permanent via profile |
| **System Prompt** | Section trimmed from snapshot | — | Until fork compacts |

Resume the fork using its generated profile:

```bash
npx ctxtree resume <fork-prefix>
```

---

## Keyboard Shortcuts

### TUI Mod (Inside Claude Code)

| Key | Action |
|---|---|
| <kbd>/ctxtree</kbd> | Open or close the docked split-pane |
| <kbd>j</kbd> / <kbd>k</kbd> or <kbd>↑</kbd> / <kbd>↓</kbd> | Navigate tasks and blocks |
| <kbd>l</kbd> / <kbd>h</kbd> or <kbd>→</kbd> / <kbd>←</kbd> | Expand / collapse tree folders |
| <kbd>x</kbd> or <kbd>Space</kbd> | Mark / unmark selected block for deletion |
| <kbd>d</kbd> or Right-Click | Surgery menu (<kbd>1</kbd> Drop, <kbd>2</kbd> Shrink, <kbd>3</kbd> Bridge) |
| <kbd>1</kbd> / <kbd>2</kbd> | Switch view: **By Task** / **By Type** |
| <kbd>t</kbd> · <kbd>i</kbd> · <kbd>k</kbd> | Switch side-panel: **Types** · **Details** · **Keys** |
| <kbd>f</kbd> | Filter blocks by keyword (<kbd>Enter</kbd> to apply, empty <kbd>Enter</kbd> to clear) |
| <kbd>s</kbd> | Cycle sort order: **By Size** → **By Story Order** → **By Name** |
| <kbd>u</kbd> | Undo last mark operation |
| <kbd>r</kbd> | Open deletion review dialog |
| <kbd>a</kbd> | **Apply**: Write verified fork & rebuild conversation |
| <kbd>z</kbd> | Toggle wide mode (fullscreen pane ⇄ docked pane) |
| <kbd>Esc</kbd> | Return keyboard focus to Claude Code prompt |

### Web UI Dashboard

| Shortcut | Action |
|---|---|
| <kbd>Click</kbd> | Select node in tree or block in treemap |
| <kbd>Right-Click</kbd> | Open surgery context menu (Drop, Shrink, Keep latest) |
| <kbd>Delete</kbd> or <kbd>⌫</kbd> | Mark / unmark selected item |
| <kbd>⌘</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> + <kbd>Z</kbd> | Undo last mark action |
| <kbd>⌘</kbd> + <kbd>K</kbd> / <kbd>Ctrl</kbd> + <kbd>K</kbd> | Open session switcher |
| <kbd>⌘</kbd> + <kbd>F</kbd> / <kbd>Ctrl</kbd> + <kbd>F</kbd> | Focus search filter input |

---

## Technical Specifications

- **Scan Speed**: Streams and aggregates 150MB+ across 60+ sessions in under 0.8s via a single-pass JSONL parser.
- **Fork Latency**: ~35ms copy-on-write transcript cloning using APFS primitives (`cp -c -R`).
- **Dependencies**: 0 external runtime npm dependencies. Uses standard Node.js libraries (`node:fs`, `node:http`, `node:crypto`).
- **Security**: Binds strictly to `127.0.0.1`, validates Host headers against DNS rebinding, and enforces script-locking Content Security Policy.

---

## Verification & Testing

The test suite covers invariant validation, APFS cloning, and parser edge cases:

```bash
# Run unit and integration tests (78 tests, ~850ms)
npm test

# Verify dry runs on real local sessions without writing
npm run verify:real

# End-to-end integration tests
npm run verify:cc
npm run verify:tui
```

---

## Repository Structure

```text
ctxtree/
├── bin/
│   └── ctxtree.js          # CLI launcher, terminal reports, and scanner
├── src/
│   ├── session.js          # Transcript parser: chains, grey-content, addresses
│   ├── fork.js             # Atomic fork writer, invariant verification, rollback
│   ├── boot.js             # Boot overhead analysis, attachment surgery, profiles
│   ├── restructure.js      # Structural operations: uncompact, branch switch, slim
│   ├── map.js              # Deletable context tree model & token anchoring
│   ├── surgery.js          # Node-to-deletion translation layer
│   ├── sessionEditor.js    # Continuity heuristics & bridge synthesis
│   ├── server.js           # Zero-dependency loopback HTTP server & REST API
│   ├── scan.js             # Streaming JSONL parser (<0.8s across 60+ sessions)
│   ├── model.js            # Ground-truth anchored session model
│   └── tokens.js           # Multi-tier token estimation & calibration
├── ui/
│   ├── index.html          # Web interface (Tree, Types, Details, Treemap)
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
│   └── walkthrough/img/    # Visual assets and architecture diagrams
└── test/                   # Test suite (78 tests)
```

---

## Author

Developed by **Yashwant K**:
- GitHub: [@Yashwant00CR7](https://github.com/Yashwant00CR7)
- LinkedIn: [Yashwant K](https://www.linkedin.com/in/yashwant00cr7/)

---

## License

[MIT](LICENSE) © Yashwant K
