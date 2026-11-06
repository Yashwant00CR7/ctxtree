// End-to-end proof of the ctxtree mod against the REAL Claude Code: both
// plugins loaded with --plugin-dir, the interactive CLI driven through a
// pseudo-terminal and read back through xterm.js (the emulator vTower uses),
// and every request Claude Code sends inspected at a mock Messages API.
//
// Hermetic: throwaway CLAUDE_CONFIG_DIR and HOME, a local API stand-in. No API
// credit, nothing touches your ~/.claude.
//   npm run verify:tui          (skips without `claude`, python3 or @xterm/headless)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const skip = (why) => { console.log(`skip: ${why}`); process.exit(0); };
if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) skip('claude CLI not found on PATH');
if (spawnSync('python3', ['--version']).status !== 0) skip('python3 not found (the pty driver needs it)');
try { await import('@xterm/headless'); } catch { skip('@xterm/headless is not installed (npm install)'); }
const { makeSandbox } = await import('./tui/sandbox.mjs');
const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`claude ${version}`);

const PLUGINS = ['--plugin-dir', path.join(REPO, 'plugins/ctxtree'), '--plugin-dir', path.join(REPO, 'plugins/ctxtree-ui')];
const ALLOW = ['--allowedTools', 'Read,ToolSearch,mcp__ctxtree__map,mcp__ctxtree__stage,mcp__ctxtree__inspect'];
const BIG = 'BIGRESULT-MARKER\n' + 'a line of a big file\n'.repeat(400);
// A 1x1 PNG, for a Read that puts an image block in the conversation.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const VTOWER = fs.existsSync('/Applications/vTower.app');

// What Apply wrote: the session's folder holds the session and, after an
// Apply, its fork; the lineage file names the fork.
function forkOf(h) {
  const lin = path.join(h.sb.CFG, 'ctxtree', 'lineage.jsonl');
  if (!fs.existsSync(lin)) return null;
  const e = fs.readFileSync(lin, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  return e && fs.existsSync(e.file) ? { ...e, raw: fs.readFileSync(e.file, 'utf8') } : null;
}
// The vtower:// links the pane opened (a stand-in `open` on the PATH records them).
const opened = (h) => (fs.existsSync(path.join(h.sb.ROOT, 'opened.log')) ? fs.readFileSync(path.join(h.sb.ROOT, 'opened.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

// Every result follows its call, every call is answered before the next prompt.
function pairing(req) {
  const open = new Set(), seen = new Set(), problems = [];
  (req.messages || []).forEach((m, i) => {
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of c) {
      if (b.type === 'tool_result') { if (!seen.has(b.tool_use_id)) problems.push(`orphan result at ${i}`); open.delete(b.tool_use_id); }
      if (b.type === 'tool_use') { seen.add(b.id); open.add(b.id); }
    }
    if (m.role === 'user' && c.some(b => b.type === 'text' && !String(b.text).startsWith('<system-reminder>')) && open.size) problems.push(`prompt at ${i} before ${open.size} result(s)`);
  });
  return problems;
}

// The mock model: reads files on cue, and plays Claude's side of a cleanup
// interview with the ctxtree tools.
function script(blocks, req, { PROJ }) {
  const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join(' ');
  const results = blocks.filter(b => b.type === 'tool_result');
  const resultText = results.map(r => (typeof r.content === 'string' ? r.content : (r.content || []).map(x => x.text || '').join(''))).join('\n');
  const calls = (req.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_use');
  const lastCall = calls[calls.length - 1];
  if (results.length && lastCall) {
    if (lastCall.name === 'ToolSearch') return [{ type: 'tool_use', name: 'mcp__ctxtree__map', input: { view: 'type' } }];
    if (lastCall.name === 'mcp__ctxtree__map') {
      const id = (resultText.split('\n').find(l => l.includes('big.txt')) || '').match(/\[([^\]]+)\]/);
      if (!id) {
        const group = (resultText.split('\n').find(l => /Read/.test(l)) || '').match(/\[([^\]]+)\]/);
        if (group && !lastCall.input.under) return [{ type: 'tool_use', name: 'mcp__ctxtree__map', input: { view: 'type', under: group[1] } }];
        return [{ type: 'text', text: `NO-ID-FOUND in map:\n${resultText.slice(0, 400)}` }];
      }
      return [{ type: 'tool_use', name: 'mcp__ctxtree__stage', input: { items: [{ id: id[1], op: 'drop' }] } }];
    }
    if (lastCall.name === 'mcp__ctxtree__stage') return [{ type: 'text', text: `STAGED-REPLY ${resultText.slice(0, 160)}` }];
    return [{ type: 'text', text: 'Read it.' }];
  }
  if (text.includes('READ-BIG')) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(PROJ, 'big.txt') } }];
  if (text.includes('READ-PNG')) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(PROJ, 'dot.png') } }];
  if (text.includes('READ-SMALL')) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(PROJ, 'small.txt') } }];
  if (text.includes('CLEANUP-PLEASE')) return [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:mcp__ctxtree__map,mcp__ctxtree__stage', max_results: 5 } }];
  if (text.includes('SLOW-TURN')) { const c = [{ type: 'text', text: 'SLOW-DONE' }]; c.delayMs = 9000; return c; }
  return null;
}

