#!/usr/bin/env node

import { exec } from 'node:child_process';
import os from 'node:os';
import { CtxServer } from '../src/server.js';
import { build } from '../src/model.js';
import { findings } from '../src/findings.js';
import { getSessionContext } from '../src/sessionEditor.js';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
ctxtree - WizTree for the LLM Context Window

Usage:
  npx ctxtree [options]
  node bin/ctxtree.js [options]

Options:
  -p, --port <port>    Port to listen on (default: 3888)
  --no-open            Do not automatically open browser
  --scan-only, --cli   Scan history, print terminal report and exit
  --context [sid]      Inspect paragraphs, prompt regions, and continuity anchors
  -h, --help           Show this help message
`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  printHelp();
}

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
  Total Paragraphs : ${ctx.totalBlocks}
  Total Tokens     : ${fmt(ctx.totalTokens)} tok
  Total Allocated  : ${fmt(ctx.totalAlloc)} (x turns resident)
  Prompt Milestones: ${ctx.regions.length}

PROMPT REGIONS:`);

  ctx.regions.slice(0, 6).forEach((r, i) => {
    console.log(`  [Region ${i + 1}] "${r.prompt.slice(0, 60)}" (Turn ${r.turn} · ${fmt(r.tok)} tok · ${r.blocksCount} items)`);
  });

  const heavyBlocks = ctx.blocks.filter(b => b.tok >= 2000).sort((a, b) => b.tok - a.tok);
  console.log(`\nHEAVY PARAGRAPHS & CONTINUITY ANCHORS (${heavyBlocks.length} items >= 2k tok):`);
  heavyBlocks.slice(0, 6).forEach(b => {
    const risk = b.continuity.riskLevel === 'high' ? '🔴 HIGH RISK' : (b.continuity.riskLevel === 'medium' ? '🟡 ANCHOR' : '🟢 SAFE');
    console.log(`  • [${fmt(b.tok).padStart(6)} tok] Turn ${String(b.turn).padStart(3)} | ${b.role}:${b.tool || b.kind} | ${risk} | ${(b.target || '').slice(0, 40)}`);
    if (b.continuity.downstreamCount > 0) {
      console.log(`    ↳ Downstream refs: ${b.continuity.downstreamRefs.map(r => r.term + ' (turn ' + r.turn + ')').join(', ')}`);
    }
    console.log(`    ↳ Smart Bridge: ${b.suggestedBridge.slice(0, 80)}...`);
  });

  console.log(`
To edit these paragraphs interactively with real-time continuity checking:
  Run: npx ctxtree
=============================================================\n`);
  process.exit(0);
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
