import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readerRows, wrap, clean, rowOf, clampTop } from '../plugins/ctxtree-ui/hooks/lines.js';

const entries = [
  { id: 'b_u1', kind: 'prompt', name: 'You: fix the login', tok: 30, turn: 1, text: 'fix the login bug\nplease', chars: 24, truncated: false, mark: '' },
  { id: 's:b_t1', kind: 'tool', name: 'Ran npm test', tok: 7200, turn: 2, mark: 'all',
    parts: [{ id: 'b_t1', role: 'sent', chars: 20, text: '{"command":"npm test"}' }, { id: 'b_r1', role: 'got', chars: 50000, text: 'ok 1\nok 2', next: 20000 }] },
  { id: 'b_x1', kind: 'reply', name: 'Claude: done', tok: 10, turn: 3, text: 'Done.', chars: 5, mark: '' },
  { id: 'a:1', kind: 'attach', name: '3 attachments: model, environment', tok: 40, turn: 0, count: 3 },
];

test('reader: messages in full, a closed tool call is one row', () => {
  const rows = readerRows({ head: [{ text: 'The task', style: 'title' }], entries, width: 40, open: [], cur: 1 });
  const text = rows.map(r => r.text);
  assert.deepEqual(text.slice(0, 2), ['The task', 'What happened · 4 items · 1 tool calls']);
  assert.ok(text.includes('  fix the login bug') && text.includes('  please'));
  const tool = rows.find(r => r.e === 1 && r.hdr);
  assert.equal(tool.text, '▸ Ran npm test · 7.2k  ✕ marked');
  assert.equal(tool.style, 'gone');
  assert.ok(tool.cur, 'the cursor sits on the header of entry 1');
  assert.ok(!text.some(t => t.includes('It got back')));
  assert.equal(rows.filter(r => r.hdr).length, 4, 'every entry has one row a click opens');
});

test('reader: an open tool call shows what was sent and what came back, and says when there is more', () => {
  const rows = readerRows({ entries, width: 40, open: ['s:b_t1'] }).map(r => r.text);
  const i = rows.indexOf('    Claude sent'), j = rows.indexOf('    It got back');
  assert.ok(i > 0 && j > i);
  assert.deepEqual(rows.slice(j + 1, j + 4), ['    ok 1', '    ok 2', '    … 30,000 more characters · a shows all']);
});

test('reader: wrapping, cleaning and the window', () => {
  assert.deepEqual(wrap('abcdefgh', 4), ['abcd', 'efgh']);
  assert.deepEqual(wrap('MCP servers, skills', 12), ['MCP servers,', 'skills']);
  assert.deepEqual(wrap('a\n\nb', 4), ['a', '', 'b']);
  assert.equal(clean('\x1b[31mred\x1b[0m\tx\r\ny'), 'red  x\ny');
  const rows = readerRows({ entries, width: 40 });
  assert.equal(rows[rowOf(rows, 2)].text, 'Claude · turn 3 · 10');
  assert.equal(clampTop(rows, 999, 3), rows.length - 3);
  assert.equal(clampTop(rows, -5, 3), 0);
});
