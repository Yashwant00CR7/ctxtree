// A small transcript with every shape the fork engine has to survive, each one
// observed in real Claude Code sessions:
//   - one API response split across records sharing message.id, usage repeated
//   - a signed thinking block with text
//   - a compaction (compact_boundary with parentUuid:null) -> earlier content is
//     not in the resumed context
//   - a rewind: an abandoned branch that is not on the resumed chain
//   - a tool_result carrying an image, and one with a structured toolUseResult
//   - user content as a plain string
//   - a record inherited from an earlier session (different sessionId)
//   - optionally a blank line and an unparseable line in the middle
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BIG = 'const x = 1;\n'.repeat(4000);          // ~52k chars of file content
export const PROJECT = '-tmp-ctxtree-fixture';

export function makeFixture(claudeDir, { blank = false, bad = false, cwd = '/tmp/ctxtree-fixture' } = {}) {
  const sid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const dir = path.join(claudeDir, 'projects', PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: sid, cwd, version: '2.0.0', gitBranch: 'main', userType: 'external' };
  const usage = (n) => ({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: n, output_tokens: 50 });
  const ts = (i) => new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString();

  const recs = [
    { type: 'permission-mode', permissionMode: 'default', sessionId: sid },
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: ts(1), message: { role: 'user', content: 'Please read the big file and summarise it.' } },
    { ...base, type: 'attachment', uuid: 'a1', parentUuid: 'u1', timestamp: ts(2), attachment: { type: 'skill_listing', content: '- skill: does things', skillCount: 1 } },
    { ...base, type: 'assistant', uuid: 't1', parentUuid: 'a1', timestamp: ts(3), message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'thinking', thinking: 'I should read the file first.', signature: 'SIG_ABC' }], usage: usage(1000) } },
    { ...base, type: 'assistant', uuid: 'tu1', parentUuid: 't1', timestamp: ts(4), message: { id: 'msg_1', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: '/tmp/big.js' } }], usage: usage(1000) } },
    { ...base, type: 'user', uuid: 'r1', parentUuid: 'tu1', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read1', content: BIG }] }, toolUseResult: { type: 'text', file: { filePath: '/tmp/big.js', content: BIG, numLines: 4000 } } },
    { ...base, sessionId: other, type: 'assistant', uuid: 'x1', parentUuid: 'r1', timestamp: ts(6), message: { id: 'msg_2', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'It declares x four thousand times.' }], usage: usage(15000) } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'x1', sessionId: sid, timestamp: ts(7), content: 'Conversation compacted' },
    { ...base, type: 'user', uuid: 's1', parentUuid: 'cb', isCompactSummary: true, timestamp: ts(8), message: { role: 'user', content: 'Summary: the user asked to read big.js; it declares x.' } },
    // abandoned branch (rewound away from)
    { ...base, type: 'assistant', uuid: 'tu2', parentUuid: 's1', timestamp: ts(9), message: { id: 'msg_3', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'Screenshot', input: {} }], usage: usage(2000) } },
    { ...base, type: 'user', uuid: 'r2', parentUuid: 'tu2', timestamp: ts(10), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } },
    { ...base, type: 'assistant', uuid: 'x2', parentUuid: 'r2', timestamp: ts(11), message: { id: 'msg_4', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'The screenshot shows a login page.' }], usage: usage(3000) } },
    // live branch
    { ...base, type: 'user', uuid: 'u3', parentUuid: 's1', timestamp: ts(12), message: { role: 'user', content: 'Actually, read it again and count the lines.' } },
    { ...base, type: 'assistant', uuid: 'tu3', parentUuid: 'u3', timestamp: ts(13), message: { id: 'msg_5', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_read2', name: 'Read', input: { file_path: '/tmp/big.js' } }], usage: usage(2500) } },
    { ...base, type: 'user', uuid: 'r3', parentUuid: 'tu3', timestamp: ts(14), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read2', content: BIG }] }, toolUseResult: { type: 'text', file: { filePath: '/tmp/big.js', content: BIG, numLines: 4000 } } },
    { ...base, type: 'assistant', uuid: 'x3', parentUuid: 'r3', timestamp: ts(15), message: { id: 'msg_6', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'It has 4000 lines.' }], usage: usage(16000) } },
  ];

  const lines = recs.map(r => JSON.stringify(r));
  if (blank) lines.splice(3, 0, '');                 // before t1
  if (bad) lines.splice(6, 0, '{this is not json');   // in the middle
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });

  const hist = path.join(claudeDir, 'file-history', sid);
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 'abc123@v1'), 'backup contents');

  return { sid, other, file, dir, cwd, session: { sid, file, project: PROJECT, cwd } };
}

export const bid = (uuid, c = 0) => `b_${uuid}_${c}`;
