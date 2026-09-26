import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './model.js';
import { buildTree, projectBreakdown } from './tree.js';
import { buildRegions } from './regions.js';
import { findings } from './findings.js';
import { pruneSession, getLineage, revertFork } from './prune.js';

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
    this.model = null;
    this.cachedFindings = null;
    this.server = null;
  }

  ensureModel(force = false) {
    if (!this.model || force) {
      console.log('Building ctxtree model...');
      const t0 = Date.now();
      this.model = build();
      this.cachedFindings = findings(this.model);
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
          this.server.listen(this.port);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
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

  async handle(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // Helper to send JSON
    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(JSON.stringify(data));
    };

    // Helper to read JSON body
    const readBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // API Routes
    if (pathname.startsWith('/api/')) {
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
        // Refresh model in background so new session is indexed
        setTimeout(() => this.ensureModel(true), 100);
        return sendJson(resData);
      }

      if (pathname === '/api/revert' && method === 'POST') {
        const body = await readBody();
        const { forkSid } = body;
        if (!forkSid) return sendJson({ error: 'forkSid is required' }, 400);

        const resData = revertFork(forkSid);
        setTimeout(() => this.ensureModel(true), 100);
        return sendJson(resData);
      }

      if (pathname === '/api/refresh' && method === 'POST') {
        this.ensureModel(true);
        return sendJson({ ok: true, stats: this.model.stats });
      }

      return sendJson({ error: 'Not found' }, 404);
    }

    // Static files from UI directory
    let filePath = path.join(UI_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(UI_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  }
}
