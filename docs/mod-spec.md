# ctxtree as a Claude Code mod — v1 spec

Status: design agreed 2026-10-03; spike run the same day (see *Spike results*): live
editing works, with two design changes. Nothing built in the repo yet.
Target: Claude Code 2.1.288 mod API (early access; the bundled `claude-code.d.ts`
is the authority, and it changes between releases).

## What it is

Today ctxtree edits a session from the outside: you open the web UI, mark what to
delete, it writes a verified fork, and you `claude --resume` that fork.

The mod moves that inside the session. You tell Claude what you want gone ("drop the
auth debugging file reads"), Claude maps the session, interviews you until the
request is unambiguous, stages a plan, and **you** press Apply. The edit lands in the
running session. No fork to resume, no restart.

## Decisions

| | Decision |
|---|---|
| Mechanism | Live edit: a `session.compact` hook answers the rewritten message list, which becomes the transcript. A fork snapshot (APFS clone) is taken before every apply. |
| Interface | A `ctxtree` skill shipped in the plugin. Claude maps, interviews with AskUserQuestion, stages. |
| Gate | Claude can map and stage only. **Applying happens only on a person's press** (band or review card). No model-callable apply tool exists. |
| v1 edits | Drop / shrink tool output; Claude-written bridges on **any block** (tool output, your prompts, Claude's replies). |
| Not in v1 | Collapsing a task to one milestone turn; boot-overhead removal (MCP, skills, CLAUDE.md, system prompt); intercepting auto-compaction; terminal treemap. |
| Self-trace | The cleanup turn (request, map output, interview, staging) is erased by the same edit, leaving one note. |
| Undo | Restore dropped blocks in place, live, keeping every turn since. Not gated (it only adds context). The snapshot covers a full rollback via resume. |
| Proactive | Status line meter, always on. Nudge band when context crosses a threshold. |
| Engine | One I/O-free core in `src/`; a Node adapter for the CLI, a `$` adapter for the mod. |
| Web UI | **Superseded 2026-10-05**: the UI moves into the terminal, in two phases; the web UI is retired after phase 2. See [`tui-design.md`](tui-design.md), which also proposes replacing the *Engine* row with an engine sidecar. |
| Fallback | If live replacement can't be made safe: same UX, but Apply builds a verified fork and puts `claude --resume <fork>` on the clipboard. |
| Audience | Owner first, publishable later. Repo root is the plugin, loaded with `--plugin-dir`. |

Defaults taken without a separate decision (change freely):
- Claude writes bridge text during the interview; the review card shows it verbatim.
- `map` answers task-level summaries; drill-down is a second call.
- Only the main conversation is edited, never a subagent's.
- Nudge threshold 75%, a `userConfig` option.

## The flow

```
you: /ctxtree drop the auth debugging stuff        (or just ask; the skill triggers)
  Claude → mcp__ctxtree__map          tasks, tokens, "out of date", "not mentioned since"
  Claude → mcp__ctxtree__inspect      drill into a task or block when needed
  Claude → AskUserQuestion            "OAuth refactor (turns 4–9) or login bug (12–15)?"
                                      "server.go is referenced in turn 24 — bridge or drop?"
  Claude → mcp__ctxtree__stage        ops: drop | shrink | bridge(text)
           mod resolves every target, counts tokens, flags continuity anchors,
           stores the plan in $.state, answers "staged, waiting for the person"
  turn ends
band:  Plan ready · 7 items · −12.4k tokens   [Review] [Apply] [Cancel]
you:   Apply  (ui.press — the only path to an edit)
  mod  re-resolves the plan against the current messages; drifted items are refused
  mod  writes the fork snapshot
  mod  $.session.compact()  →  its own session.compact hook answers { messages }
  toast: Freed 12.4k tokens · /ctxtree undo to restore
```

The rewritten list replaces each targeted block, erases the cleanup turn, and adds one
note in its place: `[ctxtree: removed 7 tool outputs (~12.4k tokens), bridged
server.go. Re-run anything you need.]`. Messages not touched are handed back with
their engine `handle`, so they stand exactly as the engine has them (signed thinking
included).

## Mod surface

Tools (listed to the model as `mcp__ctxtree__<name>`):

| Tool | Does | Writes context? |
|---|---|---|
| `map` | Session as tasks: tokens, files touched, out-of-date and not-mentioned-since flags | no |
| `inspect` | One task's items, or one block's text (capped) | no |
| `stage` | Validates and stores a plan; returns its summary and warnings | no (plan only) |
| `restore` | Queues dropped blocks to be put back in place | yes, at turn end, ungated |

There is deliberately no `apply` tool.

Hooks: `session.start` (register tools and commands), `tool.call` (serve the tools),
`session.compact` (answer the rewritten list when a plan is pending), `ui.render`
(band, review pane), `ui.press` (Apply / Cancel / Review / Clean up),
`session.measure` (status line, nudge), `command.run` (`/ctxtree`, `/ctxtree undo`,
`/ctxtree ui`).

State (`$.state`, declared in `types/index.d.ts`): the staged plan, a pending-apply
flag the compact hook reads, the last-applied record for undo, nudge bookkeeping.

## Addressing blocks

Tool output is addressed by `tool_use_id`: exact, stable across new turns.

Prompts and replies have no id in the live API (`$.session.messages()` carries no
uuid; the compact hook carries opaque handles). They are addressed by **position plus
fingerprint** of the text Claude saw when it staged:

1. Position still holds the same fingerprint → hit.
2. Position moved (turns arrived since staging) → search for the fingerprint; exactly
   one match → hit.
3. No match, or more than one → **refuse that item** ("this changed — re-plan"). An
   edit never lands on a different message.

A real compaction between staging and Apply invalidates the whole plan.

## Proposed layout

```
.claude-plugin/plugin.json      name, version, "types": "./types/index.d.ts"
hooks/hooks.json                { "modules": ["./register.tsx"] }
hooks/register.tsx              the mod
skills/ctxtree/SKILL.md         map → interview → stage; never claims to apply
types/index.d.ts                $.state contract
src/                            I/O-free core (session model, tasks, signals,
                                tombstones, bridges' anchors, plan resolution, verify)
src/node/                       CLI adapter: node:fs, node:crypto, child_process
src/mod/                        mod adapter: $.fs, $.process
bin/ ui/                        unchanged; CLI and web UI
```

After the spike this becomes two plugins: the repo root stays `ctxtree` (it needs
`src/`), and `plugins/ctxtree-ui/` holds the band, the review pane and the Apply press.
It needs no core code, only the noun `ctxtree` adds. A root `marketplace.json` can list
both when it's published.

The core refactor must leave behaviour unchanged: `npm test`, `verify:real` and
`verify:cc` green before any mod code lands. `node:crypto` sha1 (block fingerprints)
becomes a pure-JS hash in the core, with fingerprints identical to today's so
lineage and staleness checks keep working.

## Spike results (2026-10-03, Claude Code 2.1.288)

Throwaway mod plus harness in a `verify:cc`-style sandbox (throwaway config dir,
recording API stand-in), driven headless (`claude -p`, stream-json for several
prompts in one process) and interactive (a real TUI through a pty).

| # | Question | Result |
|---|---|---|
| 1 | Mixed handle-kept and hook-built lists accepted, pairing intact | ✅ live. ❌ **on resume**: an assistant message kept by `handle` keeps its API `message.id`, and resume merges it with its pre-compaction twin, so the original tool result comes back and the text is duplicated. **Rebuilding every message (no handles) is correct both live and on resume.** |
| 2 | Own `session.compact` hook fires when own code calls `$.session.compact()` | ✅ from inside a `turn.complete` hook (awaited). ❌ from a `ui.press` handler or `$.clock.after`: `skipped: re-entry (the plugin's own code raised it)`, and core's lossy compaction runs instead. ✅ when **another plugin's** press calls `$.session.compact()` or `$.command.run({command:"compact"})`. ❌ from `command.run` (refused: "call it from a later event (turn.complete)"). |
| 3 | Persistence | ✅ A `compact_boundary` plus the rebuilt records are appended; a later `claude --resume` (no mod loaded) sends the edited version. Pre-edit records stay in the file before the boundary. |
| 4 | Summary header | ✅ None: the hook's list stands as-is ("core never ran"). |
| 5 | Erasing the trailing turn | ✅ Valid sequence, no orphan tool_results, no consecutive roles; the note lands as the last user message. |
| 6 | Alignment | ✅ `e.messages` and `$.session.messages({as:"api"})` had the same count and order. 4096 cap not tested. |
| 7 | Apply at turn end | ✅ `await $.session.compact()` inside `turn.complete`. ❌ via `$.clock.after` (re-entry skip). |
| 8 | Lossy rebuilds | Rebuilt messages carry text and tool blocks only, so earlier turns' thinking blocks go. ✅ **Real API accepts it** (manual check 2026-10-04: interactive session on the owner's normal login, a Read turn and a thinking turn, every tool result dropped and every message rebuilt via the Apply press, then one more prompt; Claude answered normally). Images not tested. |
| 9 | `$.fs` | Has read, write, list, exists and stat. **No rename, no delete; reads capped at 4 MiB.** |
| 10 | Cache cost | Not measured yet. |

Also: `$.session.compact()` is unavailable in headless sessions (`-p`, SDK), but a
`/compact` typed in `-p` raises the hook with `trigger: "manual"`, which is how e2e
tests exercise the rewrite.

### What changes in the design

- **Rebuild every message.** The compact hook hands back no handles. Signed thinking
  from earlier turns is dropped (applies only between turns, never mid tool loop).
- **Two plugins.** `ctxtree` owns the tools, the plan, and the `session.compact` hook.
  `ctxtree-ui` owns the band, the review pane, and the Apply press, which marks the plan
  approved through a noun `ctxtree` adds in `engine.create` and then calls
  `$.session.compact()`. The core hook applies only a plan marked approved, and passes
  every other compaction (`/compact`, auto) through untouched, invalidating the plan.
  The noun handoff is not yet tested.
- **Restore** (`mcp__ctxtree__restore`) applies from `turn.complete`, awaited directly.
- **No separate snapshot write.** The transcript keeps every pre-edit record before the
  boundary, so full rollback is an uncompact fork with the existing engine (extended to
  pick a boundary when several applies stacked up). The dropped originals are saved
  by the mod at apply time (sidecar files under `~/.claude/ctxtree/`, split to stay
  under the 4 MiB read cap), so restore never re-reads a large transcript.
- **Interactive only.** In `-p`/SDK the mod maps and stages, but Apply is unavailable.

### Still open

- Images in a rebuilt or bridged message.
- The `engine.create` noun handoff between the two plugins.
- The 4096-message cap; prompt re-cache cost per apply.

## Open points the spike settled

Kept for the record; answers are in the table above.

1. **Mixed lists are accepted.** Handle-kept and hook-built messages together produce
   a valid next request; built messages can carry `tool_use` / `tool_result` with the
   original ids, pairing intact.
2. **Own hook fires.** `$.session.compact()` "runs through every hook but the calling
   one" — confirm the mod's `session.compact` hook runs when its `ui.press` handler
   is the caller.
3. **Persistence.** What the hook-answered compaction writes to the JSONL, and that a
   later `claude --resume` loads the edited version, not the original.
4. **No summary header.** Whether the engine adds its own "continued from" summary
   around a hook-answered list.
5. **Erasing the trailing turn** leaves a valid sequence; where the note goes and in
   which role.
6. **Alignment.** `e.messages` in `session.compact` lines up 1:1 with
   `$.session.messages({ as: "api" })`, and what happens past the 4096-message cap.
7. **Applying at turn end** (queued `restore`): whether `$.session.compact()` can run
   from `turn.complete` or a `$.clock.after` just after it.
8. **Lossy rebuilds.** What a hook-built message loses (thinking: fine, finished turns
   drop it anyway; images: a bridge on a message with an image must refuse or keep it).
9. **`$.fs` for the snapshot.** Atomic write (temp + rename), read-back, size limits.
10. **Cache cost.** One full prompt re-cache per apply; measure it.

Any of 1, 3 or 6 failing triggers the fallback (Apply builds a fork instead).

## Test plan

Critical areas, tested hardest:

- **Matching**: exact `tool_use_id` hit; position+fingerprint hit; duplicate text;
  turns arriving between stage and Apply (positions shift); a block that changed
  after staging is refused, never misapplied; a compaction between stage and Apply
  invalidates the plan.
- **Gate**: no tool the model can call reaches an apply; only `ui.press` does.
- **Live result**: the next request's bytes match the plan; tool pairing intact; signed
  thinking untouched; every unedited message identical.
- **Persistence**: resume after a live edit loads the edited version.
- **Self-trace**: erasing the cleanup turn leaves a valid sequence with the note.
- **Restore**: bringing a block back three turns later keeps those turns.

Where: `claude plugin test` for the mod's own logic (its hooks sit above stand-ins,
so it cannot exercise real compaction); `verify:cc`, extended with a live-mod path,
for everything that depends on what Claude Code actually sends and stores. Re-run
`verify:cc` after every Claude Code update.

## Order of work

1. Spike → report on the ten open points; choose live or fallback.
2. Core refactor: split I/O out, behaviour unchanged, all suites green.
3. Mod skeleton: manifest, tools (`map`, `inspect`, `stage`), skill, band, review pane.
4. Apply: snapshot, re-resolve, compact hook, self-trace note.
5. Restore and `/ctxtree undo`.
6. Status line meter and nudge band.
7. `/ctxtree ui` (needs a session deep link in the server).
8. `verify:cc` live-mod path; README section.
