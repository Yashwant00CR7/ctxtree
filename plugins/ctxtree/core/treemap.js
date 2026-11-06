// The treemap as terminal cells: the web UI's squarified layout and van Wijk &
// van de Wetering cushions, drawn into a grid of `▀` half blocks (each cell is
// two vertical pixels: foreground on top, background below) for a `Raster`.
// Like the web UI's, every block keeps a dark seam on its right and bottom
// edge, so two neighbours of one colour read as two; the biggest blocks are
// drawn brightest and carry their size, so what is large shows at a glance.
//
// A Raster paints 1,024 distinct color pairs at once and snaps the rest, so the
// shading is quantized to a few levels per hue.
const HEAD = 2, CUSH_H = 0.5, CUSH_F = 0.75, LEVELS = 9;
const LX = -0.09759, LY = -0.19518, LZ = 0.9759, IA = 0.22, IS = 0.82;
const BG = 0x0b0d10, HEAD_BG = 0x15181d, HEAD_FG = 0xc9ced6, SEL = 0xffffff, HOVER = 0x9aa3ad, LABEL_FG = 0xf4f6f8;
// brightness by size: a block of half the largest's size or more, of a tenth
// or more, and the rest
const TIERS = [[0.5, 1.12], [0.1, 0.96], [0, 0.8]];
export const HALF = 0x2580;

// Fixed hues for the setup and conversation families; tool results take vivid
// colours in order of size, as in the web UI (and WizTree's extensions).
export const FIXED = {
  sys: 0x7b879c, tools: 0x5a8cf0, mcp: 0x8f6ef2, skill: 0xc56fdc, agent: 0x4bb4dc, md: 0x38bfa3,
  prompt: 0xe2b04c, reply: 0xd98a5a, call: 0xa98a62, image: 0xe47b9c, attach: 0x69717f, task: 0x55606f,
};
const VIVID = [0xf0664d, 0x4cb86e, 0x3fa4f2, 0xe9c440, 0xee5fa7, 0x9fcd3e, 0xff9b45, 0x2cc6d8, 0xb07cf7, 0xf3807a, 0x6fd3a8, 0xd6a35a];
const OTHER = 0x59606b;

// One colour per leaf type, the biggest result types first.
export function assignColors(root) {
  const sizes = new Map();
  const walk = (n) => { if (n.kids) return n.kids.forEach(walk); if (String(n.t).startsWith('r:')) sizes.set(n.t, (sizes.get(n.t) || 0) + (n.tok || 0)); };
  if (root) walk(root);
  const colors = { ...FIXED };
  [...sizes].sort((a, b) => b[1] - a[1]).forEach(([t], i) => { colors[t] = VIVID[i % VIVID.length]; });
  return colors;
}
export const colorOf = (colors, t) => colors[t] ?? OTHER;

