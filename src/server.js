import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ForkError } from './fork.js';
import { UUID_RE } from './session.js';
import { build } from './model.js';
import { buildTree, projectBreakdown } from './tree.js';
import { buildRegions } from './regions.js';
import { findings } from './findings.js';
import { pruneSession, getLineage, revertFork } from './prune.js';
import { bootView, structureView, nodePlan, applySurgery } from './surgery.js';
import { contextMap, blockPreview, sessionTitle } from './map.js';
import {
  getSessionContext,
  saveEditedSessionContext,
  extractContract,
  validateContinuity,
  autoHealBridgeText,
  synthesizeRegionMilestone,
  simulateResumedSession
} from './sessionEditor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, '../ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class CtxServer {
  constructor(options = {}) {
    this.port = options.port || 3888;
    this.host = '127.0.0.1';
    // Every API call must carry this. It is only ever handed to a page served by
    // this process, so another website -- or a LAN host -- cannot drive the API.
    this.token = crypto.randomBytes(24).toString('hex');
    this.model = null;
    this.cachedFindings = null;
    this.server = null;
  }

  ensureModel(force = false) {
    if (!this.model || force) {
      console.log('Building ctxtree model...');
      const t0 = Date.now();
      this.model = build();
      this.cachedFindings = findings(this.model);   // rebuilt with every model
      console.log(`Model ready in ${Date.now() - t0}ms (${this.model.sessions.length} sessions, ${(this.model.stats.alloc / 1e6).toFixed(1)}M alloc tokens)`);
    }
    return this.model;
  }

  start() {
    this.ensureModel();

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handle(req, res);
        } catch (err) {
          console.error('Unhandled request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${this.port} is busy, trying ${this.port + 1}...`);
          this.port++;
          this.server.listen(this.port, this.host);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        resolve({ port: this.port, url: `http://localhost:${this.port}` });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }

  // Only this machine, only through a name that resolves here. Checking Host
  // defeats DNS rebinding; checking Origin + token defeats cross-site requests.
  allowedHost(host) {
    return [`localhost:${this.port}`, `127.0.0.1:${this.port}`, `[::1]:${this.port}`].includes(String(host || '').toLowerCase());
  }

  async handle(req, res) {
    const security = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    const deny = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/plain', ...security }); res.end(msg); };

    if (!this.allowedHost(req.headers.host)) return deny(421, 'ctxtree only answers on localhost.');

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    const sendJson = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...security });
      res.end(JSON.stringify(data));
    };
    const sendError = (err) => {
      if (err instanceof ForkError) return sendJson({ error: err.message, problems: err.problems || [] }, 400);
      console.error(err);
      return sendJson({ error: err.message || 'Internal error' }, 500);
    };

    const MAX_BODY = 32 * 1024 * 1024;
    const readBody = () => new Promise((resolve, reject) => {
      const parts = []; let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(new ForkError('Request body too large.')); req.destroy(); return; }
        parts.push(chunk);
      });
      req.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { reject(new ForkError('Invalid JSON body')); }
      });
      req.on('error', reject);
    });

    // No CORS, ever: preflights are refused, so cross-origin writes cannot start.
    if (method === 'OPTIONS') return deny(405, 'Not allowed');

    if (pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && !this.allowedHost(origin.replace(/^https?:\/\//, ''))) return deny(403, 'Cross-origin request refused.');
      const token = String(req.headers['x-ctxtree-token'] || '');
      const ok = token.length === this.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
      if (!ok) return deny(403, 'Missing or invalid ctxtree token. Reload the page.');
      if (method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json'))
        return deny(415, 'Expected application/json');
      const sidParam = parsedUrl.searchParams.get('sid');
      if (sidParam && sidParam !== 'all' && !UUID_RE.test(sidParam)) return sendJson({ error: 'Invalid sid' }, 400);
      try {
        return await this.handleApi(req, res, { parsedUrl, pathname, method, sendJson, sendError, readBody });
      } catch (err) { return sendError(err); }
    }

    return this.serveStatic(pathname, res, security);
  }

  async handleApi(req, res, { parsedUrl, pathname, method, sendJson, sendError, readBody }) {
    {
      const model = this.ensureModel();

      if (pathname === '/api/stats' && method === 'GET') {
        return sendJson({
          stats: model.stats,
          cal: model.cal,
          sessionsCount: model.sessions.length,
        });
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        const list = model.sessions.map(s => ({
          sid: s.sid,
          project: s.project,
          projectName: s.projectName,
          turns: s.turns,
          tok: s.tok,
          alloc: s.alloc,
          bootTok: s.bootTok,
          subTok: s.subTok,
          subAlloc: s.subAlloc,
          compacts: s.compacts,
          peak: s.peak,
          fit: s.fit,
          firstTs: s.firstTs,
          lastTs: s.lastTs,
          cwd: s.cwd,
          title: sessionTitle(s),
          bytes: s.bytes,
        }));
        return sendJson(list);
      }

      if (pathname === '/api/session' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid) return sendJson({ error: 'Missing sid' }, 400);

        const s = model.sessions.find(x => x.sid === sid);
        if (!s) return sendJson({ error: 'Session not found' }, 404);

        const v = model.byId.get(sid);
        const chunks = v ? v.chunks : [];
        const tree = buildTree([chunks], { label: `session ${sid.slice(0, 8)}` });
        const regs = buildRegions(s, chunks);

        return sendJson({
          session: s,
          tree,
          regions: regs,
          chunksCount: chunks.length,
        });
      }

      if (pathname === '/api/tree' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        let tree;
        if (sid && sid !== 'all') {
          const v = model.byId.get(sid);
          if (!v) return sendJson({ error: 'Session not found' }, 404);
          tree = buildTree([v.chunks], { label: `session ${sid.slice(0, 8)}` });
        } else {
          // Global tree
          const allSets = model.sessions.map(s => model.byId.get(s.sid)?.chunks || []);
          tree = buildTree(allSets, { label: 'all sessions' });
        }
        return sendJson(tree);
      }

      if (pathname === '/api/regions' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid) return sendJson({ error: 'Missing sid' }, 400);
        const s = model.sessions.find(x => x.sid === sid);
        if (!s) return sendJson({ error: 'Session not found' }, 404);
        const v = model.byId.get(sid);
        const regs = buildRegions(s, v ? v.chunks : []);
        return sendJson(regs);
      }

      if (pathname === '/api/chunks' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        let chunks = [];
        if (sid && sid !== 'all') {
          const v = model.byId.get(sid);
          if (!v) return sendJson({ error: 'Session not found' }, 404);
          chunks = v.chunks.filter(c => !c.side);
        } else {
          // Global top chunks for treemap (cap to 500 largest to keep DOM fast)
          const all = [];
          for (const s of model.sessions) {
            const v = model.byId.get(s.sid);
            if (!v) continue;
            for (const c of v.chunks) {
              if (!c.side) all.push({ ...c, sid: s.sid, project: s.projectName });
            }
          }
          all.sort((a, b) => b.alloc - a.alloc);
          chunks = all.slice(0, 500);
        }

        // Return lightweight chunk representation for visualization
        const light = chunks.map((c, idx) => ({
          id: idx,
          i: c.i,
          turn: c.turn,
          kind: c.kind,
          cat: c.cat,
          sub: c.sub,
          leaf: c.leaf,
          tok: c.tok,
          alloc: c.alloc,
          live: c.live,
          tool: c.tool,
          target: c.target,
          tuid: c.tuid,
          role: c.role,
          fp: c.fp,
          sid: c.sid,
          project: c.project,
        }));
        return sendJson(light);
      }

      if (pathname === '/api/findings' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        let f = this.cachedFindings;
        if (!f) {
          f = findings(model);
          this.cachedFindings = f;
        }

        if (sid && sid !== 'all') {
          const prov = f.proven.filter(p => !p.sid || p.sid === sid);
          const inf = f.inferred.filter(p => !p.sid || p.sid === sid);
          return sendJson({
            proven: prov,
            inferred: inf,
            provenTotal: prov.reduce((a, b) => a + b.saves, 0),
            inferredTotal: inf.reduce((a, b) => a + b.saves, 0),
          });
        }
        return sendJson(f);
      }

      if (pathname === '/api/forks' && method === 'GET') {
        return sendJson(getLineage());
      }

      if (pathname === '/api/prune' && method === 'POST') {
        const body = await readBody();
        const { sid, tuids, note } = body;
        if (!sid || !tuids || !tuids.length) {
          return sendJson({ error: 'sid and tuids are required' }, 400);
        }

        const resData = await pruneSession({ sid, tuids, note }, model);
        this.ensureModel(true);
        return sendJson(resData);
      }

      if (pathname === '/api/revert' && method === 'POST') {
        const body = await readBody();
        const { forkSid, force } = body;
        if (!forkSid) return sendJson({ error: 'forkSid is required' }, 400);

        const resData = revertFork(forkSid, { force: force === true });
        this.ensureModel(true);
        return sendJson(resData);
      }

      if (pathname === '/api/context' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid) return sendJson({ error: 'Missing sid' }, 400);
        try {
          const ctxData = getSessionContext(sid, model);
          return sendJson(ctxData);
        } catch (e) {
          return sendError(e);
        }
      }

      if (pathname === '/api/context/save' && method === 'POST') {
        const body = await readBody();
        const { sid, edits, note } = body;
        if (!sid || !edits || !edits.length) {
          return sendJson({ error: 'sid and edits are required' }, 400);
        }
        try {
          const resData = await saveEditedSessionContext({ sid, edits, note }, model);
          this.ensureModel(true);
          return sendJson(resData);
        } catch (e) {
          return sendError(e);
        }
      }

      if (pathname === '/api/context/validate' && method === 'POST') {
        const body = await readBody();
        const { sid, edits } = body;
        if (!sid || !edits) return sendJson({ error: 'sid and edits are required' }, 400);
        try {
          const ctxData = getSessionContext(sid, model);
          const editMap = new Map();
          edits.forEach(e => editMap.set(e.id, e));
          const validation = validateContinuity(ctxData.blocks, editMap);
          return sendJson(validation);
        } catch (e) {
          return sendError(e);
        }
      }

      if (pathname === '/api/context/contract' && method === 'POST') {
        const body = await readBody();
        const { text, filename } = body;
        const contract = extractContract(text || '', filename || '');
        return sendJson({ contract });
      }

      if (pathname === '/api/context/synthesize' && method === 'POST') {
        const body = await readBody();
        const { sid, regionId } = body;
        if (!sid || regionId == null) return sendJson({ error: 'sid and regionId are required' }, 400);
        try {
          const edits = synthesizeRegionMilestone(regionId, sid, model);
          return sendJson({ ok: true, edits });
        } catch (e) {
          return sendError(e);
        }
      }

      if (pathname === '/api/context/simulate' && method === 'POST') {
        const body = await readBody();
        const { sid, edits } = body;
        if (!sid) return sendJson({ error: 'sid is required' }, 400);
        try {
          const sim = simulateResumedSession(sid, edits || [], model);
          return sendJson(sim);
        } catch (e) {
          return sendError(e);
        }
      }

      if (pathname === '/api/context/heal' && method === 'POST') {
        const body = await readBody();
        const { sid, blockId, text } = body;
        if (!sid || !blockId || text == null) return sendJson({ error: 'sid, blockId, and text are required' }, 400);
        try {
          const ctxData = getSessionContext(sid, model);
          const block = ctxData.blocks.find(b => b.id === blockId);
          if (!block) return sendJson({ error: 'Block not found' }, 404);
          const healedText = autoHealBridgeText(block, text);
          return sendJson({ healedText });
        } catch (e) {
          return sendError(e);
        }
      }

      // What a tree node stands for, in deletions that actually shrink the resume.
      if (pathname === '/api/node-plan' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid || sid === 'all') return sendJson({ error: 'Pick a session: deleting works on one session at a time.' }, 400);
        const q = (k) => parsedUrl.searchParams.get(k) || '';
        return sendJson(nodePlan(model, sid, { cat: q('cat'), sub: q('sub'), leaf: q('leaf'), minTok: q('minTok') }));
      }

      // The whole session as one deletable tree (the main UI's single read).
      if (pathname === '/api/map' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid || sid === 'all') return sendJson({ error: 'Missing sid' }, 400);
        return sendJson(contextMap(model, sid));
      }

      if (pathname === '/api/block' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid || sid === 'all') return sendJson({ error: 'Missing sid' }, 400);
        return sendJson(blockPreview(model, sid, parsedUrl.searchParams.get('id')));
      }

      if (pathname === '/api/boot' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid || sid === 'all') return sendJson({ error: 'Missing sid' }, 400);
        return sendJson(bootView(model, sid));
      }

      if (pathname === '/api/structure' && method === 'GET') {
        const sid = parsedUrl.searchParams.get('sid');
        if (!sid || sid === 'all') return sendJson({ error: 'Missing sid' }, 400);
        return sendJson(structureView(model, sid));
      }

      // One verified fork for everything in the delete queue.
      if (pathname === '/api/fork' && method === 'POST') {
        const body = await readBody();
        const { sid, edits, boot, structure, note, dryRun } = body;
        if (!sid) return sendJson({ error: 'sid is required' }, 400);
        if (![edits, boot, structure].every(x => x === undefined || Array.isArray(x))) return sendJson({ error: 'edits, boot and structure must be arrays' }, 400);
        const resData = applySurgery(model, { sid, edits, boot, structure, note, dryRun: dryRun === true });
        if (!resData.dryRun) this.ensureModel(true);
        return sendJson(resData);
      }

      if (pathname === '/api/refresh' && method === 'POST') {
        this.ensureModel(true);
        return sendJson({ ok: true, stats: this.model.stats });
      }

      return sendJson({ error: 'Not found' }, 404);
    }

  }

  serveStatic(pathname, res, security) {
    let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    let filePath = path.resolve(UI_DIR, rel);
    if (filePath !== UI_DIR && !filePath.startsWith(UI_DIR + path.sep)) filePath = path.join(UI_DIR, 'index.html');
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() && fs.existsSync(path.join(filePath, 'index.html'))) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(UI_DIR, 'index.html');

    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ...security };
    if (ext === '.html') {
      // Script only from this origin: even if some session text slipped past
      // escaping into the DOM, injected <img onerror> or <script> cannot run.
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    }
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...security }); res.end('File not found'); return; }
      if (ext === '.html') {
        content = Buffer.from(String(content).replace('<head>', `<head>\n  <meta name="ctxtree-token" content="${this.token}">`));
      }
      res.writeHead(200, headers);
      res.end(content);
    });
  }
}
