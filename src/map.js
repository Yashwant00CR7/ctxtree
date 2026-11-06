// The context map for a session on disk. The map itself is built by the shared
// core (plugins/ctxtree/core/map.js), which the Claude Code mod also runs over
// the live conversation; this module reads the transcript and anchors tokens.
import fs from 'node:fs';
import { parseSession } from './session.js';
import { tokFor } from './model.js';
import { ForkError } from './fork-error.js';
import { listForks } from './fork.js';
import { buildMap, previewBlock, taskTimeline, anchorScale, sessionTitle } from '../plugins/ctxtree/core/map.js';

export { sessionTitle };

// Parsing a large session takes a moment; the map and the preview of a block
// read the same file, so keep the last few parses keyed by size + mtime.
const cache = new Map();
function parsedFor(s) {
  const st = fs.statSync(s.file);
  const hit = cache.get(s.sid);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.parsed;
  const parsed = parseSession(fs.readFileSync(s.file, 'utf8'));
  cache.set(s.sid, { size: st.size, mtimeMs: st.mtimeMs, parsed });
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return parsed;
}

function load(model, sid) {
  const s = model.sessions.find(x => x.sid === sid);
  if (!s) throw new ForkError('Session not found.');
  const parsed = parsedFor(s);
  return { s, parsed, tok: anchoredTok(model, s, parsed) };
}

// A ctxtree fork nobody has continued still carries its parent's numbers, so it
// borrows the parent's anchor (see anchorScale in the core).
const anchors = new WeakMap();
export function anchoredTok(model, s, parsed = parsedFor(s)) {
  let a = anchors.get(parsed);
  if (a === undefined) {
    a = null;
    const fork = listForks().find(f => f.forkSid === s.sid);
    const parent = fork && fork.grown === false && model.sessions.find(x => x.sid === fork.parentSid);
    if (parent && fs.existsSync(parent.file)) a = anchorScale(model.cal, parsedFor(parent));
    else if (!fork || fork.grown !== false) a = anchorScale(model.cal, parsed);
    if (a && parent) a = { ...a, measured: 0 };
    anchors.set(parsed, a);
  }
  if (!a) return tokFor(model, s);
  const { scale, raw } = a;
  const fn = (chars, kind) => (kind === 'image' ? Math.round(raw(0, 'image')) : Math.max(1, Math.round(raw(chars, kind) * scale)));
  fn.measured = a.measured;
  return fn;
}

// The last map built per model and parse: the timeline reads the same tree the UI shows.
const maps = new WeakMap();
const mapsOf = (model) => { let m = maps.get(model); if (!m) { m = new WeakMap(); maps.set(model, m); } return m; };
export function contextMap(model, sid, opts = {}) {
  const { s, parsed, tok } = load(model, sid);
  const hit = !opts.tok && mapsOf(model).get(parsed);
  if (hit) return hit;
  const map = buildMap(parsed, {
    tok: opts.tok || tok, sid, cwd: s.cwd || '', title: sessionTitle(s), project: s.projectName,
    bytes: fs.statSync(s.file).size,
  });
  if (!opts.tok) mapsOf(model).set(parsed, map);
  return map;
}

// What a block says, for the inspector: a slice of it (`offset`, `limit`).
export function blockPreview(model, sid, id, opts) {
  const { parsed, tok } = load(model, sid);
  return previewBlock(parsed, tok, id, opts);
}

// A task as it happened: its messages in full (up to the preview size) and
// one entry per tool call.
export function timeline(model, sid, id) {
  const { parsed } = load(model, sid);
  return { id, entries: taskTimeline(parsed, contextMap(model, sid).tasks, id) };
}
