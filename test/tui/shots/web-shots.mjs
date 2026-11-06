// Screenshots of ctxtree outside Claude Code (the web UI and the CLI) for
// docs/walkthrough.md, on demo sessions the real `claude -p` writes in the
// sandbox: boot overhead (two MCP servers, two skills, CLAUDE.md, memory), a
// rewound branch and a compaction, so every web UI feature has something to
// act on. Nothing touches ~/.claude.
//   node test/tui/shots/web-shots.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from '../sandbox.mjs';
import { FILES, PROMPTS, script, side, ALLOWED } from './demo.mjs';
import { screenHtml, screenSize } from './render.mjs';
import { launchChrome } from './chrome.mjs';
import { tty } from '../tty.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const OUT = path.join(REPO, 'docs/walkthrough/img');
const PORT = 4300 + Math.floor(Math.random() * 400);

// ---- the demo data
const pad = (s, n) => (s + ' ').repeat(n);
const sb = await makeSandbox({
  files: { ...FILES, 'CLAUDE.md': `# acme-api\n\nUse node --test for tests. Keep handlers thin; logic lives in src/auth and src/middleware.\n${pad('Prefer small focused modules.', 12)}\n` },
  script, side, prefix: 'ctxtree-web-', projName: 'acme-api', realUsage: true,
});
const STUB = path.join(sb.ROOT, 'stubmcp.mjs');
fs.writeFileSync(STUB, `import readline from 'node:readline';
const [name, count] = process.argv.slice(2);
const tools = Array.from({ length: +count }, (_, i) => ({ name: name + '_' + ['search', 'get', 'list', 'create', 'update'][i % 5] + (i > 4 ? i : ''), description: name + ' tool: ' + 'returns structured results for the query. '.repeat(12), inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '1' }, instructions: name + ': ' + 'use the search tool before get; results are paginated. '.repeat(20) } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
  out({ jsonrpc: '2.0', id: m.id, result: {} });
});
`);
const cj = JSON.parse(fs.readFileSync(path.join(sb.CFG, '.claude.json'), 'utf8'));
const server = (name, n) => ({ type: 'stdio', command: process.execPath, args: [STUB, name, String(n)] });
cj.mcpServers = { tracker: server('tracker', 6), docs: server('docs', 4) };
fs.writeFileSync(path.join(sb.CFG, '.claude.json'), JSON.stringify(cj));
fs.writeFileSync(path.join(sb.CFG, 'CLAUDE.md'), `# me\n\n${pad('Answer briefly; show diffs for code changes.', 10)}\n`);
for (const [s, d] of [['release-notes', 'Write release notes from the git log in the house style.'], ['db-migrations', 'Create and check database migrations for the API.']]) {
  fs.mkdirSync(path.join(sb.CFG, 'skills', s), { recursive: true });
  fs.writeFileSync(path.join(sb.CFG, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: ${d} ${pad('Use when asked.', 6)}\n---\n\nSteps.\n`);
}
fs.mkdirSync(path.join(sb.PDIR, 'memory'), { recursive: true });
fs.writeFileSync(path.join(sb.PDIR, 'memory', 'MEMORY.md'), `- [Deploys](deploys.md) — deploy with \`make ship\` from main only ${pad('noted', 20)}\n`);

const env = { ENABLE_TOOL_SEARCH: 'true' };
const run = async (args) => { const r = await sb.claudeP([...args, ...ALLOWED], env); if (r.code !== 0) console.log(`   claude ${args.slice(0, 2).join(' ')} → ${r.code}: ${r.out.slice(0, 200)}`); return r; };
const file = (sid) => path.join(sb.PDIR, `${sid}.jsonl`);
const recs = (sid) => fs.readFileSync(file(sid), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

console.log('building the demo sessions…');
const S2 = crypto.randomUUID();
await run(['-p', PROMPTS.bug, '--session-id', S2]);
await run(['-p', PROMPTS.shot, '--resume', S2]);
const S1 = crypto.randomUUID();
await run(['-p', PROMPTS.bug, '--session-id', S1]);
await run(['-p', PROMPTS.rate, '--resume', S1]);
const rateDone = recs(S1).filter(o => o.type === 'assistant').at(-1).uuid;
await run(['-p', PROMPTS.readme, '--resume', S1]);
await run(['-p', PROMPTS.access, '--resume', S1, '--resume-session-at', rateDone]); // rewinds: the README edit becomes a branch
await run(['-p', '/compact', '--resume', S1]);
await run(['-p', PROMPTS.log, '--resume', S1]);
await run(['-p', PROMPTS.shot, '--resume', S1]);
await run(['-p', PROMPTS.after, '--resume', S1]);
console.log(`   ${S1.slice(0, 8)} (${fs.statSync(file(S1)).size} B), ${S2.slice(0, 8)}`);

// ---- the web UI
const srvEnv = { ...process.env, CLAUDE_CONFIG_DIR: sb.CFG, HOME: sb.HOME };
const srv = spawn(process.execPath, [path.join(REPO, 'bin/ctxtree.js'), '--port', String(PORT), '--no-open'], { env: srvEnv, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const c = await launchChrome();
const W = 1600, H = 1000, SCALE = 1.5;
await c.size(W, H, SCALE);
const shot = async (name) => { await c.sleep(700); await c.shot(path.join(OUT, name)); console.log(`   ${name}`); };
const js = (f, ...a) => c.eval(`(${f})(${a.map(x => JSON.stringify(x)).join(',')})`);
const rowEl = `(t) => [...document.querySelectorAll('#tree .row')].find(r => r.textContent.includes(t))`;
const select = (t) => js(`(t) => { const r = (${rowEl})(t); if (!r) throw new Error('no row ' + t); r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }`, t);
const toggle = (t) => js(`(t) => { const r = (${rowEl})(t); if (!r) throw new Error('no row ' + t); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }`, t);
// Open (or close) a group only if it is not already: the next row is deeper when open.
const setOpen = (t, open) => js(`(t, open) => {
  const rows = [...document.querySelectorAll('#tree .row')].sort((a, b) => a.offsetTop - b.offsetTop);
  const i = rows.findIndex(r => r.textContent.includes(t));
  if (i < 0) throw new Error('no row ' + t);
  const lv = (r) => Number(r && r.getAttribute('aria-level') || 0);
  const isOpen = lv(rows[i + 1]) > lv(rows[i]);
  if (isOpen !== open) rows[i].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}`, t, open);
const rightClick = (t) => js(`(t) => { const r = (${rowEl})(t); if (!r) throw new Error('no row ' + t); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 220, clientY: b.bottom })); }`, t);
const key = (k) => js(`(k) => document.querySelector('#tree').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))`, k);
const button = (t) => js(`(t) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(t) && !b.disabled && b.offsetParent); if (!b) throw new Error('no button ' + t); b.click(); }`, t);
const closeMenu = () => js(`() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const rowsText = () => js(`() => [...document.querySelectorAll('#tree .row')].map(r => r.textContent.slice(0, 70)).join(' | ')`);

try {
  await c.goto(`http://127.0.0.1:${PORT}/`);
  await c.sleep(2500);
  await shot('web-01-overview.png');

  await js(`() => document.querySelector('#session-btn').click()`);
  await c.sleep(800);
  await shot('web-02-sessions.png');
  await closeMenu(); await c.sleep(300);
  if (await js(`() => !document.querySelector('#session-pop').classList.contains('hidden')`)) await js(`() => document.querySelector('#session-btn').click()`);
  await c.sleep(400);

  // by type, with the tool results open
  await button('By type'); await c.sleep(1200);
  await setOpen('Setup', false); await c.sleep(400);
  await setOpen('Conversation', false); await c.sleep(400);
  await setOpen('Tool results', true); await c.sleep(600);
  await setOpen('Read', true); await c.sleep(600);
  await select('server.log'); await c.sleep(600);
  await shot('web-03-by-type.png');

  // boot overhead
  await setOpen('Tool results', false); await c.sleep(400);
  await setOpen('Setup', true); await c.sleep(800);
  for (const g of ['MCP servers', 'Skills', 'CLAUDE.md']) { try { await setOpen(g, true); await c.sleep(400); } catch { /* not in this build */ } }
  try { await select('tracker'); } catch { await select('Setup'); }
  await shot('web-04-setup.png');

  // a right-click menu on a group of results
  await setOpen('Setup', false); await c.sleep(400);
  await setOpen('Tool results', true); await c.sleep(400);
  await rightClick('Read'); await c.sleep(800);
  await shot('web-05-menu.png');
  await closeMenu(); await c.sleep(300);

  // grey content: what resume never loads
  await setOpen('Tool results', false); await c.sleep(400);
  await setOpen('Not in resumed context', true); await c.sleep(800);
  try { await select('Before the compaction'); } catch { /* none */ }
  await shot('web-06-grey.png');
  try { await select('Rewound'); await shot('web-07-branch.png'); } catch (e) { console.log('   (no rewound branch)', String(e.message).slice(0, 80)); }

  // mark: the server log read, and one MCP server's boot overhead
  await setOpen('Not in resumed context', false); await c.sleep(300);
  await setOpen('Tool results', true); await setOpen('Read', true); await c.sleep(400);
  await select('logs/server.log'); await c.sleep(400);
  await key('Delete'); await c.sleep(500);
  await setOpen('Tool results', false); await c.sleep(300);
  await setOpen('Setup', true); await c.sleep(300);
  await setOpen('MCP servers', true); await c.sleep(500);
  try { await select('tracker'); await key('Delete'); await c.sleep(500); } catch (e) { console.log('   (mcp mark)', String(e.message).slice(0, 80)); }
  await shot('web-08-marked.png');

  // review, verify, fork
  await button('Review deletion'); await c.sleep(3500);
  await shot('web-09-review.png');
  await button('Create fork'); await c.sleep(3500);
  await shot('web-10-forked.png');
  await closeMenu(); await js(`() => document.querySelector('#scrim')?.click()`); await c.sleep(600);
  await js(`() => document.querySelector('#btn-forks').click()`); await c.sleep(1500);
  await shot('web-11-forks.png');
} catch (e) {
  console.log('   FAILED', String(e.message).slice(0, 600));
  try { console.log('   rows:', (await rowsText()).slice(0, 600)); } catch {}
}
await c.close();
srv.kill();

// ---- the CLI, in a terminal
const cli = async (name, args, rows = 40) => {
  const t = tty({ argv: [process.execPath, path.join(REPO, 'bin/ctxtree.js'), ...args], cols: 120, rows, env: { ...srvEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' }, cwd: sb.PROJ });
  for (let i = 0; i < 60 && t.exited === null; i++) await t.sleep(250);
  await t.sleep(500);
  const cap = await t.capture();
  const last = cap.cells.reduce((m, row, y) => (row.some(x => x.ch.trim()) ? y : m), 0);
  const opts = { title: `ctxtree ${args.join(' ')}`.trim(), y1: Math.min(rows, last + 2) };
  const { width, height } = screenSize(cap, opts);
  const c2 = await launchChrome();
  await c2.html(screenHtml(cap, opts), width, height, 2);
  await c2.shot(path.join(OUT, name));
  await c2.close();
  await t.close();
  console.log(`   ${name}`);
};
await cli('cli-01-scan.png', ['--scan-only'], 50);
await cli('cli-02-boot.png', ['--boot', S1.slice(0, 8)], 50);
await cli('cli-03-context.png', ['--context', S1.slice(0, 8)], 50);
sb.close();
