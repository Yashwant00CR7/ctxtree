# ctxtree 🌳

> **Context Surgeon & WizTree Visualizer for the LLM Context Window** — Edit paragraph contexts with surgical precision, eliminate continuity jumps, and reclaim wasted tokens across your Claude Code sessions.

---

## The Core Purpose: Jump-Free Context Surgery

Long LLM coding sessions accumulate massive amounts of token bloat: 50k file reads, repetitive command outputs, failed debugging rabbit holes, and redundant dialogue. 

However, **blindly deleting or wiping chunks breaks the narrative flow ("creates jumps")**. In future turns or when resuming, the assistant gets confused, loses critical variable names or file structures, and either re-reads the entire file or asks repetitive questions.

**ctxtree solves this fundamentally**:
- **See the Bloat**: WizTree-style interactive squarified treemap & lever tree showing where tokens are concentrated.
- **Granular Paragraph Editor**: Click any card in the chronological narrative stream to edit user prompts, assistant reasoning, or tool outputs directly.
- **Continuity Bridge Engine**: Automatically detects downstream references (e.g. `server.go` referenced in turn 24) and generates seamless semantic bridges so your next session continues with **zero jumps**.
- **Region Synthesizer**: Condense a 15-turn debugging detour into a single clean milestone.
- **In-Place Fork & Resume**: Non-destructively forks the session with fast APFS copy-on-write clone (`cp -c -R`), outputting the exact `claude --resume <fork-uuid>` command.

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
- **1:1 Tool Pairing Preserved**: Guarantees compliance with Claude API constraints.
- **APFS Clone**: Clones `~/.claude/file-history` in <100ms with zero extra disk space.
- **Lineage Manifest**: Tracks all parent-child forks in `~/.claude/ctxtree/lineage.jsonl` with revert capability.

---

## Quick Start

Run directly via `npx` or Node.js (requires Node 18+ with zero external dependencies):

```bash
# Start local server and launch Context Surgeon & WizTree UI
npx ctxtree

# Audit paragraphs, prompt regions, and continuity anchors for a session in terminal
npx ctxtree --context [session-id]

# Terminal overview of all sessions
npx ctxtree --cli

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

Your conversation continues seamlessly with all reasoning context intact, but with substantial context window headroom reclaimed.

---

## Architecture

```text
ctxtree/
├── bin/
│   └── ctxtree.js        # CLI launcher, terminal reports, and context auditor
├── src/
│   ├── sessionEditor.js  # Paragraph context parser, continuity analyzer & bridge generator
│   ├── paths.js          # Claude directory paths & slug resolvers
│   ├── attach.js         # Attachment parser (MCP schemas, system prompt, skills)
│   ├── tokens.js         # Multivariate calibration engine
│   ├── scan.js           # Fast streaming JSONL parser
│   ├── model.js          # Ground-truth anchored session model
│   ├── tree.js           # Lever tree & project breakdown builder
│   ├── regions.js        # Verbatim prompt region boundary detector
│   ├── findings.js       # Two-tier reclaim rule engine
│   ├── prune.js          # Tombstone rewriter, APFS cloner & lineage manifest
│   └── server.js         # Zero-dependency HTTP server & REST API
└── ui/
    ├── index.html        # Dual-mode Context Surgeon & WizTree layout
    ├── style.css         # Authentic dark theme, narrative cards & continuity badges
    └── app.js            # Canvas squarified treemap & paragraph editor state engine
```

---

## License

MIT © Yashwant00CR7
