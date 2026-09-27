import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { PROJECTS_DIR, FILE_HISTORY_DIR, prettyProject } from './paths.js';
import { getLineage, saveLineage } from './prune.js';

// Words to ignore in continuity checks (common keywords)
const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'were', 'will', 'then',
  'true', 'false', 'null', 'undefined', 'return', 'const', 'function', 'class',
  'import', 'export', 'require', 'type', 'string', 'number', 'boolean', 'void',
  'async', 'await', 'switch', 'case', 'break', 'default', 'continue', 'catch',
  'throw', 'error', 'interface', 'package', 'module', 'public', 'private',
  'node', 'bash', 'file', 'json', 'data', 'text', 'line', 'code', 'test'
]);

function extractKeyTerms(text, target = '') {
  const terms = new Set();
  if (target) {
    const base = target.split(/[/\\]/).pop();
    if (base && base.length >= 3) terms.add(base);
    const ext = path.extname(target);
    if (ext && ext.length >= 2) terms.add(ext);
  }

  // Find symbols like camelCase, PascalCase, snake_case, or paths
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

function generateSmartBridge(block) {
  const { tool, target, kind, text, chars } = block;

  if (kind === 'tool_result') {
    if (tool === 'Read') {
      const fileName = target ? path.basename(target) : 'file';
      const lines = text.split('\n');
      const symbols = text.match(/(?:function|class|def|export|interface)\s+([a-zA-Z0-9_]+)/g) || [];
      const symList = symbols.slice(0, 4).map(s => s.split(/\s+/)[1]).join(', ');
      const symPart = symList ? ` (defines ${symList})` : '';
      return `[Context Bridge: Inspected ${fileName}${symPart}. Structure and exports preserved for downstream reference.]`;
    }
    if (tool === 'Bash') {
      const firstLine = text.trim().split('\n')[0] || '';
      const summaryLine = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
      return `[Context Bridge: Executed command. Result summary: ${summaryLine || 'Command executed successfully.'}]`;
    }
    if (tool === 'Grep' || tool === 'Glob') {
      const lines = text.trim().split('\n').filter(Boolean);
      return `[Context Bridge: Search for ${target || 'pattern'} found ${lines.length} matches.]`;
    }
    if (tool === 'Edit' || tool === 'Write') {
      return `[Context Bridge: Successfully updated ${target ? path.basename(target) : 'file'}.]`;
    }
    return `[Context Bridge: ${tool || 'Tool'} completed successfully (${chars.toLocaleString()} chars condensed to maintain continuity).]`;
  }

  if (kind === 'thinking') {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const first = sentences[0] ? sentences[0].trim() : 'Reasoned about implementation';
    return `[Condensed Reasoning: ${first.slice(0, 120)}...]`;
  }

  if (kind === 'text' && block.role === 'assistant') {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    if (paragraphs.length > 1) {
      return `${paragraphs[0].trim()}\n\n[Context Note: Detailed discussion condensed for future turns.]`;
    }
  }

  return `[Context Bridge: Condensed ${chars.toLocaleString()} chars to eliminate context jumps.]`;
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
  let recordIdx = 0;

  // First pass: extract all blocks
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    recordIdx++;

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
        alloc: tok * 1, // updated below once total turns is known
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

  // Second pass: compute residency, continuity links, and smart bridges
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    const liveTurns = Math.max(1, totalTurns - blk.turn);
    blk.liveTurns = liveTurns;
    blk.alloc = blk.tok * liveTurns;

    // Analyze downstream continuity
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
        prompt: '(Initial setup / system)',
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

  // Build edit lookup maps: recordIndex -> { contentIndex -> edit }
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

    if (editsForLine && rec.message && Array.isArray(rec.message.content)) {
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
          item.content = edit.newText;
          touched = true;
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

  // Save to lineage manifest
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
    note: note || `Context edited with ctxtree (${edits.length} paragraphs tailored)`
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
