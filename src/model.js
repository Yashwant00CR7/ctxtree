import { scanAll } from './scan.js';
import { calibrate, tokensOf, fitSession, saveCalibration } from './tokens.js';
import { PROJECTS_DIR, prettyProject } from './paths.js';

// Turns a raw scan into the analysed model the UI renders:
// every chunk carries tok (its own size) and alloc (size x turns resident),
// scaled per session so the session total matches its MEASURED peak.
export function build(root = PROJECTS_DIR) {
  const t0 = Date.now();
  const scan = scanAll(root);
  const cal = calibrate(scan.samples);
  saveCalibration(cal);

  const sessions = [];
  let totalTok = 0, totalAlloc = 0, totalChunks = 0;

  for (const s of scan.sessions) {
    const v = scan.byId.get(s.sid);
    const fit = fitSession(s, v.chunks, cal);
    const scale = fit.scale;

    let tok = 0, rawAlloc = 0, bootTok = 0, subTok = 0;
    for (const c of v.chunks) {
      c.tok = Math.max(0, Math.round(tokensOf(c.chars, c.kind, cal) * (c.kind === 'image' ? 1 : scale)));
      c.alloc = c.tok * Math.max(1, c.live || 1);
      if (c.cat === 'subcontext') { subTok += c.tok; continue; }
      if (c.side) continue;
      tok += c.tok; rawAlloc += c.alloc;
      if (c.cat === 'boot') bootTok += c.tok;
    }
    // Allocated has ground truth too: summing every turn's input is exactly the
    // tokens that were actually shipped. Scale to it so the column is measured,
    // not modelled -- only the split between nodes is estimated.
    const aScale = (s.shipped > 0 && rawAlloc > 0) ? s.shipped / rawAlloc : 1;
    let alloc = 0;
    for (const c of v.chunks) {
      if (c.cat === 'subcontext' || c.side) continue;
      c.alloc = Math.round(c.alloc * aScale);
      alloc += c.alloc;
    }
    // Thinking is charged but its text is stripped from transcripts; the only
    // honest source is the measured thinking_tokens in usage.
    if (s.thinkTokens > 0) {
      v.chunks.push({ i: 0, turn: 0, kind: 'thinking', cat: 'conversation', sub: 'thinking',
        leaf: '', role: 'assistant', tool: '', target: '', tuid: '', chars: 0,
        tok: s.thinkTokens, alloc: s.thinkTokens, live: 1, measured: 1, exact: true,
        fp: `think.${s.sid}`, uuid: '', ts: s.firstTs, side: 0 });
      tok += s.thinkTokens; alloc += s.thinkTokens;
    }

    const rec = {
      ...s, fit, scale, aScale, tok, alloc, bootTok, subTok,
      projectName: prettyProject(s.project),
      nSub: s.agents.length,
      subAlloc: s.agents.reduce((a, g) => a + (g.shipped || g.peak), 0),
    };
    sessions.push(rec);
    totalTok += tok; totalAlloc += alloc; totalChunks += v.chunks.length;
  }

  sessions.sort((a, b) => b.alloc - a.alloc);
  return {
    root, cal, sessions, byId: scan.byId,
    stats: {
      nSessions: sessions.length,
      nFiles: scan.nFiles,
      nChunks: totalChunks,
      nSub: sessions.reduce((a, s) => a + s.nSub, 0),
      tok: totalTok, alloc: totalAlloc,
      subTok: sessions.reduce((a, s) => a + s.subTok, 0),
      compacts: sessions.reduce((a, s) => a + s.compacts, 0),
      peakMax: sessions.reduce((a, s) => Math.max(a, s.peak), 0),
      shipped: sessions.reduce((a, s) => a + (s.shipped || 0), 0),
      subShipped: sessions.reduce((a, s) => a + s.subAlloc, 0),
      scanMs: scan.ms, buildMs: Date.now() - t0,
      good: sessions.filter(s => s.fit.quality === 'good').length,
      coarse: sessions.filter(s => s.fit.quality === 'coarse').length,
    },
  };
}
