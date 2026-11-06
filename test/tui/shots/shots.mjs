// Screenshots for docs/walkthrough.md, taken from the real Claude Code with both
// ctxtree plugins loaded, in the hermetic sandbox (test/tui/sandbox.mjs) on a
// demo project (demo.mjs). Each screen is captured cell by cell through
// xterm.js and rendered to PNG by headless Chrome (render.mjs, chrome.mjs).
//   node test/tui/shots/shots.mjs [only-scene-prefix]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from '../sandbox.mjs';
import { FILES, PROMPTS, script, side, ALLOWED } from './demo.mjs';
import { screenHtml, screenSize } from './render.mjs';
import { launchChrome } from './chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const OUT = path.join(REPO, 'docs/walkthrough/img');
const TXT = process.env.SHOTS_TXT || '';
const ONLY = process.argv[2] || '';
const PLUGINS = ['--plugin-dir', path.join(REPO, 'plugins/ctxtree'), '--plugin-dir', path.join(REPO, 'plugins/ctxtree-ui')];
const DONE = {
  bug: /All 62 auth tests pass/, rate: /The full suite passes/, log: /Nine errors last night/,
  shot: /request id on it/, readme: /Added a setup step/, cleanup: /press \*?\*?2|Nothing is removed until/,
};
fs.mkdirSync(OUT, { recursive: true });
const chrome = await launchChrome();

async function scene(name, opts, body) {
  if (ONLY && !name.startsWith(ONLY)) return;
  console.log(`\n== ${name}`);
  const sb = await makeSandbox({ files: FILES, script, side, prefix: 'ctxtree-demo-', projName: 'acme-api' });
  let t = sb.interactive({ args: [...PLUGINS, ...ALLOWED], cols: opts.cols || 200, rows: opts.rows || 56, fullscreen: opts.fullscreen !== false, extraEnv: opts.env || {} });
  // Find text inside the docked pane when one is open (the transcript beside it
  // often mentions the same file names), else anywhere.
  const paneX = async () => { const s = await t.screen(); const y = s.findIndex(l => /ctxtree (·|review ·)/.test(l)); return y < 0 ? 0 : Math.max(0, s[y].search(/ctxtree/) - 1); };
  const find = async (re, anywhere = false) => {
    const x0 = anywhere ? 0 : await paneX();
    const s = await t.screen();
    for (let y = 0; y < s.length; y++) { const m = re.exec(s[y].slice(x0)); if (m) return { x: x0 + m.index, y, w: m[0].length }; }
    return null;
  };
  const h = {
    get t() { return t; }, set t(v) { t = v; }, sb, find,
    cmd: async (c) => { t.send('\x15'); await t.sleep(150); await t.type(c, 6); await t.sleep(300); t.send('\r'); },
    turn: async (k) => { await h.cmd(PROMPTS[k]); if (DONE[k]) await t.waitFor(DONE[k], 60000); await t.sleep(1200); },
    key: async (k, ms = 1100) => { t.send(k); await t.sleep(ms); },
    click: async (re, dx = 2) => { const f = await find(re); if (!f) throw new Error(`nothing matches ${re}`); await t.click(f.x + dx, f.y); await t.sleep(1000); return f; },
    at: async (re, anywhere = false) => find(re, anywhere),
    // select a row by name and open it if it is closed
    open: async (name) => { const f = await find(new RegExp(`[▸▾] ${name}`)); if (!f) throw new Error(`no row ${name}`); await t.click(f.x + 2, f.y); await t.sleep(900); if ((await t.screen())[f.y].includes(`▸ ${name.replace(/\\/g, '')}`)) { t.send('l'); await t.sleep(1100); } },
    // give the tree the keyboard (a click on its first row)
    focusTree: async () => { const f = await find(/[▸▾] Setup/); if (f) { await t.click(f.x + 2, f.y); await t.sleep(900); } },
    // the docked pane's box: from its header to its key bar
    pane: async (bottomRe = /x: mark/) => {
      const s = await t.screen();
      const y = s.findIndex(l => /ctxtree (·|review ·)/.test(l));
      if (y < 0) throw new Error('no pane on screen');
      const x = s[y].search(/ctxtree/) - 1;
      let y1 = s.findIndex((l, i) => i > y && bottomRe.test(l));
      if (y1 < 0) y1 = s.length - 1;
      return { x0: Math.max(0, x), y0: Math.max(0, y - 1), x1: s[y].length, y1: Math.min(s.length, y1 + 2) };
    },
    shot: async (file, o = {}) => {
      const cap = await t.capture();
      const crop = o.crop || {};
      const opts2 = { title: o.title || 'claude — acme-api', ...crop, badges: o.badges || [], boxes: o.boxes || [] };
      const { width, height } = screenSize(cap, opts2);
      await chrome.html(screenHtml(cap, opts2), width, height, 2);
      await chrome.shot(path.join(OUT, file));
      if (TXT) { fs.mkdirSync(TXT, { recursive: true }); fs.writeFileSync(path.join(TXT, file.replace(/\.png$/, '.txt')), (await t.screen()).join('\n')); }
      console.log(`   ${file}`);
    },
    badge: async (n, re, dx = 0, anywhere = false) => { const f = await find(re, anywhere); return f ? { n, x: f.x, y: f.y, w: f.w } : null; },
  };
  try {
    await t.waitFor(/for shortcuts/, 45000);
    await body(h);
  } catch (err) {
    console.log(`   FAILED: ${String(err.message).slice(0, 1500)}`);
    if (TXT) fs.writeFileSync(path.join(TXT, `${name}-failed.txt`), (await t.screen()).join('\n'));
  } finally { await t.close(); sb.close(); }
}

