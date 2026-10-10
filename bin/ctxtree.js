#!/usr/bin/env node

import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { CtxServer } from '../src/server.js';
import { build } from '../src/model.js';
import { findings } from '../src/findings.js';
import { getSessionContext, quickBridgeSession, simulateResumedSession } from '../src/sessionEditor.js';
import { listForks } from '../src/fork.js';
import { bootView, structureView } from '../src/surgery.js';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
ctxtree - WizTree for the LLM Context Window

Usage:
  npx ctxtree [options]
  node bin/ctxtree.js [options]

Commands:
  resume <fork>        Resume a ctxtree fork (id or prefix) with its launch profile.
                       Forks that removed boot overhead MUST be resumed this way:
                       without the profile Claude Code re-announces what was removed.

Options:
  -p, --port <port>    Port to listen on (default: 3888)
  --no-open            Do not automatically open browser
  --scan-only, --cli   Scan history, print terminal report and exit
  --context [sid]      Inspect paragraphs, prompt regions, and continuity anchors
  --preview [sid]      Simulate and preview resumed conversational stream in terminal
  --boot <sid>         What boot overhead the session resumes with, and what can be removed
  --bridge <sid>       Bridge heavy live tool output into a fork (session id or prefix required)
  --threshold <n>      Token threshold for --bridge (default: 2500)
  --dry-run            With --bridge: build and verify the fork, write nothing
  -h, --help           Show this help message
`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  printHelp();
}

if (args[0] === 'resume') {
  const want = args[1];
  const forks = listForks().filter(f => want && f.forkSid.startsWith(want));
  if (forks.length !== 1) {
    console.error(!want ? 'Usage: ctxtree resume <fork id or prefix>' : forks.length ? `"${want}" matches ${forks.length} forks; use a longer prefix.` : `No ctxtree fork matches "${want}".`);
    process.exit(2);
  }
  const f = forks[0];
  const claudeArgs = ['--resume', f.forkSid];
  if (f.profileFile) {
    if (!fs.existsSync(f.profileFile)) { console.error(`This fork's launch profile is missing: ${f.profileFile}`); process.exit(1); }
    claudeArgs.push('--settings', f.profileFile);
  }
  claudeArgs.push(...args.slice(2));
  const cwd = f.cwd && fs.existsSync(f.cwd) ? f.cwd : process.cwd();
  console.error(`ctxtree: claude ${claudeArgs.join(' ')}   (in ${cwd})`);
  const child = spawn('claude', claudeArgs, { cwd, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error(`Could not start claude: ${err.message}`); process.exit(1); });
} else {
  main();
}