function worst(row, side) {
  let sum = 0, mx = 0, mn = Infinity;
  for (const r of row) { sum += r.a; if (r.a > mx) mx = r.a; if (r.a < mn) mn = r.a; }
  const s2 = side * side, q = sum * sum;
  return Math.max((s2 * mx) / q, q / (s2 * mn));
}
function squarify(items, x, y, w, h, out) {
  const total = items.reduce((a, i) => a + i.v, 0);
  if (!total || w <= 0 || h <= 0) return;
  const scale = (w * h) / total;
  let rest = items.map(i => ({ n: i.n, a: i.v * scale }));
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [], best = Infinity;
    for (const it of rest) {
      const cand = row.concat(it);
      const wr = worst(cand, side);
      if (row.length && wr > best) break;
      row = cand; best = wr;
    }
    const area = row.reduce((a, r) => a + r.a, 0);
    if (w >= h) {
      const cw = area / h; let cy = y;
      for (const r of row) { const rh = r.a / cw; out.push({ n: r.n, x, y: cy, w: cw, h: rh }); cy += rh; }
      x += cw; w -= cw;
    } else {
      const rh = area / w; let cx = x;
      for (const r of row) { const rw = r.a / rh; out.push({ n: r.n, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
    rest = rest.slice(row.length);
  }
}
function ridge(s, x, y, w, h, hh) {
  const o = s.slice();
  if (w > 0) { o[0] += (4 * hh * (2 * x + w)) / w; o[2] -= (4 * hh) / w; }
  if (h > 0) { o[1] += (4 * hh * (2 * y + h)) / h; o[3] -= (4 * hh) / h; }
  return o;
}
function layoutNode(n, x, y, w, h, depth, s, out) {
  if (w < 0.5 || h < 0.5) return;
  const surf = ridge(s, x, y, w, h, CUSH_H * Math.pow(CUSH_F, depth));
  if (!n.kids || !n.kids.length) { out.leaves.push({ n, x, y, w, h, s: surf }); return; }
  out.groups.push({ n, x, y, w, h });
  let cy = y, ch = h;
  // a label band for groups big enough to carry one (one cell row)
  if (depth > 0 && w >= 14 && h >= HEAD * 3) { out.heads.push({ n, x, y, w, h: HEAD }); cy += HEAD; ch -= HEAD; }
  const items = n.kids.filter(k => k.tok > 0).sort((a, b) => b.tok - a.tok).map(k => ({ n: k, v: k.tok }));
  const rects = [];
  squarify(items, x, cy, w, ch, rects);
  for (const r of rects) layoutNode(r.n, r.x, r.y, r.w, r.h, depth + 1, surf, out);
}

// Layout in pixels: `columns` wide, `rows * 2` tall.
export function layout(root, columns, rows) {
  const out = { leaves: [], heads: [], groups: [], W: columns, H: rows * 2 };
  if (root && root.tok > 0 && columns > 0 && rows > 0) layoutNode(root, 0, 0, columns, rows * 2, 0, [0, 0, 0, 0], out);
  return out;
}

const scaleRgb = (c, f) => {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f)), g = Math.min(255, Math.round(((c >> 8) & 255) * f)), b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
};

// A label character a terminal draws one cell wide.
const safeChar = (cp) => ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp < 0x250) || cp === 0x2026 || cp === 0x203a || (cp >= 0x2500 && cp < 0x25a0) ? cp : 0xb7);