const badges = async (h, list) => (await Promise.all(list.map(([n, re, dx, any]) => h.badge(n, re, dx, any)))).filter(Boolean);

// ---- A: the pane, end to end
await scene('A', {}, async (h) => {
  const { t } = h;
  for (const k of ['bug', 'rate', 'log', 'shot', 'readme']) await h.turn(k);
  await h.shot('01-session.png', { crop: { y0: 0, y1: 56 } });

  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(2000);
  await h.shot('02-overview.png', { badges: await badges(h, [
    [1, /ctxtree · \d/, -2], [2, /1: \[By task\]/, -2], [3, /▸ Setup/, -2], [4, /Setup {2}\d/, -2],
    [5, /Loaded before your first/, -2], [6, /nothing marked/, -2], [7, /x: mark/, -2]]) });

  // by task: open the bug-fix task
  await h.open('The login keeps failing');
  const pane = await h.pane();
  await h.shot('03-by-task.png', { crop: pane, badges: await badges(h, [[1, /▾ The login keeps failing/, -2], [2, /out of date/, -2]]) });

  // details of a stale read
  await h.click(/Read src\/auth\/token\.js/, 6);
  await h.shot('04-details.png', { crop: await h.pane(), badges: await badges(h, [[1, /Read src\/auth\/token\.js/, -2], [2, /tokens · turn/, -2]]) });

  // by type
  await h.key('2', 1500);
  await h.open('Tool results');
  await h.shot('05-by-type.png', { crop: await h.pane(), badges: await badges(h, [[1, /\[By type\]/, -2], [2, /▾ Tool results/, -2]]) });

  // a click on the treemap: the biggest result (the server log)
  const label = await h.at(/logs\/server\.log/);
  const rows = (await t.screen()).map((l, y) => [l, y]).filter(([l]) => l.includes('▀▀▀▀▀▀'));
  if (label && rows.length) { await t.click(label.x + 6, Math.min(label.y + 4, rows[rows.length - 1][1])); await t.sleep(1500); }
  await h.shot('06-treemap-click.png', { crop: await h.pane(), badges: await badges(h, [[1, /▸ Read|▾ Read/, -2]]) });

  // types, and highlighting one type in the treemap
  await h.key('t', 1500);
  await h.click(/Bash results/, 0);
  await h.shot('07-types.png', { crop: await h.pane(), badges: await badges(h, [[1, /Types/, -2]]) });
  await h.click(/Bash results/, 0); // un-highlight
  await h.focusTree();

  // keys
  await h.key('k', 1500);
  await h.shot('08-keys.png', { crop: await h.pane() });
  await h.key('i', 1000);

  // filter
  await h.key('f', 1200);
  await h.click(/Filter/, 8);
  await t.type('token', 40); await t.sleep(800);
  await h.shot('09-filter-typing.png', { crop: await h.pane() });
  t.send('\r'); await t.sleep(1500);
  await h.shot('10-filtered.png', { crop: await h.pane(), badges: await badges(h, [[1, /filter “token”/, -2]]) });
  await h.focusTree();
  await h.key('f', 1000); await h.click(/Filter/, 8);
  for (let i = 0; i < 8; i++) { t.send('\x7f'); await t.sleep(40); }
  t.send('\r'); await t.sleep(1500);
  await h.focusTree();

  // mark: the test runs (the whole Bash group) and the server log
  await h.open('Tool results');
  await h.click(/[▸▾] Bash /);
  await h.key(' ', 1500);
  await h.click(/logs\/server\.log/);
  await h.key(' ', 1500);
  await h.shot('11-marked.png', { badges: await badges(h, [[1, /logs\/server\.log/, -2], [2, /\d+ marked · −/, -2], [3, /ctxtree · \d+ staged/, -2, true]]) });

  // the menu on a big tool call: shrink
  await h.click(/▾ Tool results/); await h.key('h', 1200); // close it, so the only Write is the call
  await h.open('Conversation');
  await h.open('Tool calls');
  await h.open('Write');
  await h.click(/rateLimit\.js/);
  await h.key('d', 1500);
  await h.shot('12-menu.png', { crop: await h.pane(), badges: await badges(h, [[1, /2: shrink/, -2], [2, /3: bridge/, -2]]) });
  await h.key('2', 1500);

  // a bridge, drafted by Claude
  await h.click(/▾ Conversation/); await h.key('h', 1200);
  await h.open('Tool results');
  await h.open('Read');
  await h.click(/src\/auth\/session\.js/);
  await h.key('d', 1200);
  await h.key('3', 6000);
  await h.shot('13-bridge-drafted.png', { crop: await h.pane(), badges: await badges(h, [[1, /Bridge drafted/, -2]]) });

  // the band, from the prompt
  await h.key('\x1b', 1000);
  const s = await t.screen();
  const band = s.findIndex(l => /ctxtree · \d+ staged/.test(l));
  await h.shot('14-band.png', { crop: { x0: 0, y0: Math.max(0, band - 3), x1: 200, y1: Math.min(56, band + 5) }, badges: await badges(h, [[1, /1: open/, -2, true], [2, /2: review/, -2, true]]) });

  // review
  await h.key('2', 3000);
  await h.shot('15-review.png', { crop: await h.pane(/q: close/), badges: await badges(h, [[1, /holds 1 image/, -2], [2, /→/, -2], [3, /Apply \d/, -2]]) });

  // apply
  await h.key('a', 1800);
  await h.shot('16-applied.png', { badges: await badges(h, [[1, /applied ·/, -2, true], [2, /Conversation compacted/, -2, true]]) });
  await t.sleep(3000);

  // the pane afterwards
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1800);
  await h.key('2', 1500);
  await h.open('Tool results');
  await h.shot('17-after.png', { crop: await h.pane(), badges: await badges(h, [[1, /ctxtree · \d/, -2]]) });

  // what Claude reads now
  await h.key('\x1b', 1000);
  const note = await h.at(/\[ctxtree: the user/, true);
  await h.shot('18-note.png', { crop: { x0: 0, y0: Math.max(0, (note ? note.y : 30) - 14), x1: 100, y1: Math.min(56, (note ? note.y : 30) + 4) }, badges: note ? [{ n: 1, x: note.x, y: note.y, w: note.w }] : [] });

  // restore
  await h.cmd('/ctxtree review'); await t.sleep(3000);
  await h.shot('19-restore.png', { crop: await h.pane(/q: close/), badges: await badges(h, [[1, /Removed earlier in this session/, -2], [2, /e: restore all/, -2]]) });
  await h.key('q', 1200);

  // wide
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  await h.key('z', 2500);
  await h.shot('20-wide.png');
});

