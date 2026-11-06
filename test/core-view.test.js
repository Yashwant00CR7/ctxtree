// The pane's data: visible rows with marks, and the treemap as Raster cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLive } from '../plugins/ctxtree/core/live.js';
import { buildMap } from '../plugins/ctxtree/core/map.js';
import { flatten, windowOf, index, actKey, actsUnder, markState } from '../plugins/ctxtree/core/view.js';
import { layout, paint, hitTest, cellsBase64, colorPairs, assignColors, HALF } from '../plugins/ctxtree/core/treemap.js';

// A session with many tools and turns, so the map has depth and variety.
function bigSession(turns = 40) {
  const ms = [];
  const tools = ['Read', 'Bash', 'Grep', 'Edit', 'WebFetch', 'mcp__github__get_file', 'Glob', 'Write'];
  for (let t = 0; t < turns; t++) {
    ms.push({ role: 'user', text: `task number ${t}: please handle part ${t} of the work`, toolUses: [] });
    for (let k = 0; k < 3; k++) {
      const id = `toolu_${t}_${k}`, tool = tools[(t + k) % tools.length];
      ms.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input: { file_path: `/p/src/file${t}_${k}.js`, command: `run ${t} ${k}` } }] });
      ms.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'output '.repeat(50 + ((t * 37 + k * 11) % 400)), isError: k === 2 && t % 7 === 0 }] });
    }
    ms.push({ role: 'assistant', text: `Finished part ${t}. `.repeat(5), toolUses: [] });
  }
  return ms;
}
const tok = (c) => Math.max(1, Math.round(c / 4));

test('rows: top level, expansion, sort, filter, windows', () => {
  const map = buildMap(parseLive(bigSession(5)), { tok });
  const root = map.tree;
  const top = flatten(root);
  assert.deepEqual(top.map(r => r.name), ['Tool results', 'Conversation']);
  assert.ok(top.every(r => r.depth === 0 && r.kids && !r.open));
  const open = flatten(root, { expanded: new Set(['g:results']) });
  assert.ok(open.length > top.length && open[1].depth === 1);
  // by size, children are biggest first
  const kids = open.filter(r => r.depth === 1);
  for (let i = 1; i < kids.length; i++) assert.ok(kids[i - 1].tok >= kids[i].tok);
  // a filter opens the path to every match
  const f = flatten(root, { filter: 'file3_1' });
  assert.ok(f.some(r => r.name.includes('file3_1')));
  assert.ok(f.every(r => r.name.includes('file3_1') || r.kids));
  // a window keeps the selection in view
  const big = buildMap(parseLive(bigSession(12)), { tok });
  const all = flatten(big.tasks, { expanded: new Set(index(big.tasks).byId.keys()) });
  assert.ok(all.length > 40);
  const w = windowOf(all, all[30].id, 10, 0);
  assert.equal(w.rows.length, 10);
  assert.ok(w.top <= 30 && 30 < w.top + 10);
});

test('marks roll up from actions to groups', () => {
  const map = buildMap(parseLive(bigSession(3)), { tok });
  const tasks = map.tasks;
  const task = tasks.kids.find(k => k.t === 'task' && k.id.startsWith('g:task:'));
  const acts = actsUnder(task);
  assert.ok(acts.length >= 3);
  const marks = new Set([actKey(acts[0].act)]);
  assert.equal(markState(task, marks), 'some');
  for (const { act } of acts) marks.add(actKey(act));
  assert.equal(markState(task, marks), 'all');
  const row = flatten(tasks, { marks }).find(r => r.id === task.id);
  assert.equal(row.mark, 'all');
  assert.ok(row.save > 0);
});

test('treemap: cells, labels, hit test, colour budget', () => {
  const map = buildMap(parseLive(bigSession(40)), { tok });
  const root = map.tree;
  const colors = assignColors(root);
  const cols = 120, rows = 30;
  const L = layout(root, cols, rows);
  assert.ok(L.leaves.length > 50);
  const cells = paint(L, { colors, fmt: String });
  assert.equal(cells.length, cols * rows * 3);
  assert.ok(colorPairs(cells) <= 1024, `pairs ${colorPairs(cells)}`);
  // every code point is printable and one cell wide
  for (let i = 0; i < cells.length; i += 3) assert.ok(cells[i] === HALF || (cells[i] >= 0x20 && cells[i] < 0x2600), cells[i].toString(16));
  // a band label for "Tool results"
  const text = []; for (let r = 0; r < rows; r++) { let s = ''; for (let c = 0; c < cols; c++) { const cp = cells[(r * cols + c) * 3]; s += cp === HALF ? ' ' : String.fromCodePoint(cp); } text.push(s); }
  assert.ok(text.some(l => l.includes('Tool results') || l.includes('Read results') || l.includes('Bash results')), 'a group label is drawn');
  // a click lands on the leaf under it
  const leaf = L.leaves[0];
  const id = hitTest(L, Math.floor(leaf.x + leaf.w / 2), Math.floor((leaf.y + leaf.h / 2) / 2));
  assert.ok(id);
  // selection outline is white; base64 decodes to the same bytes
  const sel = paint(L, { colors, sel: leaf.n.id });
  assert.ok([...sel].some((v, i) => i % 3 !== 0 && v === 0xffffff));
  const b64 = cellsBase64(cells);
  assert.deepEqual(Buffer.from(b64, 'base64'), Buffer.from(cells.buffer));
});

test('treemap of an empty map is blank, not an error', () => {
  const L = layout(null, 40, 10);
  const cells = paint(L, {});
  assert.equal(cells.length, 40 * 10 * 3);
  assert.equal(hitTest(L, 3, 3), null);
});
