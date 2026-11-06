// Drive an interactive program in a real pty and read its screen through xterm.js
// (the same emulator vTower uses).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function tty({ argv, cols = 170, rows = 50, env, cwd }) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const p = spawn('python3', [path.join(HERE, 'ptyproxy.py'), String(cols), String(rows), '--', ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let raw = Buffer.alloc(0), exited = null, err = '';
  p.stdout.on('data', d => { raw = Buffer.concat([raw, d]); term.write(d); });
  p.stderr.on('data', d => { err += d; });
  p.on('close', c => { exited = c; });
  // Answer terminal queries the way a real terminal would (DA1, DSR cursor position).
  term.onData(d => { try { p.stdin.write(d); } catch {} });
  const flush = () => new Promise(r => term.write('', r));
  const screen = async () => {
    await flush();
    const b = term.buffer.active, out = [];
    for (let y = 0; y < rows; y++) out.push((b.getLine(b.viewportY + y)?.translateToString(true)) ?? '');
    return out;
  };
  const cell = async (x, y) => {
    await flush();
    const b = term.buffer.active, c = b.getLine(b.viewportY + y)?.getCell(x);
    if (!c) return null;
    return { ch: c.getChars(), fg: c.isFgRGB() ? c.getFgColor() : c.isFgDefault() ? 'default' : 'p' + c.getFgColor(), bg: c.isBgRGB() ? c.getBgColor() : c.isBgDefault() ? 'default' : 'p' + c.getBgColor() };
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return {
    term, screen, cell, sleep,
    get raw() { return raw; }, get exited() { return exited; }, get stderr() { return err; },
    send(s) { p.stdin.write(s); },
    async type(s, gap = 25) { for (const ch of s) { p.stdin.write(ch); await sleep(gap); } },
    // SGR mouse, 0-based cell coordinates. button: 0 left, 1 middle, 2 right
    async click(x, y, button = 0) { p.stdin.write(`\x1b[<${button};${x + 1};${y + 1}M`); await sleep(30); p.stdin.write(`\x1b[<${button};${x + 1};${y + 1}m`); },
    move(x, y) { p.stdin.write(`\x1b[<35;${x + 1};${y + 1}M`); },
    wheel(x, y, down = true) { p.stdin.write(`\x1b[<${down ? 65 : 64};${x + 1};${y + 1}M`); },
    async waitFor(re, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = (await screen()).join('\n');
        if (re.test(s)) return s;
        if (exited !== null) break;
        await sleep(150);
      }
      throw new Error(`waitFor ${re} timed out. Screen:\n${(await screen()).join('\n')}\nstderr: ${err.slice(-500)}`);
    },
    // Every cell with its colours and attributes, for screenshots.
    async capture() {
      await flush();
      const b = term.buffer.active, out = [];
      const color = (c, fg) => {
        const rgb = fg ? c.isFgRGB() : c.isBgRGB(), def = fg ? c.isFgDefault() : c.isBgDefault();
        const v = fg ? c.getFgColor() : c.getBgColor();
        if (def) return null;
        if (rgb) return '#' + v.toString(16).padStart(6, '0');
        return 'p' + v;
      };
      for (let y = 0; y < rows; y++) {
        const line = b.getLine(b.viewportY + y), row = [];
        for (let x = 0; x < cols; x++) {
          const c = line && line.getCell(x);
          if (!c) { row.push({ ch: ' ', w: 1 }); continue; }
          row.push({
            ch: c.getChars() || ' ', w: c.getWidth(), fg: color(c, true), bg: color(c, false),
            b: c.isBold() ? 1 : 0, d: c.isDim() ? 1 : 0, i: c.isItalic() ? 1 : 0, u: c.isUnderline() ? 1 : 0,
            s: c.isStrikethrough() ? 1 : 0, v: c.isInverse() ? 1 : 0,
          });
        }
        out.push(row);
      }
      return { cols, rows, cells: out };
    },
    // Rows drawn with the inverse attribute (the selected tree row), as text.
    async inverse() {
      await flush();
      const b = term.buffer.active, out = [];
      for (let y = 0; y < rows; y++) {
        const line = b.getLine(b.viewportY + y); if (!line) continue;
        let txt = '', inv = 0;
        for (let x = 0; x < cols; x++) { const c = line.getCell(x); if (c && c.isInverse()) { inv++; txt += c.getChars() || ' '; } }
        if (inv > 10) out.push(txt.trim());
      }
      return out;
    },
    async find(re) { const s = await screen(); for (let y = 0; y < s.length; y++) { const m = re.exec(s[y]); if (m) return { x: m.index, y, text: m[0] }; } return null; },
    async close() { try { p.stdin.end(); } catch {} for (let i = 0; i < 30 && exited === null; i++) await sleep(100); if (exited === null) p.kill('SIGKILL'); },
  };
}