// ---- B: asking Claude
await scene('B', {}, async (h) => {
  const { t } = h;
  for (const k of ['bug', 'rate', 'log']) await h.turn(k);
  await h.turn('cleanup');
  await t.sleep(1500);
  await h.shot('21-claude-stages.png', { badges: await badges(h, [[1, /ctxtree - map|ctxtree.*map/, -2], [2, /ctxtree - stage|ctxtree.*stage/, -2], [3, /ctxtree · \d+ staged/, -2, true]]) });
  await h.key('2', 3000);
  await h.shot('22-claude-review.png', { crop: await h.pane(/q: close/), badges: await badges(h, [[1, /by Claude/, -2]]) });
  await h.key('a', 5000);
  await h.shot('23-claude-applied.png', { badges: await badges(h, [[1, /cleanup discussion/, -2, true]]) });
});

// ---- C: Apply while Claude is working
await scene('C', {}, async (h) => {
  const { t } = h;
  await h.turn('bug');
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1500);
  await h.key('2', 1200);
  await h.click(/▸ Tool results/); await h.key('l', 1200);
  await h.click(/▸ Bash /); await h.key(' ', 1500);
  await h.key('\x1b', 900);
  await h.cmd(PROMPTS.slow); await t.sleep(1500);
  await h.key('2', 2500);
  await h.key('a', 2000);
  await h.shot('24-queued.png', { badges: await badges(h, [[1, /applies when the turn ends/, -2], [2, /applying when Claude finishes/, -2, true]]) });
  await t.waitFor(/Changelog/, 30000); await t.sleep(6000);
  await h.shot('25-queued-done.png', { badges: await badges(h, [[1, /applied ·|Conversation compacted/, -2, true]]) });
});

