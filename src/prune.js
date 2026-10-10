// Tombstoning is one kind of edit: the result body is replaced by a marker that
// names what was there, while its tool_use / tool_result pairing stays intact.
// All writing goes through fork.js.
import fs from 'node:fs';
import { parseSession } from './session.js';
import { forkSession, listForks, revertFork as revert, ForkError } from './fork.js';
import { tokFor } from './model.js';

export const getLineage = () => listForks();

export async function pruneSession({ sid, tuids = [], note = '' }, model) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError('Session not found.');
  if (!tuids.length) throw new ForkError('Nothing selected to tombstone.');

  const parsed = parseSession(fs.readFileSync(s.file, 'utf8'));
  const want = new Set(tuids);
  const edits = [];
  for (const b of parsed.blocks) {
    if (b.blockType === 'tool_result' && want.has(b.tuid)) { edits.push({ id: b.id, fp: b.fp, op: 'tombstone' }); want.delete(b.tuid); }
  }
  if (want.size) throw new ForkError(`${want.size} selected result(s) are not in this session.`, [...want].map(t => ({ id: t, error: 'tool_use_id not found' })));
  return forkSession(s, edits, { tok: tokFor(model, s), note, kind: 'prune' });
}

export const revertFork = (forkSid, opts) => revert(forkSid, opts);