// CTXTREE_TUI_ONLY=<part of a scenario's name> runs just that one;
// CTXTREE_TUI_DEBUG=1 adds Claude Code's debug log to each sandbox's logs.
const ONLY = process.env.CTXTREE_TUI_ONLY || '';
const DEBUG = process.env.CTXTREE_TUI_DEBUG === '1';
async function session(name, body, { cols = 200 } = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  console.log(`\n${name}`);
  const sb = await makeSandbox({ files: { 'big.txt': BIG, 'small.txt': 'small\n', 'dot.png': PNG }, script });
  const bin = path.join(sb.ROOT, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" >> "${path.join(sb.ROOT, 'opened.log')}"\n`, { mode: 0o755 });
  const t = sb.interactive({ args: [...PLUGINS, ...ALLOW, ...(DEBUG ? ['--debug-file', path.join(sb.ROOT, 'debug.log')] : [])], cols, rows: 60,
    extraEnv: { PATH: `${bin}:${process.env.PATH}` } });
  const log = [];
  const h = {
    sb, t,
    cmd: async (c) => { t.send('\x15'); await t.sleep(150); await t.type(c); await t.sleep(300); t.send('\r'); },
    clickRow: async (re) => { const f = await t.find(re); if (!f) throw new Error(`no row ${re}`); await t.click(f.x + 2, f.y); await t.sleep(900); },
    key: async (k, ms = 1000) => { t.send(k); await t.sleep(ms); },
    snap: async (label) => { log.push(`===== ${label}\n${(await t.screen()).join('\n')}`); },
    lastReq: () => sb.requests.filter(r => Array.isArray(r.tools) && r.tools.length > 3).at(-1),
    band: async () => ((await t.screen()).find(l => /ctxtree · .*(marked|writing)/.test(l)) || '').trim(),
  };
  try {
    await t.waitFor(/for shortcuts/, 45000);
    await body(h);
  } catch (err) {
    check(`${name}: ran to the end`, false, String(err.message).slice(0, 1500));
  } finally {
    await h.snap('end');
    fs.mkdirSync(path.join(sb.ROOT, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sb.ROOT, 'logs', 'screens.log'), log.join('\n\n'));
    console.log(`        screens: ${path.join(sb.ROOT, 'logs', 'screens.log')}`);
    await t.close(); sb.close();
  }
}

await session('pane: mark a big result, review, write the fork and open it', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('READ-SMALL please read the small one too'); await t.sleep(4000);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  check('the pane opens docked with the tree, the treemap and the key bar',
    !!(await t.find(/ctxtree · /)) && !!(await t.find(/▀▀▀▀▀▀▀▀/)) && !!(await t.find(/x: mark/)));
  await h.key('2', 1200);
  check('2 switches to the by-type view', !!(await t.find(/\[By type\]/)) && !!(await t.find(/Tool results/)));
  await h.key('\x1b[B', 1200);
  check('the arrows move the selection (pane keys)', (await t.inverse()).some(l => l.includes('Tool results')));
  await h.clickRow(/▸ Tool results/);
  await h.key('l', 1200);
  check('a click gives the tree its keys; l opens the group', !!(await t.find(/▾ Tool results/)));
  await h.clickRow(/▸ Read /);
  await h.key('\x1b[C', 1200);
  await h.clickRow(/big\.txt/);
  check('a click selects the row', (await t.inverse()).some(l => l.includes('big.txt')));
  await h.key(' ', 1500);
  await h.snap('marked');
  check('Space marks it and the band shows the plan', /1 marked · −\d/.test(await h.band()), await h.band());
  await h.key('u', 1500);
  check('u undoes the mark', !(await h.band()));
  await h.key(' ', 1500);
  await h.key('\x1b', 1000);
  await h.key('2', 3000);
  await h.snap('review');
  check('a digit on the band opens the review', !!(await t.find(/ctxtree review · 1 item/)) && !!(await t.find(/big\.txt/)));
  check('the review built the fork in memory and verified it', !!(await t.find(/Verified on a full build of the fork/)));
  const sid = fs.readdirSync(h.sb.PDIR).find(f => f.endsWith('.jsonl')).slice(0, -6);
  const before = h.sb.requests.length;
  await h.key('a', 5000);
  await h.snap('written');
  const f = forkOf(h);
  check('a writes the fork and says so', !!f && !!(await t.find(/Fork [0-9a-f]{8} written/)), f ? f.forkSid : 'no lineage entry');
  check('writing it sends nothing to the API', h.sb.requests.length === before, `${h.sb.requests.length - before} request(s)`);
  if (!f) return;
  check('the fork leaves the big result out entirely, and keeps the rest', !f.raw.includes('BIGRESULT-MARKER') && f.raw.includes('READ-SMALL'));
  check('this session is not changed', fs.readFileSync(path.join(h.sb.PDIR, `${sid}.jsonl`), 'utf8').includes('BIGRESULT-MARKER'));
  if (VTOWER) check('it opens in vTower: vtower://resume/<fork>?cwd=<folder>', opened(h).includes(`vtower://resume/${f.forkSid}?cwd=${encodeURIComponent(h.sb.PROJ)}`), opened(h).join(' | '));
  const r = await h.sb.claudeP(['-p', 'AFTER-FORK what do you remember', '--resume', f.forkSid, ...PLUGINS]);
  const body = JSON.stringify(r.main ? r.main.messages : []);
  check('the fork resumes in the real CLI without the big result', r.main && !body.includes('BIGRESULT-MARKER') && body.includes('READ-SMALL'), r.out.slice(0, 300));
  check('and its request keeps calls and results paired', r.main && pairing(r.main).length === 0, r.main && pairing(r.main).join('; '));
  await h.cmd('STILL-HERE carry on'); await t.sleep(4000);
  check('the session you are in still has it', JSON.stringify(h.lastReq() ? h.lastReq().messages : []).includes('BIGRESULT-MARKER'));
});

