// End-to-end proof against the REAL Claude Code CLI: builds forks with ctxtree,
// resumes them with `claude -p`, and inspects the exact request Claude Code sends.
//
// Hermetic: a throwaway CLAUDE_CONFIG_DIR, a local stand-in for the Messages API
// (ANTHROPIC_BASE_URL) that records every request body and answers "OK", and two
// stub stdio MCP servers. No API credit, nothing touches your ~/.claude.
//   npm run verify:cc          (skips if `claude` is not on PATH)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('skip: claude CLI not found on PATH');
  process.exit(0);
}
const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-cc-')));
const CFG = path.join(ROOT, 'cfg'), PROJ = path.join(ROOT, 'proj'), CAP = path.join(ROOT, 'cap');
process.env.CLAUDE_CONFIG_DIR = CFG;
for (const d of [CFG, PROJ, CAP, path.join(CFG, 'skills', 'alpha-skill'), path.join(CFG, 'skills', 'beta-skill')]) fs.mkdirSync(d, { recursive: true });

const { parseSession } = await import('../src/session.js');
const { forkSession } = await import('../src/fork.js');
const { bootInventory } = await import('../src/boot.js');
const { structureInfo } = await import('../src/restructure.js');

// ---------------------------------------------------------------- sandbox
const STUB = path.join(ROOT, 'stubmcp.mjs');
fs.writeFileSync(STUB, `import readline from 'node:readline';
const [name, count] = process.argv.slice(2);
const tools = Array.from({ length: +count }, (_, i) => ({ name: name + '_tool' + i, description: name + ' TOOLDESC ' + 'lorem ipsum '.repeat(30), inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '1' }, instructions: 'INSTR-' + name + '-MARKER ' + 'be careful. '.repeat(30) } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
  out({ jsonrpc: '2.0', id: m.id, result: {} });
});
`);
const server = (name, n) => ({ type: 'stdio', command: process.execPath, args: [STUB, name, String(n)] });
fs.writeFileSync(path.join(CFG, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { stubA: server('stubA', 3), stubB: server('stubB', 3) } }));
fs.writeFileSync(path.join(CFG, 'settings.json'), '{}');
const pad = (s, n) => (s + ' ').repeat(n);
fs.writeFileSync(path.join(CFG, 'CLAUDE.md'), `# user\n\nUSERMD-MARKER ${pad('user preference.', 40)}\n`);
fs.writeFileSync(path.join(PROJ, 'CLAUDE.md'), `# project\n\nPROJMD-MARKER ${pad('project rule.', 40)}\n`);
for (const s of ['alpha', 'beta'])
  fs.writeFileSync(path.join(CFG, 'skills', `${s}-skill`, 'SKILL.md'), `---\nname: ${s}-skill\ndescription: SKILL-${s}-MARKER does ${s} things. ${pad('detail', 20)}\n---\n\nbody\n`);
const slug = PROJ.replace(/[^A-Za-z0-9]/g, '-');
const PDIR = path.join(CFG, 'projects', slug);
fs.mkdirSync(path.join(PDIR, 'memory'), { recursive: true });
fs.writeFileSync(path.join(PDIR, 'memory', 'MEMORY.md'), `- [Fact](fact.md) — AUTOMEM-MARKER ${pad('remembered', 30)}\n`);

// ------------------------------------------------------------- mock API
let requests = [];
const api = http.createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 1 })); }
    if (j) requests.push(j);
    const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    const model = (j && j.model) || 'claude-haiku-4-5';
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    // A prompt carrying WRITE-TOOL-MARKER is answered with a Write call (once),
    // so the session gets a real tool call and result to shrink and delete.
    const lastMsg = j && Array.isArray(j.messages) ? j.messages[j.messages.length - 1] : null;
    const lastBlocks = lastMsg ? (typeof lastMsg.content === 'string' ? [{ type: 'text', text: lastMsg.content }] : lastMsg.content) : [];
    const wantTool = lastBlocks.some(b => b.type === 'text' && b.text.includes('WRITE-TOOL-MARKER')) && !lastBlocks.some(b => b.type === 'tool_result');
    if (j && j.stream && wantTool) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      const input = { file_path: path.join(PROJ, 'written.txt'), content: 'BIGCONTENT-MARKER ' + 'line of file content\n'.repeat(300) };
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: 'Write', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', {});
      return res.end();
    }
    if (j && j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', {});
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage }));
  });
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const PORT = api.address().port;

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_)/.test(k)));
let callNo = 0;
function claude(args, extra = []) {
  const label = `${String(++callNo).padStart(2, '0')}-${args[1].replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)}`;
  return new Promise((resolve) => {
    requests = [];
    const p = spawn('claude', ['--model', 'claude-sonnet-4-5', ...extra, ...args], {
      cwd: PROJ, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...CLEAN_ENV, CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_API_KEY: 'sk-ant-api03-ctxtree-e2e', ENABLE_TOOL_SEARCH: 'true' },
    });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.on('close', (code) => {
      clearTimeout(t);
      const main = [...requests].reverse().find(r => Array.isArray(r.messages) && r.messages.length && Array.isArray(r.tools) && r.tools.length > 3);
      if (main) fs.writeFileSync(path.join(CAP, `${label}.json`), JSON.stringify(main, null, 1));
      resolve({ code, out, req: main });
    });
  });
}
const sessionFile = (sid) => path.join(PDIR, `${sid}.jsonl`);
const sess = (sid) => ({ sid, file: sessionFile(sid), project: slug, cwd: PROJ });
const wire = (req) => JSON.stringify(req);
const lastUserText = (req) => {
  const m = req.messages[req.messages.length - 1];
  const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
  return c.filter(b => b.type === 'text').map(b => b.text);
};

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

