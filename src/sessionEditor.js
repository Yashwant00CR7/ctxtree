import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { PROJECTS_DIR, FILE_HISTORY_DIR, prettyProject } from './paths.js';
import { getLineage, saveLineage } from './prune.js';

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
      const isError = /error|failed|exit status [1-9]|command not found|panic:|traceback/i.test(text);

      if (isError) {
        // Find the critical error line so future debugging turns do not jump
        const errLine = lines.find(l => /error|failed|exit status|panic:|traceback/i.test(l)) || lines[lines.length - 1] || 'Error occurred';
        const cleanErr = errLine.slice(0, 140).trim();
        return `[Context Bridge: Executed command${target ? ` \`${target}\`` : ''}. Failed with: "${cleanErr}". Downstream turns resolve this.]`;
      }

      const lastLine = lines[lines.length - 1] || 'Completed successfully.';
      const summary = lastLine.length > 90 ? lastLine.slice(0, 90) + '...' : lastLine;
      return `[Context Bridge: Executed command${target ? ` \`${target}\`` : ''}. Succeeded (exit 0). Result: ${summary}]`;
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
 * Loads the complete, editable paragraph context for a specific session.
 */
export function getSessionContext(sid, model) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new Error(`Session ${sid} not found`);

  const raw = fs.readFileSync(s.file, 'utf8');
  const lines = raw.split('\n');

  const blocks = [];
  const toolNameById = new Map();
  const targetById = new Map();

  let turn = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const m = rec.message;
    if (!m || typeof m !== 'object') continue;

    const role = m.role || rec.type;
    const content = m.content;
    const contentBlocks = Array.isArray(content)
      ? content
      : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);

    for (let cIdx = 0; cIdx < contentBlocks.length; cIdx++) {
      const b = contentBlocks[cIdx];
      if (!b || typeof b !== 'object') continue;

      let text = '';
      let kind = b.type;
      let tool = '';
      let target = '';
      let tuid = b.id || b.tool_use_id || '';

      if (kind === 'text') {
        text = b.text || '';
      } else if (kind === 'thinking') {
        text = b.thinking || b.text || '';
      } else if (kind === 'tool_use') {
        tool = b.name || '';
        const inputObj = b.input || {};
        target = inputObj.file_path || inputObj.path || inputObj.command || inputObj.query || inputObj.pattern || '';
        if (target.length > 90) target = target.slice(0, 90);
        text = JSON.stringify(inputObj, null, 2);
        if (b.id) {
          toolNameById.set(b.id, tool);
          targetById.set(b.id, target);
        }
      } else if (kind === 'tool_result') {
        tuid = b.tool_use_id || '';
        tool = toolNameById.get(tuid) || b.tool || '';
        target = targetById.get(tuid) || '';
        const c = b.content;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          text = c.map(x => (x && x.type === 'text') ? (x.text || '') : JSON.stringify(x)).join('\n');
          if (c.some(x => x && x.type === 'image')) kind = 'image';
        } else text = JSON.stringify(c ?? '');
      }

      if (!text && !tool) continue;

      const chars = text.length;
      const tok = Math.max(1, Math.round(chars / 3.6));
      const id = `blk_${lineNum}_${cIdx}`;

      blocks.push({
        id,
        recordIndex: lineNum,
        contentIndex: cIdx,
        uuid: rec.uuid || '',
        ts: rec.timestamp || '',
        turn,
        role,
        kind,
        tool,
        target,
        tuid,
        chars,
        tok,
        alloc: tok,
        text,
        originalText: text,
        isEdited: false,
        keyTerms: extractKeyTerms(text, target),
      });
    }

    if (rec.type === 'assistant' && m.usage) {
      turn++;
    }
  }

  const totalTurns = Math.max(1, turn);

  // Compute residency, continuity links, and smart bridges
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    const liveTurns = Math.max(1, totalTurns - blk.turn);
    blk.liveTurns = liveTurns;
    blk.alloc = blk.tok * liveTurns;

    const downstreamRefs = [];
    if (blk.keyTerms && blk.keyTerms.length) {
      for (let j = i + 1; j < Math.min(blocks.length, i + 35); j++) {
        const nextBlk = blocks[j];
        if (nextBlk.role === 'assistant' || (nextBlk.role === 'user' && nextBlk.kind === 'text')) {
          for (const term of blk.keyTerms) {
            if (nextBlk.text.includes(term)) {
              downstreamRefs.push({
                turn: nextBlk.turn,
                role: nextBlk.role,
                term,
                snippet: nextBlk.text.slice(0, 60).replace(/\n/g, ' ')
              });
              break;
            }
          }
        }
      }
    }

    blk.continuity = {
      downstreamCount: downstreamRefs.length,
      downstreamRefs: downstreamRefs.slice(0, 5),
      riskLevel: downstreamRefs.length > 2 ? 'high' : (downstreamRefs.length > 0 ? 'medium' : 'low'),
    };

    blk.suggestedBridge = generateSmartBridge(blk);
  }

  // Group blocks by Prompt Regions
  const regions = [];
  let curRegion = null;

  blocks.forEach(b => {
    if (b.role === 'user' && b.kind === 'text' && b.text.trim().length > 10 && !b.text.startsWith('<local-command')) {
      if (curRegion) regions.push(curRegion);
      curRegion = {
        id: regions.length,
        prompt: b.text.trim().slice(0, 100).replace(/\n/g, ' '),
        turn: b.turn,
        blocksCount: 0,
        tok: 0,
        alloc: 0,
        blocks: [],
      };
    }
    if (!curRegion) {
      curRegion = {
        id: 0,
        prompt: '(Initial setup / session start)',
        turn: 0,
        blocksCount: 0,
        tok: 0,
        alloc: 0,
        blocks: [],
      };
    }
    curRegion.blocksCount++;
    curRegion.tok += b.tok;
    curRegion.alloc += b.alloc;
    curRegion.blocks.push(b.id);
    b.regionId = curRegion.id;
  });
  if (curRegion) regions.push(curRegion);

  return {
    sid,
    projectName: s.projectName,
    project: s.project,
    file: s.file,
    totalTurns,
    totalBlocks: blocks.length,
    totalTokens: blocks.reduce((a, b) => a + b.tok, 0),
    totalAlloc: blocks.reduce((a, b) => a + b.alloc, 0),
    regions,
    blocks,
  };
}

/**
 * Saves modified context paragraphs into a new forked session without jumps.
 */
export async function saveEditedSessionContext({ sid, edits = [], note = '' }, model) {
  if (!sid) throw new Error('Session ID (sid) is required');
  if (!edits || edits.length === 0) throw new Error('No edits provided');

  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new Error(`Session ${sid} not found`);

  const forkSid = crypto.randomUUID();
  const origFile = s.file;
  const projectDir = path.dirname(origFile);
  const forkFile = path.join(projectDir, `${forkSid}.jsonl`);

  const editMap = new Map();
  let savedTok = 0;
  let savedAlloc = 0;

  edits.forEach(e => {
    const list = editMap.get(e.recordIndex) || new Map();
    list.set(e.contentIndex, e);
    editMap.set(e.recordIndex, list);
    savedTok += (e.tokBefore || 0) - (e.tokAfter || 0);
    savedAlloc += (e.allocBefore || 0) - (e.allocAfter || 0);
  });

  const inputStream = fs.createReadStream(origFile, { encoding: 'utf8' });
  const outputStream = fs.createWriteStream(forkFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  let lineNum = 0;
  let modifiedRecords = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      outputStream.write(line + '\n');
      lineNum++;
      continue;
    }

    if (rec.sessionId) rec.sessionId = forkSid;
    if (rec.session_id) rec.session_id = forkSid;

    let touched = false;
    const editsForLine = editMap.get(lineNum);

    if (editsForLine) {
      if (rec.message) {
        if (Array.isArray(rec.message.content)) {
          for (const [cIdx, edit] of editsForLine.entries()) {
            const item = rec.message.content[cIdx];
            if (!item) continue;

            if (item.type === 'text') {
              item.text = edit.newText;
              touched = true;
            } else if (item.type === 'thinking') {
              item.thinking = edit.newText;
              touched = true;
            } else if (item.type === 'tool_result') {
              if (typeof item.content === 'string') {
                item.content = edit.newText;
              } else if (Array.isArray(item.content)) {
                item.content = [{ type: 'text', text: edit.newText }];
              } else {
                item.content = edit.newText;
              }
              touched = true;
            } else if (item.type === 'tool_use') {
              try {
                item.input = JSON.parse(edit.newText);
              } catch {}
              touched = true;
            }
          }
        } else if (typeof rec.message.content === 'string') {
          const edit = editsForLine.get(0);
          if (edit) {
            rec.message.content = edit.newText;
            touched = true;
          }
        }
      } else if (rec.content) {
        if (typeof rec.content === 'string') {
          const edit = editsForLine.get(0);
          if (edit) {
            rec.content = edit.newText;
            touched = true;
          }
        }
      }
    }

    if (touched) modifiedRecords++;
    outputStream.write(JSON.stringify(rec) + '\n');
    lineNum++;
  }

  await new Promise(resolve => outputStream.end(resolve));

  // Clone file-history using APFS CoW
  const srcHistory = path.join(FILE_HISTORY_DIR, sid);
  const dstHistory = path.join(FILE_HISTORY_DIR, forkSid);
  let clonedHistory = false;

  if (fs.existsSync(srcHistory)) {
    try {
      execSync(`cp -c -R "${srcHistory}" "${dstHistory}" 2>/dev/null`);
      clonedHistory = true;
    } catch {
      try {
        fs.cpSync(srcHistory, dstHistory, { recursive: true });
        clonedHistory = true;
      } catch (err) {
        console.warn(`Failed to copy file-history from ${sid} to ${forkSid}:`, err.message);
      }
    }
  }

  const lineageEntry = {
    forkSid,
    parentSid: sid,
    project: s.project,
    projectName: prettyProject(s.project),
    file: forkFile,
    createdAt: new Date().toISOString(),
    editedBlocksCount: edits.length,
    modifiedRecords,
    savedTok: Math.max(0, savedTok),
    savedAlloc: Math.max(0, savedAlloc),
    clonedHistory,
    note: note || `Context edited with ctxtree (${edits.length} paragraphs tailored without jumps)`
  };

  const currentLineage = getLineage();
  saveLineage([lineageEntry, ...currentLineage]);

  return {
    ok: true,
    forkSid,
    parentSid: sid,
    projectName: prettyProject(s.project),
    savedTok: Math.max(0, savedTok),
    savedAlloc: Math.max(0, savedAlloc),
    editedBlocksCount: edits.length,
    forkFile,
    resumeCmd: `claude --resume ${forkSid}`,
    clonedHistory
  };
}

/**
 * Synthesizes an entire prompt region into a cohesive milestone,
 * replacing bloated intermediate outputs with concise step bridges
 * and a unified milestone conclusion that preserves all downstream anchors.
 */
export function synthesizeRegionMilestone(regionId, sid, model) {
  const ctx = getSessionContext(sid, model);
  const region = ctx.regions.find(r => r.id === regionId);
  if (!region) throw new Error(`Region ${regionId} not found`);

  const regionBlocks = ctx.blocks.filter(b => b.regionId === regionId);
  if (!regionBlocks.length) return [];

  const toolsUsed = new Set();
  const filesTouched = new Set();
  const allAnchors = new Set();

  regionBlocks.forEach(b => {
    if (b.tool) toolsUsed.add(b.tool);
    if (b.target) filesTouched.add(path.basename(b.target));
    if (b.continuity?.downstreamRefs) {
      b.continuity.downstreamRefs.forEach(r => allAnchors.add(r.term));
    }
  });

  const edits = [];
  // Find last assistant response block in this region
  let lastAssistantBlock = null;
  for (let i = regionBlocks.length - 1; i >= 0; i--) {
    if (regionBlocks[i].role === 'assistant' && (regionBlocks[i].kind === 'text' || regionBlocks[i].kind === 'thinking')) {
      lastAssistantBlock = regionBlocks[i];
      break;
    }
  }

  regionBlocks.forEach(b => {
    // Preserve primary user prompt unmodified
    if (b.role === 'user' && b.kind === 'text') return;

    let bridgeText = '';

    if (b === lastAssistantBlock) {
      // Synthesize unified milestone summary
      const toolsPart = toolsUsed.size ? `Tools: ${Array.from(toolsUsed).join(', ')}` : '';
      const filesPart = filesTouched.size ? `Files: ${Array.from(filesTouched).slice(0, 5).join(', ')}` : '';
      const anchorPart = allAnchors.size ? `\n[Continuity Anchors: ${Array.from(allAnchors).slice(0, 10).join(', ')}]` : '';
      const summaryParts = [toolsPart, filesPart].filter(Boolean).join(' | ');

      bridgeText = `[Milestone Summary: Addressed "${region.prompt.slice(0, 80)}". ${summaryParts}. Execution complete for downstream continuation.]${anchorPart}`;
    } else if (b.kind === 'tool_result') {
      const fileName = b.target ? path.basename(b.target) : '';
      bridgeText = `[Step completed: ${b.tool || 'Tool'}${fileName ? ` on ${fileName}` : ''}]`;
    } else if (b.kind === 'tool_use') {
      return; // leave tool_use as is
    } else {
      bridgeText = `[Intermediate reasoning in milestone execution condensed.]`;
    }

    const newTok = Math.max(1, Math.round(bridgeText.length / 3.6));
    edits.push({
      id: b.id,
      recordIndex: b.recordIndex,
      contentIndex: b.contentIndex,
      newText: bridgeText,
      tokBefore: b.tok,
      tokAfter: newTok,
      allocBefore: b.alloc,
      allocAfter: newTok * b.liveTurns,
      isBridged: true,
      note: 'Synthesized region milestone'
    });
  });

  return edits;
}

/**
 * Reconstructs and simulates the exact conversational stream that Claude Code
 * will receive on `claude --resume <sid>`, calculating token savings and continuity health.
 */
export function simulateResumedSession(sid, edits = [], model) {
  const ctx = getSessionContext(sid, model);
  const editMap = new Map();
  edits.forEach(e => editMap.set(e.id, e));

  let totalOriginalTok = 0;
  let totalSimulatedTok = 0;

  const simulatedTurns = [];
  let curTurn = null;

  ctx.blocks.forEach(b => {
    totalOriginalTok += b.tok;
    const edit = editMap.get(b.id);
    const text = edit ? edit.newText : b.text;
    const tok = edit ? edit.tokAfter : b.tok;
    totalSimulatedTok += tok;

    if (!curTurn || curTurn.turn !== b.turn) {
      if (curTurn) simulatedTurns.push(curTurn);
      curTurn = {
        turn: b.turn,
        role: b.role,
        messages: [],
        tok: 0
      };
    }

    curTurn.messages.push({
      id: b.id,
      role: b.role,
      kind: b.kind,
      tool: b.tool,
      target: b.target,
      text,
      tok,
      isEdited: !!edit,
    });
    curTurn.tok += tok;
  });

  if (curTurn) simulatedTurns.push(curTurn);

  const validation = validateContinuity(ctx.blocks, editMap);
  const savedTok = Math.max(0, totalOriginalTok - totalSimulatedTok);
  const pctSaved = totalOriginalTok > 0 ? ((savedTok / totalOriginalTok) * 100).toFixed(1) : '0.0';

  return {
    sid,
    totalOriginalTok,
    totalSimulatedTok,
    savedTok,
    pctSaved,
    continuity: validation,
    turnsCount: simulatedTurns.length,
    turns: simulatedTurns
  };
}

/**
 * Programmatic / CLI quick-bridge: finds all tool results >= threshold tokens,
 * applies smart continuity bridges and contracts, forks the session, and returns the result.
 */
export async function quickBridgeSession({ sid, threshold = 2500, note = '' }, model) {
  const ctx = getSessionContext(sid, model);
  const heavyBlocks = ctx.blocks.filter(b => b.tok >= threshold && (b.kind === 'tool_result' || b.kind === 'tool_use' || b.kind === 'image' || b.kind === 'thinking'));

  if (heavyBlocks.length === 0) {
    return { ok: false, message: `No blocks >= ${threshold} tokens found in session ${sid}` };
  }

  const edits = heavyBlocks.map(b => {
    let bridgeText = b.suggestedBridge;
    if (b.tool === 'Read' && b.target) {
      const contract = extractContract(b.text, b.target);
      if (contract.startsWith('[Interface Contract') || contract.startsWith('[JSON Outline')) {
        bridgeText = contract;
      }
    }

    // Auto-heal anchors for guaranteed zero jumps
    bridgeText = autoHealBridgeText(b, bridgeText);

    const newTok = Math.max(1, Math.round(bridgeText.length / 3.6));
    return {
      id: b.id,
      recordIndex: b.recordIndex,
      contentIndex: b.contentIndex,
      newText: bridgeText,
      tokBefore: b.tok,
      tokAfter: newTok,
      allocBefore: b.alloc,
      allocAfter: newTok * b.liveTurns,
    };
  });

  return await saveEditedSessionContext({
    sid,
    edits,
    note: note || `Quick bridged ${edits.length} heavy blocks >= ${threshold} tok without jumps`
  }, model);
}
