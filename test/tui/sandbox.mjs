// Hermetic Claude Code sandbox for ctxtree's TUI tests (test/tui-e2e.js): a
// throwaway config dir and HOME, a mock Messages API, and the real `claude`
// binary. Never touches ~/.claude.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { tty } from './tty.mjs';

const KEY = 'sk-ant-api03-ctxspike-' + 'x'.repeat(20) + 'MOCKKEYMOCKKEY123456';

export async function makeSandbox({ files = {}, script, side, prefix = 'ctxspike-', projName = 'proj', realUsage = false } = {}) {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const CFG = path.join(ROOT, 'cfg'), PROJ = path.join(ROOT, projName);
  const HOME = path.join(ROOT, 'home');
  for (const d of [CFG, PROJ, HOME]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(CFG, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [PROJ]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));
  fs.writeFileSync(path.join(CFG, 'settings.json'), '{}');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(PROJ, f)), { recursive: true }); fs.writeFileSync(path.join(PROJ, f), c); if (f.endsWith('.sh')) fs.chmodSync(path.join(PROJ, f), 0o755); }
  const PDIR = path.join(CFG, 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));

  const requests = [];
  // script(lastUserBlocks, request) -> array of content blocks for the assistant reply, or null for "OK"
  const api = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', async () => {
      let j = null; try { j = JSON.parse(body); } catch {}
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 1 })); }
      if (j) requests.push(j);
      const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
      const model = (j && j.model) || 'claude-sonnet-4-5';
      // Plausible usage: about four characters a token of what was sent, so
      // anything anchored to measured usage (ctxtree's maps) sees real sizes.
      // (only when asked: Claude Code's own per-category estimate disagrees with
      // this rough count, which skews anything anchored to both).
      const sent = j ? JSON.stringify({ s: j.system, t: j.tools, m: j.messages }).length : 4;
      const usage = { input_tokens: realUsage ? Math.max(1, Math.round(sent / 4)) : 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const last = j && Array.isArray(j.messages) ? j.messages[j.messages.length - 1] : null;
      const blocks = last ? (typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content) : [];
      const isMain = j && Array.isArray(j.tools) && j.tools.length > 3;
      let content = (isMain && script && script(blocks, j, { PROJ })) || (!isMain && side && side(blocks, j, { PROJ })) || [{ type: 'text', text: 'OK' }];
      const delay = content.delayMs || 0;
      if (delay) await new Promise(r => setTimeout(r, delay));
      res.writeHead(200, { 'content-type': j && j.stream ? 'text/event-stream' : 'application/json' });
      const stop = content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      if (!(j && j.stream)) return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason: stop, usage }));
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
      content.forEach((b, i) => {
        if (b.type === 'tool_use') {
          ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: b.name, input: {} } });
          ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        } else {
          ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
          ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
        }
        ev('content_block_stop', { index: i });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const PORT = api.address().port;
  const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_|TERM_PROGRAM|ITERM|KITTY|GHOSTTY|WEZTERM)/.test(k)));
  const env = (extra = {}) => ({ ...CLEAN, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME, CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_API_KEY: KEY, ...extra });

  function claudeP(args, extraEnv) {
    return new Promise((resolve) => {
      const n0 = requests.length;
      const p = spawn('claude', ['--model', 'claude-sonnet-4-5', ...args], { cwd: PROJ, stdio: ['ignore', 'pipe', 'pipe'], env: env(extraEnv) });
      let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), 120000);
      p.on('close', (code) => { clearTimeout(t); const reqs = requests.slice(n0); resolve({ code, out: out.trim(), reqs, main: [...reqs].reverse().find(r => Array.isArray(r.tools) && r.tools.length > 3) }); });
    });
  }
  function interactive({ args = [], cols = 170, rows = 50, fullscreen = true, extraEnv = {} } = {}) {
    return tty({ argv: ['claude', '--model', 'claude-sonnet-4-5', ...args], cols, rows, cwd: PROJ, env: env({ ...(fullscreen ? { CLAUDE_CODE_NO_FLICKER: '1' } : {}), ...extraEnv }) });
  }
  const transcript = (sid) => fs.readFileSync(path.join(PDIR, `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { ROOT, HOME, CFG, PROJ, PDIR, PORT, requests, env, claudeP, interactive, transcript, close: () => api.close() };
}
