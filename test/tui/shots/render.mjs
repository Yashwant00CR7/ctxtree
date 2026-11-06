// A captured terminal screen (test/tui/tty.mjs capture()) as an HTML page that
// looks like the terminal: every cell placed on a fixed grid, half blocks drawn
// as two exact pixels, optional numbered callouts and highlight boxes.

const DEFAULT_FG = '#d7dae0', DEFAULT_BG = '#101216';
// xterm's 16 ANSI colours (a neutral dark theme), then the 6x6x6 cube and greys.
const ANSI = ['#1b1d23', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
  '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7cc5ff', '#df9cf3', '#7fe0ea', '#ffffff'];
function palette(n) {
  if (n < 16) return ANSI[n];
  if (n < 232) { const i = n - 16, l = [0, 95, 135, 175, 215, 255]; const r = l[Math.floor(i / 36)], g = l[Math.floor(i / 6) % 6], b = l[i % 6]; return `rgb(${r},${g},${b})`; }
  const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`;
}
const col = (c, def) => (c == null ? def : String(c).startsWith('p') ? palette(Number(String(c).slice(1))) : c);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function screenHtml(cap, opts = {}) {
  const { x0 = 0, y0 = 0, x1 = cap.cols, y1 = cap.rows, title = 'claude', cw = 8, ch = 17, font = 13, badges = [], boxes = [], frame = true } = opts;
  const W = (x1 - x0) * cw, H = (y1 - y0) * ch, bar = frame ? 30 : 0, pad = frame ? 10 : 0;
  const bgs = [], glyphs = [];
  for (let y = y0; y < y1; y++) {
    const row = cap.cells[y] || [];
    let run = null;
    const flush = () => { if (run && run.bg !== DEFAULT_BG) bgs.push(`<div style="left:${(run.x - x0) * cw}px;top:${(y - y0) * ch}px;width:${run.n * cw}px;height:${ch}px;background:${run.bg}"></div>`); run = null; };
    for (let x = x0; x < x1; x++) {
      const c = row[x] || { ch: ' ', w: 1 };
      let fg = col(c.fg, DEFAULT_FG), bg = col(c.bg, DEFAULT_BG);
      if (c.v) [fg, bg] = [bg, fg];
      if (run && run.bg === bg) run.n++; else { flush(); run = { x, bg, n: 1 }; }
      if (c.w === 0) continue;
      const g = c.ch;
      const left = (x - x0) * cw, top = (y - y0) * ch, w = cw * (c.w || 1);
      if (g === '▀' || g === '▄') {
        const [a, b] = g === '▀' ? [fg, bg] : [bg, fg];
        glyphs.push(`<div style="left:${left}px;top:${top}px;width:${w}px;height:${ch}px;background:linear-gradient(${a} 50%, ${b} 50%)"></div>`);
      } else if (g === '█') {
        glyphs.push(`<div style="left:${left}px;top:${top}px;width:${w}px;height:${ch}px;background:${fg}"></div>`);
      } else if (g !== ' ') {
        const deco = [c.u ? 'underline' : '', c.s ? 'line-through' : ''].filter(Boolean).join(' ');
        const style = [`left:${left}px`, `top:${top}px`, `width:${w}px`, `color:${fg}`, c.b ? 'font-weight:700' : '', c.i ? 'font-style:italic' : '', c.d ? 'opacity:.55' : '', deco ? `text-decoration:${deco}` : ''].filter(Boolean).join(';');
        glyphs.push(`<span style="${style}">${esc(g)}</span>`);
      }
    }
    flush();
  }
  const overlay = [
    ...boxes.map(b => `<div class="box" style="left:${(b.x0 - x0) * cw - 2}px;top:${(b.y0 - y0) * ch - 2}px;width:${(b.x1 - b.x0) * cw + 2}px;height:${(b.y1 - b.y0) * ch + 2}px"></div>`),
    // A numbered callout: an outline around the text it points at (nothing
    // hidden) and the number on its top-left corner.
    ...badges.flatMap(b => {
      const left = (b.x - x0) * cw, top = (b.y - y0) * ch, w = Math.max(2, b.w || 2) * cw;
      return [
        `<div class="mark" style="left:${left - 3}px;top:${top - 1}px;width:${w + 6}px;height:${ch + 2}px"></div>`,
        `<div class="badge" style="left:${Math.max(0, left - 12)}px;top:${Math.max(0, top - 11)}px">${esc(String(b.n))}</div>`,
      ];
    }),
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#2a2d34;width:${W + pad * 2 + 24}px;height:${H + bar + pad * 2 + 24}px;padding:12px}
  .win{background:${DEFAULT_BG};border-radius:10px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.45);width:${W + pad * 2}px}
  .bar{height:${bar}px;background:#1d2026;display:flex;align-items:center;padding:0 12px;gap:8px;font:12px -apple-system,Helvetica,sans-serif;color:#9aa1ad}
  .dot{width:12px;height:12px;border-radius:50%}
  .title{flex:1;text-align:center;margin-right:52px}
  .grid{position:relative;width:${W}px;height:${H}px;margin:${pad}px;font:${font}px/${ch}px Menlo,Monaco,monospace;color:${DEFAULT_FG}}
  .grid>div,.grid>span{position:absolute;white-space:pre;display:block}
  .grid>span{height:${ch}px;text-align:center;overflow:visible}
  .box{position:absolute;border:2px solid #ff4d6d;border-radius:4px;box-shadow:0 0 0 2px rgba(255,77,109,.25)}
  .badge{position:absolute;width:18px;height:18px;border-radius:50%;background:#ff4d6d;color:#fff;font:700 11px/18px -apple-system,Helvetica,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.6);z-index:2}
  .mark{position:absolute;border:2px solid #ff4d6d;border-radius:5px;z-index:1}
  </style></head><body><div class="win">${frame ? `<div class="bar"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div><div class="title">${esc(title)}</div></div>` : ''}
  <div class="grid">${bgs.join('')}${glyphs.join('')}${overlay.join('')}</div></div></body></html>`;
}

export function screenSize(cap, opts = {}) {
  const { x0 = 0, y0 = 0, x1 = cap.cols, y1 = cap.rows, cw = 8, ch = 17, frame = true } = opts;
  const bar = frame ? 30 : 0, pad = frame ? 10 : 0;
  return { width: (x1 - x0) * cw + pad * 2 + 24, height: (y1 - y0) * ch + bar + pad * 2 + 24 };
}
