import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-timeline-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const F = await import('./fixture.js');
const fx = F.makeFixture(CLAUDE);
const { build } = await import('../src/model.js');
const { contextMap, blockPreview, timeline } = await import('../src/map.js');
const { sliceText, PREVIEW_CHARS } = await import('../plugins/ctxtree/core/timeline.js');

const model = () => build(path.join(CLAUDE, 'projects'));
const task = (m) => m.tasks.kids.find(k => k.id.startsWith('g:task:'));

test('timeline: a task in the order it happened, its messages in full', () => {
  const md = model();
  const t = task(contextMap(md, fx.sid));
  const { entries } = timeline(md, fx.sid, t.id);
  assert.deepEqual(entries.map(e => e.kind), ['prompt', 'tool', 'reply']);
  assert.equal(entries[0].text, 'Actually, read it again and count the lines.');
  assert.equal(entries[2].text, 'It has 4000 lines.');
  // a tool call is one entry: what Claude sent, then what came back
  const tool = entries[1];
  assert.deepEqual(tool.parts.map(p => p.role), ['sent', 'got']);
  assert.equal(tool.parts[1].chars, F.BIG.length);
  assert.ok(tool.deletable);
  // entries are the tree's own leaves, so marks made from either agree
  assert.deepEqual(entries.map(e => e.id), [...t.kids].sort((a, b) => a.ord - b.ord).map(k => k.id));
  assert.throws(() => timeline(md, fx.sid, 'g:task:nope'), /No such task/);
});

test('block preview: the first 20,000 characters, then the rest on request', () => {
  const md = model();
  const { entries } = timeline(md, fx.sid, task(contextMap(md, fx.sid)).id);
  const got = entries[1].parts[1].id;
  const first = blockPreview(md, fx.sid, got);
  assert.equal(first.text.length, PREVIEW_CHARS);
  assert.ok(first.truncated);
  assert.equal(first.next, PREVIEW_CHARS);
  const rest = blockPreview(md, fx.sid, got, { offset: first.next, limit: Infinity });
  assert.equal(first.text + rest.text, F.BIG);
  assert.equal(rest.next, 0);
  assert.equal(blockPreview(md, fx.sid, got, { limit: Infinity }).text, F.BIG);
});

test('sliceText: clamps, and says where the rest starts', () => {
  assert.deepEqual(sliceText('abcdef', { offset: 2, limit: 3 }), { text: 'cde', chars: 6, offset: 2, next: 5, truncated: true });
  assert.deepEqual(sliceText('abc', { offset: 9 }), { text: '', chars: 3, offset: 3, next: 0, truncated: false });
});
