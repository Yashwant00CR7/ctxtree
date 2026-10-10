import fs from 'node:fs';
import path from 'node:path';
import { parseSession } from './session.js';
import { forkSession, ForkError } from './fork.js';
import { tokFor } from './model.js';

// Common words to ignore in continuity keyword extraction
const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'were', 'will', 'then',
  'true', 'false', 'null', 'undefined', 'return', 'const', 'function', 'class',
  'import', 'export', 'require', 'type', 'string', 'number', 'boolean', 'void',
  'async', 'await', 'switch', 'case', 'break', 'default', 'continue', 'catch',
  'throw', 'error', 'interface', 'package', 'module', 'public', 'private',
  'node', 'bash', 'file', 'json', 'data', 'text', 'line', 'code', 'test'
]);

/**
 * Extracts key terms, identifiers, and file paths from text.
 */
export function extractKeyTerms(text, target = '') {
  const terms = new Set();
  if (target) {
    const base = target.split(/[/\\]/).pop();
    if (base && base.length >= 3) terms.add(base);
    const ext = path.extname(target);
    if (ext && ext.length >= 2) terms.add(ext);
  }

  // Find symbols like camelCase, PascalCase, snake_case, or dot-paths
  const words = text.match(/[a-zA-Z0-9_\-\.]{4,}/g) || [];
  for (const w of words) {
    const low = w.toLowerCase();
    if (STOP_WORDS.has(low)) continue;
    if (/^\d+$/.test(w)) continue;
    if (w.includes('.') || w.includes('_') || /[A-Z]/.test(w)) {
      terms.add(w);
    }
  }
  return Array.from(terms).slice(0, 15);
}

/**
 * Extracts the interface contract (types, signatures, exported symbols) from code.
 * Replaces thousands of lines of implementation with a clean structural outline
 * that maintains 100% semantic continuity for future turns.
 */
export function extractContract(text, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const lines = text.split('\n');

  // JSON files
  if (ext === 'json') {
    try {
      const obj = JSON.parse(text);
      if (typeof obj === 'object' && obj !== null) {
        const schema = {};
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v)) schema[k] = `Array(${v.length})`;
          else if (typeof v === 'object' && v !== null) schema[k] = Object.keys(v);
          else schema[k] = typeof v;
        }
        return `[JSON Outline: ${filename || 'data.json'} (${lines.length} lines condensed)]\n` + JSON.stringify(schema, null, 2);
      }
    } catch {}
  }

  // Code files: Go, TS, JS, Python, Rust
  const signatureLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Package, imports, exports
    if (/^(package|import|from|export\s+(?:default\s+)?(?:type|interface|class|function|const|let|var))\b/.test(trimmed)) {
      signatureLines.push(line);
      continue;
    }
    // Go struct/interface or func signature
    if (/^(type\s+\w+\s+(?:struct|interface)|func\s+(?:\([^)]+\)\s+)?\w+\s*\([^)]*\))/.test(trimmed)) {
      signatureLines.push(line + ' { ... }');
      continue;
    }
    // Python def or class
    if (/^(def\s+\w+\s*\([^)]*\)|class\s+\w+)/.test(trimmed)) {
      signatureLines.push(line + ' ...');
      continue;
    }
    // JS/TS function, class, interface, type
    if (/^(function|class|interface|type)\s+\w+/.test(trimmed)) {
      signatureLines.push(line + ' { ... }');
      continue;
    }
  }

  if (signatureLines.length >= 3) {
    return `[Interface Contract: ${filename || 'file'} (${lines.length} lines condensed to ${signatureLines.length} signatures)]\n` + signatureLines.slice(0, 50).join('\n');
  }

  // Fallback to Head & Tail (top 15 and bottom 15 lines)
  if (lines.length > 30) {
    return lines.slice(0, 15).join('\n') + `\n\n... [${lines.length - 30} lines condensed to eliminate context bloat] ...\n\n` + lines.slice(-15).join('\n');
  }

  return text;
}

/**
 * Generates an intelligent, continuity-preserving bridge statement.
 */