console.log(`ctxtree end-to-end against ${version}\n  sandbox: ${ROOT}\n`);

// ---------------------------------------------------------- 1. boot removal
const BASE = crypto.randomUUID();
let r = await claude(['-p', 'first turn', '--session-id', BASE]);
check('base session created', r.code === 0 && r.req, r.out.slice(0, 300));
const baseWire = wire(r.req);
for (const m of ['USERMD-MARKER', 'PROJMD-MARKER', 'AUTOMEM-MARKER', 'SKILL-beta-MARKER', 'INSTR-stubB-MARKER', 'mcp__stubB__stubB_tool0', '- Plan:', 'WebFetch'])
  check(`baseline request carries ${m}`, baseWire.includes(m));

const inv = bootInventory(parseSession(fs.readFileSync(sessionFile(BASE), 'utf8')));
const byName = (kind, pred) => inv.find(i => i.kind === kind && pred(i));
const sysSec = byName('sys', i => /tone and style/i.test(i.name)) || inv.find(i => i.kind === 'sys');
const removal = [
  byName('mcp', i => i.name === 'stubB'), byName('skill', i => i.name === 'beta-skill'),
  byName('md', i => i.name.endsWith(path.join('cfg', 'CLAUDE.md'))), byName('md', i => i.mdType === 'AutoMem'),
  byName('agent', i => i.name === 'Plan'), byName('tool', i => i.name === 'WebFetch'), sysSec,
];
check('inventory finds every item to remove', removal.every(Boolean), JSON.stringify(removal.map(x => x && x.id)));
const sysMarker = sysSec ? sysSec.name : '';
const res = forkSession(sess(BASE), [], { boot: removal.filter(Boolean).map(i => i.id), kind: 'boot' });
check('fork has a launch profile', !!res.profileFile && fs.existsSync(res.profileFile), JSON.stringify(res.profile));
r = await claude(['-p', 'after boot removal', '--resume', res.forkSid, '--settings', res.profileFile]);
check('fork resumes', r.code === 0 && r.req, r.out.slice(0, 300));
if (r.req) {
  const w = wire(r.req);
  for (const m of ['USERMD-MARKER', 'AUTOMEM-MARKER', 'SKILL-beta-MARKER', 'INSTR-stubB-MARKER', 'mcp__stubB__stubB_tool0', '- Plan:', '"WebFetch"'])
    check(`removed from the request: ${m}`, !w.includes(m));
  check('removed from the system prompt: a section', !JSON.stringify(r.req.system).includes(sysMarker) || !sysMarker, sysMarker);
  for (const m of ['PROJMD-MARKER', 'SKILL-alpha-MARKER', 'INSTR-stubA-MARKER', 'mcp__stubA__stubA_tool0'])
    check(`kept in the request: ${m}`, w.includes(m));
  const tail = lastUserText(r.req);
  check('nothing re-announced on resume', tail.length === 1 && tail[0] === 'after boot removal', JSON.stringify(tail).slice(0, 400));
  check('request is smaller', w.length < baseWire.length, `${baseWire.length} -> ${w.length}`);
}
r = await claude(['-p', 'without the profile', '--resume', res.forkSid]);
if (r.req) check('without the profile Claude Code re-announces (so the profile is needed)', lastUserText(r.req).length > 1);

// --------------------------------------------------------------- 2. slim
const COMP = crypto.randomUUID();
await claude(['-p', 'PRECOMPACT-MARKER turn', '--session-id', COMP]);
await claude(['-p', '/compact', '--resume', COMP]);
r = await claude(['-p', 'after compact', '--resume', COMP]);
check('compacted session resumes without its pre-compaction turn', r.req && !wire(r.req).includes('PRECOMPACT-MARKER'));
// Control: the same transcript under a new id, re-stamped the way a fork is (the
// compaction summary names the parent's transcript path, and must keep doing so).
const copy = crypto.randomUUID();
fs.writeFileSync(sessionFile(copy), fs.readFileSync(sessionFile(COMP), 'utf8').split('\n').filter(Boolean)
  .map(l => { const o = JSON.parse(l); if (o.sessionId === COMP) o.sessionId = copy; return JSON.stringify(o); }).join('\n') + '\n');