await session('Claude: maps, stages, the user writes the fork', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('CLEANUP-PLEASE free some context for me'); await t.waitFor(/STAGED-REPLY/, 40000); await t.sleep(1500);
  await h.snap('staged');
  const staged = (await t.screen()).join('\n');
  check('Claude found the item through the map and staged it', /STAGED-REPLY Staged 1 deletion/.test(staged), staged.match(/STAGED-REPLY.*|NO-ID-FOUND.*/)?.[0]);
  check('the band shows what Claude staged', /1 marked/.test(await h.band()), await h.band());
  await h.key('2', 3000);
  check('the review says what Claude staged', !!(await t.find(/by Claude/)));
  await h.key('a', 5000);
  const f = forkOf(h);
  check('the fork is written without the result', !!f && !f.raw.includes('BIGRESULT-MARKER') && f.raw.includes('READ-BIG please read'));
});

await session('your message takes its whole task: nothing of it is left', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('READ-SMALL please read the small one too'); await t.sleep(4000);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  await h.clickRow(/▸ READ-BIG please/);
  await h.key(' ', 1500);
  check('marking a task marks your message and everything done for it', /[2-9] marked/.test(await h.band()), await h.band());
  await h.key('\x1b', 800);
  await h.key('2', 3000);
  check('the review says the whole task goes', !!(await t.find(/1 whole task goes/)));
  await h.key('a', 5000);
  const f = forkOf(h);
  check('the fork has no trace of your message', !!f && !f.raw.includes('READ-BIG please read') && !f.raw.includes('BIGRESULT-MARKER') && f.raw.includes('READ-SMALL'));
  if (!f) return;
  const r = await h.sb.claudeP(['-p', 'AFTER-TASK next', '--resume', f.forkSid, ...PLUGINS]);
  const body = JSON.stringify(r.main ? r.main.messages : []);
  check('the fork resumes: the other task only, turns alternating', r.main && !body.includes('READ-BIG') && body.includes('READ-SMALL') && r.main.messages.every((m, i) => !i || m.role !== r.main.messages[i - 1].role || m.role === 'user'), r.out.slice(0, 300));
});