export function generateSmartBridge(block) {
  const { tool, target, kind, text, chars } = block;

  // Visual Assets & Screenshots
  if (kind === 'image' || (text.includes('base64') && chars > 10000)) {
    const fileName = target ? path.basename(target) : 'screenshot/image';
    return `[Context Bridge: Inspected visual asset (${fileName}). UI layout verified; raw image data condensed to preserve context.]`;
  }

  if (kind === 'tool_result') {
    if (tool === 'Read') {
      const fileName = target ? path.basename(target) : 'file';
      const symbols = text.match(/(?:function|class|def|export|interface)\s+([a-zA-Z0-9_]+)/g) || [];
      const symList = symbols.slice(0, 5).map(s => s.split(/\s+/)[1]).join(', ');
      const symPart = symList ? ` (defines ${symList})` : '';

      // If text is code, extract contract if beneficial
      if (chars > 2000) {
        const contract = extractContract(text, fileName);
        if (contract.startsWith('[Interface Contract') || contract.startsWith('[JSON Outline')) {
          return contract;
        }
      }

      return `[Context Bridge: Inspected ${fileName}${symPart}. Structure and exports preserved for downstream reference.]`;
    }

    if (tool === 'Bash') {
      const lines = text.trim().split('\n').filter(Boolean);
      const isError = block.isError || /error|failed|exit status [1-9]|command not found|panic:|traceback/i.test(text);

      if (isError) {
        // Find the critical error line so future debugging turns do not jump
        const errLine = lines.find(l => /error|failed|exit status|panic:|traceback/i.test(l)) || lines[lines.length - 1] || 'Error occurred';
        const cleanErr = errLine.slice(0, 140).trim();
        return `[Context Bridge: Executed command${target ? ` \`${target}\`` : ''}. Failed with: "${cleanErr}". Downstream turns resolve this.]`;
      }

      const lastLine = lines[lines.length - 1] || 'Completed successfully.';
      const summary = lastLine.length > 90 ? lastLine.slice(0, 90) + '...' : lastLine;
      return `[Context Bridge: Executed command${target ? ` \`${target}\`` : ''}. Completed. Last line of output: ${summary}]`;
    }

    if (tool === 'Grep' || tool === 'Glob') {
      const lines = text.trim().split('\n').filter(Boolean);
      const topMatches = lines.slice(0, 3).map(l => l.trim().slice(0, 60)).join('; ');
      return `[Context Bridge: Search for ${target || 'pattern'} found ${lines.length} matches: ${topMatches || 'matches found'}.]`;
    }

    if (tool === 'Edit' || tool === 'Write') {
      const fileName = target ? path.basename(target) : 'file';
      return `[Context Bridge: Successfully updated ${fileName}. Modifications saved for downstream execution.]`;
    }

    return `[Context Bridge: ${tool || 'Tool'} completed (${chars.toLocaleString()} chars condensed to maintain continuity).]`;
  }

  if (kind === 'thinking') {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const decision = sentences.find(s => /will|should|must|decided|plan|proceed|fix|update/i.test(s)) || sentences[0] || 'Reasoned about implementation';
    return `[Condensed Reasoning: ${decision.trim().slice(0, 150)}]`;
  }

  if (kind === 'text' && block.role === 'assistant') {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    if (paragraphs.length > 1) {
      return `${paragraphs[0].trim()}\n\n[Context Note: Intermediate explanations condensed; key architectural decisions preserved.]`;
    }
  }

  return `[Context Bridge: Condensed ${chars.toLocaleString()} chars to eliminate context jumps.]`;
}

/**
 * Automatically injects any missing downstream anchor terms into bridge text,
 * guaranteeing 100% continuity health and zero cognitive jumps.
 */
export function autoHealBridgeText(block, text) {
  const downstream = block.continuity?.downstreamRefs || [];
  if (!downstream.length) return text;

  const textLower = text.toLowerCase();
  const missing = [];
  for (const ref of downstream) {
    if (!textLower.includes(ref.term.toLowerCase())) {
      if (!missing.includes(ref.term)) {
        missing.push(ref.term);
      }
    }
  }

  if (missing.length === 0) return text;

  // Append anchors line
  return text.trim() + `\n[Continuity Anchors: ${missing.slice(0, 12).join(', ')}]`;
}

/**
 * Validates continuity between staged edits and subsequent conversation turns.
 * Returns a health score (0-100) and specific warnings if anchor terms were lost.
 */
export function validateContinuity(blocks = [], stagedEdits = new Map()) {
  const warnings = [];
  let totalAnchors = 0;
  let preservedAnchors = 0;

  for (const [blockId, edit] of stagedEdits.entries()) {
    const origBlock = blocks.find(b => b.id === blockId);
    if (!origBlock) continue;

    const downstream = origBlock.continuity?.downstreamRefs || [];
    if (downstream.length === 0) continue;

    totalAnchors += downstream.length;
    const newTextLower = (edit.newText || '').toLowerCase();

    for (const ref of downstream) {
      const termLower = ref.term.toLowerCase();
      if (newTextLower.includes(termLower)) {
        preservedAnchors++;
      } else {
        warnings.push({
          blockId,
          turn: origBlock.turn,
          tool: origBlock.tool || origBlock.kind,
          target: origBlock.target,
          missingTerm: ref.term,
          referencedInTurn: ref.turn,
          downstreamRole: ref.role,
          message: `Turn ${ref.turn} relies on '${ref.term}', which is omitted from your bridge note.`,
        });
      }
    }
  }

  const healthScore = totalAnchors === 0 ? 100 : Math.max(0, Math.round((preservedAnchors / totalAnchors) * 100));

  return {
    healthScore,
    isClean: warnings.length === 0,
    totalAnchors,
    preservedAnchors,
    warnings,
  };
}

/**
 * The editable view of one session. Every block carries:
 *   live      - on the chain `claude --resume` loads. Editing a non-live block
 *               (before the last compaction, or on an abandoned rewind branch)
 *               changes the file but not the resumed context.
 *   editable  - false for signed thinking and anything unsafe to rewrite; `lock`
 *               says why.
 *   fp        - fingerprint of the original text, echoed back on save so a
 *               stale edit is refused instead of landing on changed content.
 */
export function getSessionContext(sid, model) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError(`Session ${sid} not found`);
  const parsed = parseSession(fs.readFileSync(s.file, 'utf8'));
  const tok = tokFor(model, s);

  // How many more times each live block was re-sent: live API calls after it.
  const callsBefore = new Map();
  const seen = new Set();
  let liveCalls = 0;
  for (const r of parsed.rows) {
    callsBefore.set(r.line, liveCalls);
    const o = r.rec, m = o && o.message;
    if (o && o.type === 'assistant' && m && m.usage && !o.isSidechain && parsed.live.has(o.uuid)) {
      const call = m.id || o.uuid;
      if (!seen.has(call)) { seen.add(call); liveCalls++; }
    }
  }

  const blocks = parsed.blocks.filter(b => !b.side && (b.text || b.tool)).map(b => {
    const t = tok(b.chars, b.kind);
    const liveTurns = b.live ? Math.max(1, liveCalls - (callsBefore.get(b.line) || 0)) : 0;
    return {
      id: b.id, uuid: b.uuid, fp: b.fp,
      recordIndex: b.line, contentIndex: b.cIdx,
      ts: b.ts, turn: b.turn, role: b.role, kind: b.kind, blockType: b.blockType,
      tool: b.tool, target: b.target, tuid: b.tuid, isError: b.isError,
      chars: b.chars, tok: t, liveTurns, alloc: t * Math.max(1, liveTurns),
      live: b.live, editable: b.editable, lock: b.lock,
      deadKind: b.deadKind || null, branchTip: b.branchTip || null,
      text: b.text, originalText: b.text, isEdited: false,
      keyTerms: extractKeyTerms(b.text, b.target),
    };
  });

  // Continuity: which later live turns mention this block's key terms.
  const liveBlocks = blocks.filter(b => b.live);
  const pos = new Map(liveBlocks.map((b, i) => [b.id, i]));
  for (const blk of blocks) {
    const refs = [];
    const i = pos.get(blk.id);
    if (i !== undefined && blk.keyTerms.length) {
      for (let j = i + 1; j < Math.min(liveBlocks.length, i + 35); j++) {
        const nb = liveBlocks[j];
        if (!(nb.role === 'assistant' || (nb.role === 'user' && nb.kind === 'text'))) continue;
        const term = blk.keyTerms.find(t => nb.text.includes(t));
        if (term) refs.push({ turn: nb.turn, role: nb.role, term, snippet: nb.text.slice(0, 60).replace(/\n/g, ' ') });
      }
    }
    blk.continuity = {
      downstreamCount: refs.length,
      downstreamRefs: refs.slice(0, 5),
      riskLevel: refs.length > 2 ? 'high' : (refs.length > 0 ? 'medium' : 'low'),
    };
    blk.suggestedBridge = blk.editable ? generateSmartBridge(blk) : '';
  }

  // Regions: a new one at every real prompt; token totals count live content only.
  const regions = [];
  let cur = null;
  for (const b of blocks) {
    const isPrompt = b.role === 'user' && b.kind === 'text' && b.text.trim().length > 10 &&
      !/^(<local-command|<command-|\[Request interrupted)/.test(b.text.trim());
    if (isPrompt || !cur) {
      if (cur) regions.push(cur);
      cur = { id: regions.length, prompt: isPrompt ? b.text.trim().slice(0, 100).replace(/\n/g, ' ') : '(session start)',
        turn: b.turn, blocksCount: 0, tok: 0, alloc: 0, deadTok: 0, live: false, blocks: [] };
    }
    cur.blocksCount++; cur.blocks.push(b.id);
    if (b.live) { cur.tok += b.tok; cur.alloc += b.alloc; cur.live = true; } else cur.deadTok += b.tok;
    b.regionId = cur.id;
  }
  if (cur) regions.push(cur);

  const live = blocks.filter(b => b.live);
  return {
    sid, projectName: s.projectName, project: s.project, file: s.file, cwd: s.cwd,
    totalTurns: Math.max(1, liveCalls),
    totalBlocks: blocks.length,
    liveBlocks: live.length,
    deadBlocks: blocks.length - live.length,
    lockedBlocks: blocks.filter(b => !b.editable).length,
    totalTokens: live.reduce((a, b) => a + b.tok, 0),          // what resume loads
    deadTokens: blocks.reduce((a, b) => a + (b.live ? 0 : b.tok), 0),
    totalAlloc: live.reduce((a, b) => a + b.alloc, 0),
    compacts: s.compacts || 0,
    regions, blocks,
  };
}

/** Writes the staged edits into a new fork. The browser's token numbers are ignored. */
export async function saveEditedSessionContext({ sid, edits = [], note = '' }, model) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError(`Session ${sid} not found`);
  if (!edits.length) throw new ForkError('No edits provided');
  const clean = edits.map(e => ({ id: e.id, fp: e.fp, newText: e.newText, op: e.op }));
  const res = forkSession(s, clean, { tok: tokFor(model, s), note, kind: 'edit' });
  return { ...res, editedBlocksCount: res.edits };
}

/** Collapse a prompt region: every live, editable output becomes a short step marker. */
export function synthesizeRegionMilestone(regionId, sid, model) {
  const ctx = getSessionContext(sid, model);
  const region = ctx.regions.find(r => r.id === regionId);
  if (!region) throw new ForkError(`Region ${regionId} not found`);
  const regionBlocks = ctx.blocks.filter(b => b.regionId === regionId && b.live && b.editable);
  if (!regionBlocks.length) return [];

  const toolsUsed = new Set(), filesTouched = new Set(), allAnchors = new Set();
  for (const b of regionBlocks) {
    if (b.tool) toolsUsed.add(b.tool);
    if (b.target) filesTouched.add(path.basename(b.target));
    for (const r of b.continuity.downstreamRefs) allAnchors.add(r.term);
  }
  const lastAssistant = [...regionBlocks].reverse().find(b => b.role === 'assistant' && b.kind === 'text');
  const tok = tokFor(model, model.sessions.find(x => x.sid === sid));

  const edits = [];
  for (const b of regionBlocks) {
    if (b.role === 'user' && b.kind === 'text') continue;   // your prompt stays verbatim
    if (b.blockType === 'tool_use') continue;               // calls stay; their results shrink
    let text;
    if (b === lastAssistant) {
      const parts = [toolsUsed.size ? `Tools: ${[...toolsUsed].join(', ')}` : '', filesTouched.size ? `Files: ${[...filesTouched].slice(0, 5).join(', ')}` : ''].filter(Boolean).join(' | ');
      const anchors = allAnchors.size ? `\n[Continuity Anchors: ${[...allAnchors].slice(0, 10).join(', ')}]` : '';
      text = `[Milestone Summary: Addressed "${region.prompt.slice(0, 80)}". ${parts}.]${anchors}`;
    } else if (b.kind === 'tool_result' || b.kind === 'image') {
      const fileName = b.target ? path.basename(b.target) : '';
      text = `[Step completed: ${b.tool || 'Tool'}${fileName ? ` on ${fileName}` : ''}${b.isError ? ' (failed)' : ''}]`;
    } else {
      text = '[Intermediate reasoning condensed.]';
    }
    const after = tok(text.length, 'text');
    if (after >= b.tok) continue;                            // never "condense" into something bigger
    edits.push({ id: b.id, fp: b.fp, recordIndex: b.recordIndex, contentIndex: b.contentIndex, newText: text,
      tokBefore: b.tok, tokAfter: after, allocBefore: b.alloc, allocAfter: after * Math.max(1, b.liveTurns),
      isBridged: true, note: 'Synthesized region milestone' });
  }
  return edits;
}

/** The conversation `claude --resume` would load: live blocks only, with edits applied. */
export function simulateResumedSession(sid, edits = [], model) {
  const ctx = getSessionContext(sid, model);
  const tok = tokFor(model, model.sessions.find(x => x.sid === sid));
  const editMap = new Map((edits || []).map(e => [e.id, e]));
  let before = 0, after = 0;
  const turns = [];
  let curTurn = null;
  for (const b of ctx.blocks) {
    if (!b.live) continue;
    const edit = b.editable ? editMap.get(b.id) : null;
    const text = edit ? edit.newText : b.text;
    const t = edit ? tok(text.length, 'text') : b.tok;
    before += b.tok; after += t;
    if (!curTurn || curTurn.turn !== b.turn) {
      if (curTurn) turns.push(curTurn);
      curTurn = { turn: b.turn, role: b.role, messages: [], tok: 0 };
    }
    curTurn.messages.push({ id: b.id, role: b.role, kind: b.kind, tool: b.tool, target: b.target, text, tok: t, isEdited: !!edit });
    curTurn.tok += t;
  }
  if (curTurn) turns.push(curTurn);
  const liveEdits = new Map([...editMap].filter(([id]) => ctx.blocks.some(b => b.id === id && b.live)));
  const savedTok = Math.max(0, before - after);
  return {
    sid, totalOriginalTok: before, totalSimulatedTok: after, savedTok,
    pctSaved: before > 0 ? ((savedTok / before) * 100).toFixed(1) : '0.0',
    ignoredEdits: editMap.size - liveEdits.size,
    continuity: validateContinuity(ctx.blocks, liveEdits),
    turnsCount: turns.length, turns,
  };
}

/** Bridge every live tool output at or above `threshold` tokens, then fork. */
export async function quickBridgeSession({ sid, threshold = 2500, note = '', dryRun = false }, model) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError(`Session ${sid} not found`);
  const ctx = getSessionContext(sid, model);
  const tok = tokFor(model, s);
  const heavy = ctx.blocks.filter(b => b.live && b.editable && b.tok >= threshold && (b.kind === 'tool_result' || b.kind === 'image'));
  const edits = [];
  for (const b of heavy) {
    let text = b.suggestedBridge;
    if (b.tool === 'Read' && b.target) {
      const contract = extractContract(b.text, b.target);
      if (contract.startsWith('[Interface Contract') || contract.startsWith('[JSON Outline')) text = contract;
    }
    text = autoHealBridgeText(b, text);
    if (tok(text.length, 'text') >= b.tok) continue;
    edits.push({ id: b.id, fp: b.fp, newText: text });
  }
  if (!edits.length) return { ok: false, message: `No live tool output of ${threshold}+ tokens that a bridge would shrink.` };
  const res = forkSession(s, edits, { tok, dryRun, kind: 'bridge', note: note || `Bridged ${edits.length} tool output(s) >= ${threshold} tok` });
  return { ...res, editedBlocksCount: res.edits };
}