const slim = forkSession(sess(COMP), [], { structure: [{ op: 'slim' }], kind: 'slim' });
check('slim fork is smaller on disk', slim.bytes.after < slim.bytes.before, JSON.stringify(slim.bytes));
const a = await claude(['-p', 'same prompt', '--resume', copy]);
const b = await claude(['-p', 'same prompt', '--resume', slim.forkSid]);
check('slim fork sends a byte-identical request', a.req && b.req && JSON.stringify(a.req.messages) === JSON.stringify(b.req.messages) && JSON.stringify(a.req.system) === JSON.stringify(b.req.system));

// ----------------------------------------------------------- 3. uncompact
const un = forkSession(sess(COMP), [], { structure: [{ op: 'uncompact' }], kind: 'uncompact' });
r = await claude(['-p', 'after uncompact', '--resume', un.forkSid]);
if (r.req) {
  const w = wire(r.req);
  check('uncompact restores the pre-compaction turn', w.includes('PRECOMPACT-MARKER'));
  check('uncompact drops the summary', !w.includes('This session is being continued from a previous conversation'));
  const count = (m) => w.split(m).length - 1;
  check('boot overhead appears once, not twice', count('SKILL-alpha-MARKER') === 1 && count('PROJMD-MARKER') === 1, `${count('SKILL-alpha-MARKER')} / ${count('PROJMD-MARKER')}`);
  check('nothing re-announced after uncompact', lastUserText(r.req).length === 1, JSON.stringify(lastUserText(r.req)).slice(0, 300));
}

// -------------------------------------------------------------- 4. switch
const BR = crypto.randomUUID();
await claude(['-p', 'turn one', '--session-id', BR]);
await claude(['-p', 'BRANCH-A-MARKER', '--resume', BR]);
const firstAssistant = fs.readFileSync(sessionFile(BR), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(o => o.type === 'assistant').uuid;
await claude(['-p', 'BRANCH-B-MARKER', '--resume', BR, '--resume-session-at', firstAssistant]);
const info = structureInfo(parseSession(fs.readFileSync(sessionFile(BR), 'utf8')));
const branchA = info.branches.find(x => x.firstText.includes('BRANCH-A-MARKER'));
check('the abandoned branch is found', !!branchA, JSON.stringify(info.branches));
if (branchA) {
  const sw = forkSession(sess(BR), [], { structure: [{ op: 'switch', tip: branchA.tip }], kind: 'switch' });
  r = await claude(['-p', 'which branch', '--resume', sw.forkSid]);
  if (r.req) {
    const w = wire(r.req);
    check('switch resumes the chosen branch', w.includes('BRANCH-A-MARKER') && !w.includes('BRANCH-B-MARKER'));
  }
}

// -------------------------------------- 5. shrink a tool call, delete messages
const TL = crypto.randomUUID();
r = await claude(['-p', 'please write the file WRITE-TOOL-MARKER', '--session-id', TL], ['--permission-mode', 'bypassPermissions']);
check('tool session ran a Write call', r.req && wire(r.req).includes('BIGCONTENT-MARKER') && wire(r.req).includes('"tool_result"'), r.out.slice(0, 300));
{
  const p = parseSession(fs.readFileSync(sessionFile(TL), 'utf8'));
  const call = p.blocks.find(x => x.live && x.blockType === 'tool_use' && x.tool === 'Write');
  const result = p.blocks.find(x => x.live && x.blockType === 'tool_result' && x.tuid === (call && call.tuid));
  const reply = p.blocks.filter(x => x.live && x.blockType === 'text' && x.role === 'assistant').pop();
  check('found the call, its result and a reply', !!(call && result && reply));
  if (call && result && reply) {
    const f = forkSession(sess(TL), [{ id: call.id, fp: call.fp, op: 'shrink' }, { id: result.id, fp: result.fp, op: 'tombstone' }, { id: reply.id, fp: reply.fp, op: 'tombstone' }], { kind: 'surgery' });
    r = await claude(['-p', 'after shrinking', '--resume', f.forkSid]);
    check('shrunk fork resumes', r.code === 0 && r.req, r.out.slice(0, 300));
    if (r.req) {
      const w = wire(r.req);
      const reps = w.split('line of file content').length - 1;
      check('the call\'s large input is gone from the request', reps > 0 && reps < 10, `${reps} of 300 lines left`);
      check('the call keeps its first words and its name', w.includes('BIGCONTENT-MARKER') && w.includes('"name":"Write"') && w.includes('ctxtree: removed'));
      const toolUse = r.req.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_use');
      const toolRes = r.req.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_result');
      check('the call still pairs with its (deleted) result', toolUse.length === 1 && toolRes.length === 1 && toolRes[0].tool_use_id === toolUse[0].id);
      check('the deleted reply is replaced by a note', w.includes('ctxtree: removed assistant text'));
    }
  }
}

api.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
else console.log(`sandbox kept for inspection: ${ROOT}`);
process.exit(failed ? 1 : 0);