// ---- D: a narrow terminal
await scene('D', { cols: 150, rows: 48 }, async (h) => {
  const { t } = h;
  await h.turn('bug'); await h.turn('rate');
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(1800);
  await h.shot('26-narrow.png', { crop: await h.pane() });
  await h.key('i', 1500);
  await h.shot('27-narrow-details.png', { crop: await h.pane() });
});

// ---- E: the classic layout (switched with /tui default, which takes effect on
// the next launch and asks for feedback first)
await scene('E', { cols: 160, rows: 40 }, async (h) => {
  await h.cmd('/tui default'); await h.t.sleep(3000);
  h.t.send('\x1b'); await h.t.sleep(1500);
  await h.t.close();
  const t = h.sb.interactive({ args: [...PLUGINS, ...ALLOWED], cols: 160, rows: 40, fullscreen: false });
  h.t = t;
  await t.waitFor(/for shortcuts/, 45000); await t.sleep(800);
  await h.cmd(PROMPTS.bug); await t.waitFor(DONE.bug, 60000); await t.sleep(1000);
  await h.cmd('/ctxtree'); await t.waitFor(/needs the fullscreen layout/, 20000); await t.sleep(1000);
  const s = await t.screen();
  const y = s.findIndex(l => /ctxtree: ~/.test(l));
  await h.shot('28-classic.png', { crop: { x0: 0, y0: Math.max(0, y - 3), x1: 120, y1: Math.min(40, y + 12) } });
});

// ---- F: 256 colours (vTower's default environment)
await scene('F', { env: { TERM: 'xterm-color', COLORTERM: '' } }, async (h) => {
  const { t } = h;
  for (const k of ['bug', 'rate', 'log']) await h.turn(k);
  await h.cmd('/ctxtree'); await t.waitFor(/By task/, 20000); await t.sleep(2000);
  const s = await t.screen();
  const top = s.findIndex(l => l.includes('▀▀▀▀▀▀'));
  const pane = await h.pane();
  await h.shot('29-colors-256.png', { crop: { x0: pane.x0, y0: top - 1, x1: pane.x1, y1: pane.y1 - 3 } });
});

await chrome.close();
