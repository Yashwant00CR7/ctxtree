// The only code in the web server that writes session data: the Node half of
// the fork writer. The fork itself is built and verified in memory by the
// shared core (plugins/ctxtree/core/fork.js, which the Claude Code mod also
// runs); this module reads the parent, writes the result to a hidden temp file,
// reads it back, and only then renames it into place -- so a half-written or
// malformed fork never shows up in `claude --resume`. Boot removals that Claude
// Code would otherwise re-announce come with a launch profile (a --settings
// overlay) that the resume command passes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECTS_DIR, FILE_HISTORY_DIR, CTXTREE_DIR, LINEAGE_FILE, PROFILES_DIR, prettyProject } from './paths.js';
import { UUID_RE } from './session.js';
import { ForkError } from './fork-error.js';
import { tombstoneText, shrinkInput, SHRINK_MIN, resolveEdits } from '../plugins/ctxtree/core/edits.js';
import { buildFork, verifyFork, applyStructure, verifyStructure, resumeCommand, makeFork, forkNote } from '../plugins/ctxtree/core/fork.js';

export { ForkError, tombstoneText, shrinkInput, SHRINK_MIN, resolveEdits, buildFork, verifyFork, applyStructure, verifyStructure, resumeCommand, forkNote };

function cloneHistory(parentSid, forkSid) {
  const src = path.join(FILE_HISTORY_DIR, parentSid);
  const dst = path.join(FILE_HISTORY_DIR, forkSid);
  if (!fs.existsSync(src)) return 'none';
  try { execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'ignore' }); return 'cloned'; }
  catch {
    try { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); return 'copied'; }
    catch { return 'failed'; }
  }
}