async function main() {
const scanOnly = args.includes('--scan-only') || args.includes('--cli');
const noOpen = args.includes('--no-open');

let port = 3888;
const pIdx = args.findIndex(a => a === '-p' || a === '--port');
if (pIdx !== -1 && args[pIdx + 1]) {
  port = parseInt(args[pIdx + 1], 10) || 3888;
}

function fmt(n) {
  if (n == null) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
}

if (scanOnly) {
  console.log('⚡ Scanning Claude Code sessions...');
  const t0 = Date.now();
  const model = build();
  const f = findings(model);
  const dur = Date.now() - t0;

  console.log(`
=============================================================
  ctxtree - Context Window Analysis (${dur}ms)
=============================================================
  Total Sessions       : ${model.sessions.length}
  Total Files          : ${model.stats.nFiles}
  Total Distinct Size  : ${fmt(model.stats.tok)} tokens
  Total Allocated      : ${fmt(model.stats.alloc)} tokens (x turns resident)
  Subagents Context    : ${fmt(model.stats.subTok)} tokens (${model.stats.nSub} subagents)
  Compaction Hits      : ${model.stats.compacts} times

PROVEN SAVINGS (${f.proven.length} items, ${fmt(f.provenTotal)} tokens):
`);

  for (const r of f.proven.slice(0, 5)) {
    console.log(`  • [${fmt(r.saves).padStart(6)}] ${r.title}`);
    for (const e of r.evidence) console.log(`              ${e}`);
  }

  console.log(`\nINFERRED SAVINGS (${f.inferred.length} items, ${fmt(f.inferredTotal)} tokens):`);
  for (const r of f.inferred.slice(0, 5)) {
    console.log(`  • [${fmt(r.saves).padStart(6)}] ${r.title}`);
    for (const e of r.evidence) console.log(`              ${e}`);
  }

  console.log(`
Top 5 Bloated Sessions:`);
  for (const s of model.sessions.slice(0, 5)) {
    console.log(`  ${s.sid.slice(0, 8)} | ${s.projectName.padEnd(25)} | Size: ${fmt(s.tok).padStart(6)} | Alloc: ${fmt(s.alloc).padStart(7)} | Turns: ${String(s.turns).padStart(4)}`);
  }
  console.log('=============================================================\n');
  process.exit(0);
}

const ctxIdx = args.findIndex(a => a === '--context');
if (ctxIdx !== -1) {
  const model = build();
  let targetSid = args[ctxIdx + 1];
  if (!targetSid || targetSid.startsWith('-')) {
    targetSid = model.sessions[0]?.sid;
  } else {
    // fuzzy match prefix
    const found = model.sessions.find(s => s.sid.startsWith(targetSid));
    if (found) targetSid = found.sid;
  }

  if (!targetSid) {
    console.error('No matching session found.');
    process.exit(1);
  }

  const ctx = getSessionContext(targetSid, model);
  console.log(`
=============================================================
  ctxtree - Context Surgeon Audit: [${ctx.sid.slice(0, 8)}] ${ctx.projectName}
=============================================================
  Total Turns      : ${ctx.totalTurns}
  Total Paragraphs : ${ctx.totalBlocks} (${ctx.liveBlocks} in resumed context, ${ctx.deadBlocks} outside it)
  Resumed Context  : ~${fmt(ctx.totalTokens)} tok   (outside it: ~${fmt(ctx.deadTokens)} tok, not loaded on resume)
  Total Allocated  : ${fmt(ctx.totalAlloc)} (x turns resident)
  Prompt Milestones: ${ctx.regions.length}

PROMPT REGIONS:`);

  ctx.regions.slice(0, 6).forEach((r, i) => {
    console.log(`  [Region ${i + 1}] "${r.prompt.slice(0, 60)}" (Turn ${r.turn} · ${fmt(r.tok)} tok · ${r.blocksCount} items)`);
  });

  const heavyBlocks = ctx.blocks.filter(b => b.live && b.tok >= 2000).sort((a, b) => b.tok - a.tok);
  console.log(`\nHEAVY PARAGRAPHS & CONTINUITY ANCHORS (${heavyBlocks.length} items >= 2k tok):`);
  heavyBlocks.slice(0, 6).forEach(b => {
    const risk = b.continuity.riskLevel === 'high' ? '🔴 HIGH RISK' : (b.continuity.riskLevel === 'medium' ? '🟡 ANCHOR' : '🟢 SAFE');
    console.log(`  • [${fmt(b.tok).padStart(6)} tok] Turn ${String(b.turn).padStart(3)} | ${b.role}:${b.tool || b.kind} | ${risk} | ${(b.target || '').slice(0, 40)}`);
    if (b.continuity.downstreamCount > 0) {
      console.log(`    ↳ Downstream refs: ${b.continuity.downstreamRefs.map(r => r.term + ' (turn ' + r.turn + ')').join(', ')}`);
    }
    console.log(b.editable ? `    ↳ Smart Bridge: ${b.suggestedBridge.slice(0, 80)}...` : `    ↳ Locked: ${b.lock}`);
  });

  console.log(`
To edit these paragraphs interactively with real-time continuity checking:
  Run: npx ctxtree
=============================================================
`);
  process.exit(0);
}

const bootIdx = args.findIndex(a => a === '--boot');
if (bootIdx !== -1) {
  const model = build();
  const want = args[bootIdx + 1];
  const matches = model.sessions.filter(s => want && !want.startsWith('-') && s.sid.startsWith(want));
  if (matches.length !== 1) { console.error(matches.length ? `"${want}" matches ${matches.length} sessions.` : 'Usage: ctxtree --boot <session id or prefix>'); process.exit(2); }
  const b = bootView(model, matches[0].sid);
  const st = structureView(model, matches[0].sid);
  console.log(`\n  Boot overhead resumed by ${matches[0].sid.slice(0, 8)} (${matches[0].projectName}): ~${fmt(b.total)} tokens\n`);
  const bySub = new Map();
  for (const it of b.items) { const l = bySub.get(it.sub) || []; l.push(it); bySub.set(it.sub, l); }
  for (const [sub, list] of bySub) {
    console.log(`  ${sub.padEnd(16)} ~${fmt(list.reduce((a, i) => a + i.tok, 0)).padStart(6)}`);
    for (const it of list.slice(0, 8)) console.log(`      ${fmt(it.tok).padStart(6)}  ${it.name.slice(0, 70)}${it.removable ? '' : '   (not removable)'}`);
    if (list.length > 8) console.log(`      ...and ${list.length - 8} more`);
  }
  console.log(`\n  Outside the resumed context: ~${fmt(st.dead.tok)} tokens (${st.dead.blocks} blocks) -- saves nothing if deleted.`);
  if (st.compaction) console.log(`    before the last compaction: ~${fmt(st.compaction.compactedTok)} tokens${st.compaction.restorable ? ' (restorable: uncompact)' : ''}`);
  if (st.branches.length) console.log(`    on ${st.branches.length} rewind branch(es) you left (switchable)`);
  console.log(`\n  Remove any of it in the UI (npx ctxtree): right-click a node in the tree.\n`);
  process.exit(0);
}

const prevIdx = args.findIndex(a => a === '--preview' || a === '--simulate');
if (prevIdx !== -1) {
  const model = build();
  let targetSid = args[prevIdx + 1];
  if (!targetSid || targetSid.startsWith('-')) {
    targetSid = model.sessions[0]?.sid;
  } else {
    const found = model.sessions.find(s => s.sid.startsWith(targetSid));
    if (found) targetSid = found.sid;
  }

  if (!targetSid) {
    console.error('No matching session found.');
    process.exit(1);
  }

  const sim = simulateResumedSession(targetSid, [], model);
  console.log(`
=============================================================
  ctxtree - Resumed Session Dialogue Simulator [${targetSid.slice(0, 8)}]
=============================================================
  Total Turns         : ${sim.turnsCount}
  Total Original Tok  : ${fmt(sim.totalOriginalTok)} tok
  Total Simulated Tok : ${fmt(sim.totalSimulatedTok)} tok
  Anchor terms        : ${sim.continuity.isClean ? 'all preserved (keyword heuristic)' : `${sim.continuity.healthScore}% preserved (${sim.continuity.warnings.length} missing)`}

SAMPLE RESUMED TURNS:`);

  sim.turns.slice(0, 5).forEach(t => {
    console.log(`\n--- Turn ${t.turn} (${t.role === 'user' ? '👤 User' : '🤖 Assistant'} · ${fmt(t.tok)} tok) ---`);
    t.messages.forEach(m => {
      const tag = m.isEdited ? ' [BRIDGED]' : '';
      console.log(`[${m.tool || m.kind}]${tag}: ${m.text.slice(0, 120).replace(/\n/g, ' ')}...`);
    });
  });

  console.log(`\n=============================================================\n`);
  process.exit(0);
}

const bridgeIdx = args.findIndex(a => a === '--bridge');
if (bridgeIdx !== -1) {
  // Writing a fork is never a default: the session must be named explicitly.
  const want = args[bridgeIdx + 1];
  if (!want || want.startsWith('-')) {
    console.error('--bridge needs a session id (or a unique prefix). List sessions with: ctxtree --cli');
    process.exit(2);
  }
  const model = build();
  const matches = model.sessions.filter(s => s.sid.startsWith(want));
  if (matches.length !== 1) {
    console.error(matches.length ? `"${want}" matches ${matches.length} sessions; use a longer prefix.` : `No session matches "${want}".`);
    process.exit(2);
  }
  const targetSid = matches[0].sid;

  let threshold = 2500;
  const tIdx = args.findIndex(a => a === '--threshold');
  if (tIdx !== -1 && args[tIdx + 1]) threshold = parseInt(args[tIdx + 1], 10) || 2500;
  const dryRun = args.includes('--dry-run');

  console.log(`${dryRun ? 'Dry run: ' : ''}bridging live tool output >= ${threshold} tok in ${targetSid.slice(0, 8)}...`);
  const t0 = Date.now();
  try {
    const res = await quickBridgeSession({ sid: targetSid, threshold, dryRun, note: `CLI bridge at threshold ${threshold}` }, model);
    if (!res.ok) { console.log(res.message); process.exit(0); }
    console.log(`
=============================================================
  ctxtree - ${dryRun ? 'Fork verified (dry run, nothing written)' : 'Fork created'} (${Date.now() - t0}ms)
=============================================================
  Parent session   : ${res.parentSid} (${res.projectName})
  Fork session     : ${res.forkSid}${dryRun ? '  (not written)' : ''}
  Blocks rewritten : ${res.edits}   records touched: ${res.modifiedRecords}
  Resumed context  : ~${fmt(res.resume.before)} -> ~${fmt(res.resume.after)} tokens (${fmt(res.savedTok)} reclaimed)
  Verified         : record count, uuid chain, resume leaf, tool pairing,
                     session ids, and every unedited block unchanged
  File history     : ${dryRun ? '-' : res.history}
${dryRun ? '' : `
Resume the fork with:
  ${res.resumeCmd}
`}=============================================================
`);
    process.exit(0);
  } catch (err) {
    console.error(`Fork not created: ${err.message}`);
    for (const p of err.problems || []) console.error(`  - ${p.error}`);
    process.exit(1);
  }
}

const server = new CtxServer({ port });

server.start().then(({ port: actualPort, url }) => {
  const stats = server.model.stats;
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║   ctxtree - WizTree for the LLM Context Window            ║
  ║   Running at: ${url.padEnd(43)} ║
  ║   Scanned ${String(stats.nSessions).padStart(3)} sessions · ${fmt(stats.alloc)} tokens allocated       ║
  ║   Press Ctrl+C to stop                                    ║
  ╚═══════════════════════════════════════════════════════════╝
`);

  if (!noOpen) {
    const cmd = os.platform() === 'darwin' ? `open "${url}"` :
                os.platform() === 'win32' ? `start "${url}"` :
                `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
}).catch(err => {
  console.error('Failed to start ctxtree server:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down ctxtree...');
  server.stop().then(() => process.exit(0));
});
}