await session('menu, treemap click, keys', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  await h.key('k', 1200);
  check('k shows the keys', !!(await t.find(/Esc   back to the prompt/)) || !!(await t.find(/Keys/)));
  // a docked pane under 110 columns shows the keys in the treemap's place: k again brings it back
  if (!(await t.find(/▀▀▀▀▀▀▀▀▀▀/))) await h.key('k', 1200);
  await h.key('2', 1200);
  check('treemap blocks say how big they are', !!(await t.find(/\d(\.\d)?k\b/)));
  // a click on the treemap selects the block under it and reveals it in the tree
  const map = await t.find(/▀▀▀▀▀▀▀▀▀▀/);
  const rows = (await t.screen()).map((l, y) => [l, y]).filter(([l]) => l.includes('▀▀▀▀▀▀▀▀▀▀'));
  const last = rows[rows.length - 1];
  await t.click(map.x + 3, last[1]); await t.sleep(1500);
  const sel = (await t.inverse()).join(' | ');
  check('a treemap click selects the block under it', sel.length > 0 && !/^▸ Setup/.test(sel), sel.slice(0, 120));
  // (the click opened the groups it landed in: fold Setup away again)
  if (await t.find(/▾ Setup/)) { await h.clickRow(/▾ Setup/); await h.key('h', 1000); }
  await h.clickRow(/[▸▾] Tool results/); if (await t.find(/▸ Tool results/)) await h.key('l', 1000);
  await h.clickRow(/[▸▾] Read /); if (await t.find(/▸ Read /)) await h.key('\x1b[C', 1000);
  await h.clickRow(/big\.txt/);
  await h.key('d', 1500);
  await h.snap('menu');
  check('d opens the menu for the selection', !!(await t.find(/delete \(gone from the fork\)/)));
  await h.key('1', 1500);
  check('1 marks it', /1 marked/.test(await h.band()), await h.band());
});

await session('Details: a task as it happened, a tool call opens in place', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  await h.clickRow(/▸ READ-BIG please/);
  await h.key('i', 1500);
  await h.snap('timeline');
  check('the side shows Details and Types as tabs', !!(await t.find(/Details\s+│\s+Types/)));
  check('Details lists the task in order: your message in full, then its tool call',
    !!(await t.find(/What happened · \d+ items · 1 tool calls/)) && !!(await t.find(/^\s*│?\s*READ-BIG please read the big file for me\s*$/)) && !!(await t.find(/▸ Read .*big\.txt/)));
  check('a closed tool call shows no output', !(await t.find(/It got back/)));
  await h.clickRow(/▸ Read .*big\.txt/);
  await h.snap('opened');
  check('a click opens the call in place: what Claude sent, what came back', !!(await t.find(/▾ Read .*big\.txt/)) && !!(await t.find(/Claude sent/)) && !!(await t.find(/It got back/)));
  check('the output shows under it', !!(await t.find(/1\s+BIGRESULT-MARKER/)));
  await h.key('\x1b[6~', 1500);
  check('PgDn scrolls further into the output', !!(await t.find(/\b[2-9]\d\s+a line of a big file/)) && !(await t.find(/1\s+BIGRESULT-MARKER/)));
  await h.key('\x1b[H', 1200);
  // your message, the attachments that came with it, then the call
  await h.key('j', 1200);
  await h.key('j', 1200);
  await h.key('x', 1500);
  check('x marks the item under the cursor and the band shows the plan', /1 marked/.test(await h.band()), await h.band());
  check('the marked call is struck through in Details', !!(await t.find(/✕ marked/)));
});

await session('a narrow pane: details and keys take the treemap\'s place', async (h) => {
  const { t } = h;
  await h.cmd('READ-BIG please read the big file for me'); await t.waitFor(/Read it\./, 30000);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  check('narrow: the treemap shows, no side column', !!(await t.find(/▀▀▀▀▀▀▀▀/)) && !(await t.find(/Esc   back to the prompt/)));
  await h.key('k', 1500);
  check('k puts the keys where the treemap was', !!(await t.find(/Esc   back to the prompt/)) && !(await t.find(/▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀/)));
  await h.key('k', 1500);
  check('k again brings the treemap back', !!(await t.find(/▀▀▀▀▀▀▀▀/)));
  await h.key('i', 1500);
  check('i shows the details of the selection', !!(await t.find(/^\s*│?\d[\d.]*k? tokens/)) || !!(await t.find(/[0-9]k? tokens( · turn)?\s*$/)));
}, { cols: 150 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