// Cells for a Raster: [codePoint, fg, bg] per cell, row-major.
export function paint(L, { colors = {}, sel = null, hover = null, marked = new Set(), dimExcept = null, fmt = (n) => String(n) } = {}) {
  const { W, H } = L, rows = H >> 1;
  const px = new Uint32Array(W * H).fill(BG);
  const top = L.leaves.reduce((m, R) => Math.max(m, R.n.tok || 0), 0) || 1;
  const tier = (n) => { const f = (n.tok || 0) / top; for (const [at, k] of TIERS) if (f >= at) return k; return 1; };
  const shade = new Map(); // quantized colour cache per (base, level)
  const lit = (base, I) => {
    const q = Math.round(I * LEVELS);
    const k = base * 16 + q;
    let v = shade.get(k);
    if (v === undefined) { v = scaleRgb(base, q / LEVELS); shade.set(k, v); }
    return v;
  };
  for (const R of L.leaves) {
    let base = scaleRgb(colorOf(colors, R.n.t), tier(R.n));
    if (dimExcept && R.n.t !== dimExcept) base = scaleRgb(base, 0.35);
    const hatch = marked.has(R.n.id);
    const x0 = Math.max(0, Math.round(R.x)), y0 = Math.max(0, Math.round(R.y));
    // the seam: a column on the right, a pixel row at the bottom (not on a
    // sliver, which would vanish)
    let x1 = Math.min(W, Math.round(R.x + R.w)), y1 = Math.min(H, Math.round(R.y + R.h));
    if (x1 - x0 >= 3) x1--;
    if (y1 - y0 >= 3) y1--;
    const s = R.s;
    for (let y = y0; y < y1; y++) {
      const ny = -(2 * s[3] * (y + 0.5) + s[1]);
      for (let x = x0; x < x1; x++) {
        const nx = -(2 * s[2] * (x + 0.5) + s[0]);
        const cos = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
        let I = IA + (cos > 0 ? IS * cos : 0);
        if (hatch && (x + y) % 4 === 0) I *= 0.4;
        px[y * W + x] = lit(base, I);
      }
    }
  }
  // the outlines: the block under the pointer, then the selection over it
  const outline = (id, c) => {
    const R = id && (L.leaves.find(r => r.n.id === id) || L.groups.find(r => r.n.id === id));
    if (!R) return;
    const x0 = Math.max(0, Math.round(R.x)), x1 = Math.min(W, Math.round(R.x + R.w)) - 1;
    const y0 = Math.max(0, Math.round(R.y)), y1 = Math.min(H, Math.round(R.y + R.h)) - 1;
    for (let x = x0; x <= x1; x++) { px[y0 * W + x] = c; px[y1 * W + x] = c; }
    for (let y = y0; y <= y1; y++) { px[y * W + x0] = c; px[y * W + x1] = c; }
  };
  if (hover !== sel) outline(hover, HOVER);
  outline(sel, SEL);
  const cells = new Uint32Array(W * rows * 3);
  for (let r = 0; r < rows; r++) for (let c = 0; c < W; c++) {
    const i = (r * W + c) * 3;
    cells[i] = HALF; cells[i + 1] = px[(2 * r) * W + c]; cells[i + 2] = px[(2 * r + 1) * W + c];
  }
  const text = (r, c0, maxW, str, fg, bg) => {
    if (r < 0 || r >= rows) return;
    let c = c0;
    for (const ch of str) {
      if (c >= c0 + maxW || c >= W) break;
      const i = (r * W + c) * 3;
      cells[i] = safeChar(ch.codePointAt(0)); cells[i + 1] = fg; cells[i + 2] = bg;
      c++;
    }
  };
  for (const hd of L.heads) {
    const r = Math.round(hd.y / 2), c0 = Math.round(hd.x), w = Math.round(hd.w);
    for (let c = c0; c < Math.min(W, c0 + w); c++) { const i = (r * W + c) * 3; if (r < rows) { cells[i] = 0x20; cells[i + 1] = HEAD_FG; cells[i + 2] = HEAD_BG; } }
    text(r, c0 + 1, w - 2, `${hd.n.name}  ${fmt(hd.n.tok)}`, HEAD_FG, HEAD_BG);
  }
  // labels: the name, then the size below it; a block too small for a name
  // still says how big it is
  const label = (r, c0, w, str, R) => {
    if (r >= rows || w < 1) return;
    let bg = cells[(r * W + Math.min(W - 1, c0)) * 3 + 1];
    if (bg === SEL || bg === HOVER || bg === BG) bg = scaleRgb(colorOf(colors, R.n.t), 0.45); // on an outline or a seam: keep it readable
    text(r, c0, w, str, LABEL_FG, bg);
  };
  for (const R of L.leaves) {
    const w = Math.round(R.w) - 2, r = Math.ceil(R.y / 2), c0 = Math.round(R.x) + 1;
    const size = fmt(R.n.tok || 0);
    if (R.h < 4 || w < Math.min(4, size.length)) continue;
    if (w >= 10 && R.h >= 6) { label(r, c0, w, R.n.name, R); label(r + 1, c0, w, size, R); }
    else if (w >= 10) label(r, c0, w, `${size} ${R.n.name}`, R);
    else label(r, c0, w, size, R);
  }
  return cells;
}

// The deepest node under a cell (clicks arrive in cells; layout is in pixels).
export function hitTest(L, col, row) {
  const x = col + 0.5, y = row * 2 + 1;
  const inside = (R) => x >= R.x && x < R.x + R.w && y >= R.y && y < R.y + R.h;
  const leaf = L.leaves.find(inside);
  if (leaf) return leaf.n.id;
  let best = null;
  for (const g of L.groups) if (inside(g)) best = g;
  return best ? best.n.id : null;
}

// How many distinct colour pairs the cells use (the Raster's budget is 1,024).
export function colorPairs(cells) {
  const s = new Set();
  for (let i = 0; i < cells.length; i += 3) s.add(cells[i + 1] * 0x1000000 + cells[i + 2]);
  return s.size;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Standard padded base64 of the cells' little-endian bytes (what Raster takes).
export function cellsBase64(cells) {
  const b = new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength);
  let out = '';
  const chunk = [];
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk.push(B64[(n >> 18) & 63], B64[(n >> 12) & 63], i + 1 < b.length ? B64[(n >> 6) & 63] : '=', i + 2 < b.length ? B64[n & 63] : '=');
    if (chunk.length >= 8192) { out += chunk.join(''); chunk.length = 0; }
  }
  return out + chunk.join('');
}
