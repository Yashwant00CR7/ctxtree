// The shared core over a live conversation (core/live.js): Claude Code's
// message list parsed into the same map a transcript gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha1Hex } from '../plugins/ctxtree/core/sha1.js';
import { fingerprint } from '../plugins/ctxtree/core/session.js';
import { parseLive, addressOf, fromApi, NOTE_PREFIX } from '../plugins/ctxtree/core/live.js';
import { buildMap } from '../plugins/ctxtree/core/map.js';

const BIG = 'line of a big file\n'.repeat(300);
const WRITE_BODY = 'const x = 1;\n'.repeat(200);

// Shaped like `$.session.messages()` on 2.1.296: one entry per record, so a
// reply that wrote text and called a tool is two entries.
function session() {
  return [
    { role: 'user', text: 'read the big file please', toolUses: [] },
    { role: 'assistant', text: 'Reading it.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_read1', tool: 'Read', input: { file_path: '/p/big.txt' }, result: { huge: true }, text: BIG }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_read1', text: BIG, isError: false, result: { huge: true } }] },
    { role: 'assistant', text: 'It is a big file of repeated lines.', toolUses: [] },
    { role: 'user', text: 'now write the generated module', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_write1', tool: 'Write', input: { file_path: '/p/gen.js', content: WRITE_BODY } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_write1', text: 'File created successfully', isError: false }] },
    { role: 'assistant', text: 'Done writing gen.js.', toolUses: [] },
  ];
}
const withHandles = (ms) => ms.map((m, i) => ({ ...m, handle: `h${i}` }));
const tok = (chars) => Math.max(1, Math.round(chars / 4));
const blockOf = (parsed, pred) => parsed.blocks.find(pred);
const entry = (b, op, extra = {}) => ({ addr: addressOf(b), op, tok: tok(b.chars), save: tok(b.chars), name: b.target || b.text.slice(0, 20), ...extra });

test('fingerprints are SHA-1 in both runtimes', () => {
  for (const s of ['', 'abc', 'héllo 🌳', BIG]) assert.equal(sha1Hex(s), crypto.createHash('sha1').update(s).digest('hex'));
  assert.equal(fingerprint('abc'), crypto.createHash('sha1').update('abc').digest('hex').slice(0, 16));
});

test('the live conversation builds the same map shape as a transcript', () => {
  const parsed = parseLive(session());
  assert.equal(parsed.blocks.filter(b => b.blockType === 'tool_result').length, 2);
  assert.equal(parsed.turns, 4);
  const map = buildMap(parsed, { tok: (c) => tok(c) });
  const names = map.tree.kids.map(k => k.name);
  assert.ok(names.includes('Tool results') && names.includes('Conversation'));
  const tasks = map.tasks.kids.filter(k => k.t === 'task').map(k => k.name);
  assert.deepEqual(tasks.filter(n => n !== 'Start of the session'), ['read the big file please', 'now write the generated module']);
  // the Read result is the biggest deletable leaf
  const results = map.tree.kids.find(k => k.name === 'Tool results');
  assert.ok(results.tok > 1000);
});

test('compaction summaries and ctxtree notes are not tasks', () => {
  const ms = [
    { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context. Summary...', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: `${NOTE_PREFIX} the user removed 2 items]`, toolUses: [] },
    { role: 'user', text: 'fix the bug', toolUses: [] },
  ];
  const map = buildMap(parseLive(ms), { tok });
  const tasks = map.tasks.kids.filter(k => k.t === 'task' && k.id.startsWith('g:task:'));
  assert.deepEqual(tasks.map(t => t.name), ['fix the bug']);
});

test('images count at image size and are locked; image results can be dropped', () => {
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'look at this screenshot please' }, { type: 'image', source: { type: 'base64', data: 'x' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_png', name: 'Read', input: { file_path: '/p/a.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_png', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }] },
  ];
  const parsed = parseLive(fromApi(api));
  const img = parsed.blocks.find(b => b.blockType === 'image');
  assert.ok(img && !img.editable && /removed by any Apply/.test(img.lock));
  const res = parsed.blocks.find(b => b.blockType === 'tool_result');
  assert.equal(res.kind, 'image');
  assert.ok(res.editable);
  const map = buildMap(parsed, { tok: (c, k) => (k === 'image' ? 1200 : tok(c)) });
  assert.ok(map.tree.tok >= 2400);
});

