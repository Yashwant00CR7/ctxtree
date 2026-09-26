# ctxtree 🌳

> **WizTree for the LLM Context Window** — Scan, see, and reclaim what your Claude Code sessions are spending tokens on.

---

## The Problem

Long LLM coding sessions silently accumulate millions of tokens. A single large file read or bash output doesn't just cost tokens once — it rides in context for dozens or hundreds of turns, multiplying its spend every single API roundtrip. Unused MCP servers ship dozens of tool schemas on turn 0 that never get called. Eventually you hit context auto-compaction, losing critical reasoning history.

**ctxtree** brings the instant clarity of [WizTree](https://diskanalyzer.com/) to LLM context management: **Scan → See → Select → Cut → Resume smaller.**

![WizTree Anatomy](https://raw.githubusercontent.com/Yashwant00CR7/ctxtree/main/docs/wiztree_concept.png)

---

## Features

- **⚡ Blazing Fast Scanner**: Scans your entire Claude Code history (`~/.claude/projects/`, 150MB+ across 60+ sessions) in **under 1.0 second**.
- **📊 Dual Measurement**:
  - **Distinct Size**: Raw tokens of a chunk.
  - **Allocated**: `Size × turns resident` — reveals the true token cost of early commands that ride along for the rest of the conversation. Anchored to ground-truth token accounting.
- **🎨 Interactive Treemap**: Squarified treemap rendering nested rectangles sized by allocated tokens with WizTree-style 3D bevels, instant hover tooltips, and drill-down navigation.
- **📁 Lever Tree**: Groups context by actionable subsystems rather than arbitrary byte buckets:
  - `boot overhead` (Tool schemas, system prompt, skill listings, MCP instructions)
  - `tool results` (Read, Bash, Edit, Glob, Grep)
  - `conversation` (User prompts, assistant responses, thinking)
  - `subagent contexts` (Sidechains and agent forks)
- **💬 Prompt Regions**: Auto-segments sessions using your genuine prompts as boundaries, collapsing noise (`continue`, interrupts) so you can see cost per milestone.
- **🎯 Two-Tier Reclaim Engine**:
  - **Tier 1 (Provable)**: Unused MCP schemas, byte-identical duplicate file reads within the same session. Pre-ticked for reclaim.
  - **Tier 2 (Inferred)**: Fat outputs (>8k tokens) and resident prefix items with transparent proxy criteria.
- **✂️ Non-Destructive Prune & Fork**:
  - **Tombstone**: Guts the body of selected tool results while preserving the 1:1 `tool_use`/`tool_result` invariant required by the Claude API.
  - **Fork**: Generates a new session UUID in-place.
  - **APFS Clone**: Fast copy-on-write clone (`cp -c -R`) of `~/.claude/file-history` (<100ms, 0 extra disk space).
  - **Lineage Manifest**: Records all parent-child forks in `~/.claude/ctxtree/lineage.jsonl` with revert capability.

---

## Quick Start

Run directly via `npx` or Node.js (requires Node 18+ with zero external dependencies):

```bash
# Start local server and automatically open WizTree interface
npx ctxtree

# Or run terminal summary report
npx ctxtree --cli

# Specify custom port
npx ctxtree --port 4000 --no-open
```

Then open `http://localhost:3888` in your browser.

---

## CLI Options

```text
ctxtree - WizTree for the LLM Context Window

Usage:
  npx ctxtree [options]
  node bin/ctxtree.js [options]

Options:
  -p, --port <port>    Port to listen on (default: 3888)
  --no-open            Do not automatically open browser
  --scan-only, --cli   Scan history, print terminal report and exit
  -h, --help           Show this help message
```

---

## Architecture

```text
ctxtree/
├── bin/
│   └── ctxtree.js        # CLI launcher & terminal report
├── src/
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
    ├── index.html        # WizTree dark layout
    ├── style.css         # Authentic WizTree styling & themes
    └── app.js            # Canvas squarified treemap & UI state engine
```

---

## Resuming a Pruned Session

When you click **"Tombstone & Fork Session"** in the UI, `ctxtree` creates a new session JSONL file with the fat chunks removed and gives you the exact command to resume:

```bash
claude --resume <new-session-uuid>
```

Your conversation continues seamlessly with all reasoning context intact, but with significant context window headroom reclaimed.

---

## License

MIT © Yashwant00CR7