// ---------------------------------------------------------------- lineage
export function readLineage() {
  let raw = '';
  try { raw = fs.readFileSync(LINEAGE_FILE, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function writeLineage(entries) {
  fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  const tmp = `${LINEAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  fs.renameSync(tmp, LINEAGE_FILE);
}
function appendLineage(entry) {
  fs.mkdirSync(CTXTREE_DIR, { recursive: true });
  fs.appendFileSync(LINEAGE_FILE, JSON.stringify(entry) + '\n');
}

// A fork that has grown since it was written has been resumed and used.
export function forkStatus(entry) {
  const exists = !!entry.file && fs.existsSync(entry.file);
  const size = exists ? fs.statSync(entry.file).size : 0;
  const grown = exists && (entry.bytes == null ? null : size !== entry.bytes);
  return { exists, size, grown };
}

export function listForks() {
  return readLineage()
    .map(e => ({ ...e, ...forkStatus(e), resumeCmd: resumeCommand({ forkSid: e.forkSid, cwd: e.cwd, profile: e.profileFile && fs.existsSync(e.profileFile) ? e.profileFile : null }) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ------------------------------------------------------------------- fork
export const profilePath = (forkSid) => path.join(PROFILES_DIR, `${forkSid}.json`);

/**
 * @param session  { sid, file, project, cwd }
 * @param edits    [{ id, fp?, newText?, op?: 'tombstone' | 'shrink' | 'remove' }]   message-block edits
 * @param opts.boot       boot item ids to remove (see boot.js bootInventory)
 * @param opts.structure  [{ op: 'drop', recs } | { op: 'uncompact' } | { op: 'switch', tip } | { op: 'slim' }]
 * @param opts.tok (chars, kind) => tokens   estimate used for reporting only
 * @param opts.dryRun  build and verify, write nothing
 */
export function forkSession(session, edits, { tok = (c) => Math.round(c / 3.6), note = '', kind = 'edit', dryRun = false, boot = [], structure = [] } = {}) {
  const parentSid = session.sid;
  if (!UUID_RE.test(parentSid || '')) throw new ForkError('Invalid session id.');
  const file = path.resolve(session.file);
  if (!file.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || path.basename(file) !== `${parentSid}.jsonl`)
    throw new ForkError('Session file is outside ~/.claude/projects.');

  const raw = fs.readFileSync(file, 'utf8');       // one consistent snapshot, even if the session is live
  const forkSid = crypto.randomUUID();
  const { content, profile, report } = makeFork(raw, { parentSid, forkSid, edits, boot, structure, tok });

  const dir = path.dirname(file);
  const forkFile = path.join(dir, `${forkSid}.jsonl`);
  const profileFile = profile ? profilePath(forkSid) : null;
  const result = {
    ok: true, dryRun, forkSid, parentSid,
    project: session.project, projectName: prettyProject(session.project || ''),
    cwd: session.cwd || '', forkFile,
    ...report,
    profile, profileFile,
    bytes: { before: Buffer.byteLength(raw), after: Buffer.byteLength(content) },
    savedTok: Math.max(0, report.resume.saved),
    resumeCmd: resumeCommand({ forkSid, cwd: session.cwd || '', profile: profileFile }),
  };
  if (dryRun) return result;

  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(dir, `.${forkSid}.jsonl.ctxtree-tmp`);   // hidden, not *.jsonl: never listed by Claude Code
  try {
    if (profile) {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
      fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const fd = fs.openSync(tmp, 'wx', mode);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.readFileSync(tmp, 'utf8') !== content) throw new ForkError('Read-back mismatch; nothing was written.');
    if (fs.existsSync(forkFile)) throw new ForkError('Fork target already exists.');
    fs.renameSync(tmp, forkFile);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (profileFile) try { fs.rmSync(profileFile, { force: true }); } catch { /* best effort */ }
    throw err;
  }

  result.history = cloneHistory(parentSid, forkSid);
  const stat = fs.statSync(forkFile);
  appendLineage({
    forkSid, parentSid, kind, project: session.project, projectName: result.projectName,
    cwd: result.cwd, file: forkFile, createdAt: new Date().toISOString(),
    bytes: stat.size, edits: result.edits, deadEdits: result.deadEdits, modifiedRecords: result.modifiedRecords, blocks: result.blocks,
    boot: result.boot, structure: result.structure, profileFile,
    resume: result.resume, savedTok: result.savedTok, history: result.history,
    note: note || forkNote(result, kind),
  });
  return result;
}

// ----------------------------------------------------------------- revert
export function revertFork(forkSid, { force = false } = {}) {
  if (!UUID_RE.test(forkSid || '')) throw new ForkError('Invalid fork id.');
  const entries = readLineage();
  const entry = entries.find(e => e.forkSid === forkSid);
  if (!entry) throw new ForkError('Not a ctxtree fork; refusing to delete it.');

  const file = entry.file ? path.resolve(entry.file) : '';
  if (file && (!file.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || path.basename(file) !== `${forkSid}.jsonl`))
    throw new ForkError('Lineage entry points outside ~/.claude/projects; refusing.');

  const st = forkStatus(entry);
  if (st.exists && st.grown !== false && !force) {
    throw new ForkError(st.grown === null
      ? 'This fork predates size tracking, so ctxtree cannot prove you have not continued it. Revert with force to delete it anyway.'
      : 'This fork has grown since it was created: you resumed it and kept working. Reverting would delete that conversation. Revert with force to delete it anyway.');
  }

  const removed = [];
  if (st.exists) { fs.unlinkSync(file); removed.push(file); }
  const hist = path.join(FILE_HISTORY_DIR, forkSid);
  if (fs.existsSync(hist)) { fs.rmSync(hist, { recursive: true, force: true }); removed.push(hist); }
  const prof = profilePath(forkSid);
  if (fs.existsSync(prof)) { fs.unlinkSync(prof); removed.push(prof); }
  if (force && file) {
    const sub = path.join(path.dirname(file), forkSid);   // subagent runs made after resuming
    if (fs.existsSync(sub)) { fs.rmSync(sub, { recursive: true, force: true }); removed.push(sub); }
  }
  writeLineage(entries.filter(e => e.forkSid !== forkSid));
  return { ok: true, removed: forkSid, paths: removed };
}
