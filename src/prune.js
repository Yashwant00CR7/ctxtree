import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { CTXTREE_DIR, LINEAGE_FILE, FILE_HISTORY_DIR, prettyProject } from './paths.js';

export function getLineage() {
  if (!fs.existsSync(LINEAGE_FILE)) return [];
  try {
    const lines = fs.readFileSync(LINEAGE_FILE, 'utf8').trim().split('\n');
    return lines
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .map(f => ({
        ...f,
        exists: f.file ? fs.existsSync(f.file) : false
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (e) {
    console.error('Error reading lineage file:', e);
    return [];
  }
}

function appendLineage(entry) {
  if (!fs.existsSync(CTXTREE_DIR)) {
    fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  }
  fs.appendFileSync(LINEAGE_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

export function saveLineage(entries) {
  if (!fs.existsSync(CTXTREE_DIR)) {
    fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  }
  const body = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(LINEAGE_FILE, body, 'utf8');
}

/**
 * Prune specified tool results from a session and fork into a new session UUID.
 *
 * @param {Object} options
 * @param {string} options.sid Parent session UUID
 * @param {Array<string>} options.tuids Tool use IDs to tombstone
 * @param {string} [options.note] Optional note / reason for pruning
 * @param {Object} model Pre-built ctxtree model (from build())
 * @returns {Promise<Object>} Result containing new forkSid, tokens saved, resume command
 */
export async function pruneSession({ sid, tuids = [], note = '' }, model) {
  if (!sid) throw new Error('Session ID (sid) is required');
  if (!tuids || tuids.length === 0) throw new Error('At least one tuid is required to prune');

  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new Error(`Session ${sid} not found in model`);

  const v = model.byId.get(sid);
  if (!v) throw new Error(`Session data for ${sid} not found`);

  const targetSet = new Set(tuids);
  let savedTok = 0;
  let savedAlloc = 0;
  const prunedChunks = [];

  for (const c of v.chunks) {
    if (c.tuid && targetSet.has(c.tuid)) {
      savedTok += c.tok || 0;
      savedAlloc += c.alloc || 0;
      prunedChunks.push(c);
    }
  }

  const forkSid = crypto.randomUUID();
  const origFile = s.file;
  const projectDir = path.dirname(origFile);
  const forkFile = path.join(projectDir, `${forkSid}.jsonl`);

  // Read original line by line and stream modified records into forkFile
  const inputStream = fs.createReadStream(origFile, { encoding: 'utf8' });
  const outputStream = fs.createWriteStream(forkFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  let modifiedRecords = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Preserve invalid or unparseable lines as-is
      outputStream.write(line + '\n');
      continue;
    }

    // Update session ID references
    if (rec.sessionId) rec.sessionId = forkSid;
    if (rec.session_id) rec.session_id = forkSid;

    let touched = false;

    // Check message content for tool_result matching target tuids
    const msg = rec.message;
    if (msg && Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item && item.type === 'tool_result' && item.tool_use_id && targetSet.has(item.tool_use_id)) {
          const matchChunk = prunedChunks.find(c => c.tuid === item.tool_use_id);
          const tokLabel = matchChunk && matchChunk.tok ? `${matchChunk.tok.toLocaleString()} tokens` : 'content';
          const toolLabel = matchChunk && matchChunk.tool ? ` (${matchChunk.tool})` : '';
          item.content = `[ctxtree: pruned ${tokLabel}${toolLabel} to reclaim context]`;
          touched = true;
        }
      }
    }

    // Also check root toolUseResult if present
    if (rec.toolUseResult && rec.tool_use_id && targetSet.has(rec.tool_use_id)) {
      rec.toolUseResult = '[ctxtree: pruned]';
      touched = true;
    }

    if (touched) modifiedRecords++;
    outputStream.write(JSON.stringify(rec) + '\n');
  }

  await new Promise(resolve => outputStream.end(resolve));

  // Clone file-history directory if it exists
  const srcHistory = path.join(FILE_HISTORY_DIR, sid);
  const dstHistory = path.join(FILE_HISTORY_DIR, forkSid);
  let clonedHistory = false;

  if (fs.existsSync(srcHistory)) {
    try {
      // Try APFS clone (fast CoW)
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

  // Record lineage
  const lineageEntry = {
    forkSid,
    parentSid: sid,
    project: s.project,
    projectName: prettyProject(s.project),
    file: forkFile,
    createdAt: new Date().toISOString(),
    tuids: Array.from(targetSet),
    modifiedRecords,
    savedTok,
    savedAlloc,
    clonedHistory,
    note: note || `Pruned ${targetSet.size} tool result(s)`
  };

  appendLineage(lineageEntry);

  return {
    ok: true,
    forkSid,
    parentSid: sid,
    project: s.project,
    projectName: prettyProject(s.project),
    savedTok,
    savedAlloc,
    modifiedRecords,
    forkFile,
    resumeCmd: `claude --resume ${forkSid}`,
    clonedHistory
  };
}

/**
 * Reverts / removes a created fork.
 */
export function revertFork(forkSid) {
  const entries = getLineage();
  const target = entries.find(e => e.forkSid === forkSid);
  if (!target) throw new Error(`Fork ${forkSid} not found in lineage`);

  // Remove fork jsonl file
  if (target.file && fs.existsSync(target.file)) {
    fs.unlinkSync(target.file);
  }

  // Remove cloned file history if exists
  const hist = path.join(FILE_HISTORY_DIR, forkSid);
  if (fs.existsSync(hist)) {
    fs.rmSync(hist, { recursive: true, force: true });
  }

  // Filter out of lineage
  const remaining = entries.filter(e => e.forkSid !== forkSid);
  saveLineage(remaining);

  return { ok: true, removed: forkSid };
}
