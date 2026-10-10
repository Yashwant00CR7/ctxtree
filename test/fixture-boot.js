// A transcript shaped like Claude Code 2.1.28x writes them, with every structure
// the boot and structural operations touch:
//   - boot attachments carrying `rendered` (the exact text sent): MCP
//     instructions, deferred tool names, a skill listing with a plugin skill, an
//     agent listing, CLAUDE.md + auto memory, and a prompt_snapshot
//   - a prompt_snapshot written AFTER the last message, chained to it
//   - parallel tool calls whose first result hangs off the chain
//   - a compaction with a preserved segment, and its re-announcement burst
//   - a rewind branch
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROJECT = '-tmp-ctxtree-boot';
const SR = (t) => `<system-reminder>\n${t}\n</system-reminder>`;

export const MCP_A = 'INSTRUCTIONS FOR alpha: ' + 'be careful. '.repeat(20);
export const MCP_B = 'INSTRUCTIONS FOR beta: ' + 'be tidy. '.repeat(20);
export const SKILLS = [
  '- keep-skill: Keeps things. ' + 'detail '.repeat(10),
  '- drop-skill: Drops things. ' + 'detail '.repeat(10) + '\nTRIGGER when dropping.',
  '- plug:inner-skill: A plugin skill. ' + 'detail '.repeat(10),
];
export const AGENTS = ['- general: Does anything. (Tools: *)', '- Plan: Plans things. (Tools: Read)'];
export const MD_USER = '# user\nUSER MD ' + 'pref. '.repeat(30);
export const MD_PROJ = '# project\nPROJECT MD ' + 'rule. '.repeat(30);
export const MD_MEM = '- [fact](f.md) MEMORY ' + 'remembered. '.repeat(10);
export const SYS = ['\nYou are an agent.\n', '# Tone and style\n' + 'Be concise. '.repeat(30), '# Environment\ncwd: /tmp/x\n'];
export const TOOLS = [
  { name: 'Bash', description: 'Run shell. '.repeat(20), schema: { type: 'object' } },
  { name: 'WebFetch', description: 'Fetch url. '.repeat(20), schema: { type: 'object' } },
];
export const DEFERRED = ['CronCreate', 'mcp__alpha__search', 'mcp__alpha__fetch', 'mcp__beta__do'];

export function makeBootFixture(claudeDir, { cwd = '/tmp/ctxtree-boot' } = {}) {
  const sid = crypto.randomUUID();
  const dir = path.join(claudeDir, 'projects', PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: sid, cwd, version: '2.1.283', gitBranch: 'main', userType: 'external', isSidechain: false };
  const ts = (i) => new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString();
  const usage = (n) => ({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: n, output_tokens: 20 });
  let n = 0;
  const recs = [];
  let parent = null;
  const push = (r) => { const rec = { ...base, uuid: r.uuid || `r${++n}`, parentUuid: r.parentUuid !== undefined ? r.parentUuid : parent, timestamp: ts(recs.length), ...r }; recs.push(rec); parent = rec.uuid; return rec; };
  const att = (attachment, rendered) => push({ type: 'attachment', attachment, ...(rendered ? { rendered: [{ content: rendered }] } : {}) });
  const bootBurst = () => {
    att({ type: 'deferred_tools_delta', addedNames: DEFERRED, addedLines: DEFERRED, removedNames: [], surfacedNames: [] },
      SR(`The following deferred tools are now available via ToolSearch:\n${DEFERRED.join('\n')}`));
    att({ type: 'agent_listing_delta', addedTypes: ['general', 'Plan'], addedLines: AGENTS, removedTypes: [], isInitial: true },
      SR(`Available agent types for the Agent tool:\n${AGENTS.join('\n')}`));
    att({ type: 'mcp_instructions_delta', addedNames: ['alpha', 'beta'], addedBlocks: [`## alpha\n${MCP_A}`, `## beta\n${MCP_B}`], removedNames: [] },
      SR(`# MCP Server Instructions\n\nThe following MCP servers have provided instructions:\n\n## alpha\n${MCP_A}\n\n## beta\n${MCP_B}`));
    att({ type: 'skill_listing', content: SKILLS.join('\n'), skillCount: 3, isInitial: true, names: ['keep-skill', 'drop-skill', 'plug:inner-skill'] },
      SR(`The following skills are available for use with the Skill tool:\n\n${SKILLS.join('\n')}`));
    att({ type: 'instructions', files: [
      { path: '/home/u/.claude/CLAUDE.md', type: 'User', content: MD_USER },
      { path: `${cwd}/CLAUDE.md`, type: 'Project', content: MD_PROJ },
      { path: '/home/u/.claude/projects/x/memory/MEMORY.md', type: 'AutoMem', content: MD_MEM },
    ] }, SR(`Codebase and user instructions are shown below.\n\nContents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):\n\n${MD_USER}\n\nContents of ${cwd}/CLAUDE.md (project instructions, checked into the codebase):\n\n${MD_PROJ}\n\nContents of /home/u/.claude/projects/x/memory/MEMORY.md (user's auto-memory, persists across conversations):\n\n${MD_MEM}`));
    att({ type: 'prompt_snapshot', systemPrompt: SYS, reminderFold: false, contextRendering: 'announced' });
  };

  recs.push({ type: 'permission-mode', permissionMode: 'default', sessionId: sid });
  push({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Read two files for me. PRECOMPACT-PROMPT' } });
  bootBurst();
  // parallel tool calls: two records share one message id; each result is a child of its own call
  const t1 = push({ type: 'assistant', uuid: 'tu1', message: { id: 'msg_p', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } }], usage: usage(1000) } });
  push({ type: 'assistant', uuid: 'tu2', message: { id: 'msg_p', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/b' } }], usage: usage(1000) } });
  push({ type: 'user', uuid: 'rb', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'B'.repeat(3000) }] }, toolUseResult: 'B', sourceToolAssistantUUID: 'tu2' });
  recs.push({ ...base, type: 'user', uuid: 'ra', parentUuid: t1.uuid, timestamp: ts(99), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'A'.repeat(3000) }] }, toolUseResult: 'A', sourceToolAssistantUUID: 'tu1' });
  push({ type: 'assistant', uuid: 'x1', parentUuid: 'rb', message: { id: 'msg_x1', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Both read. PRESERVED-REPLY' }], usage: usage(4000) } });

  // compaction keeping x1 verbatim (preserved segment), then its re-announcement
  const B = push({ type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'x1', content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 9000, preservedSegment: { headUuid: 'x1', anchorUuid: 's1', tailUuid: 'x1' } } });
  push({ type: 'user', uuid: 's1', parentUuid: B.uuid, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: two files were read.' } });
  push({ type: 'user', uuid: 'c1', message: { role: 'user', content: '<local-command-caveat>Caveat: local commands.</local-command-caveat>' }, isMeta: true });
  push({ type: 'user', uuid: 'c2', message: { role: 'user', content: '<command-name>/compact</command-name>' } });
  push({ type: 'user', uuid: 'c3', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
  bootBurst();
  const beforeU2 = parent;
  push({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'Now summarise. BRANCH-A-PROMPT' } });
  push({ type: 'assistant', uuid: 'x2', message: { id: 'msg_x2', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Summary A. BRANCH-A' }], usage: usage(5000) } });
  // rewind to before u2, then a different prompt: the resumed branch
  push({ type: 'user', uuid: 'u3', parentUuid: beforeU2, message: { role: 'user', content: 'Actually do it differently. BRANCH-B' } });
  push({ type: 'assistant', uuid: 'x3', message: { id: 'msg_x3', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Different summary. BRANCH-B-REPLY' }], usage: usage(6000) } });
  // the snapshot Claude Code writes after the reply, chained to it
  att({ type: 'prompt_snapshot', systemPrompt: SYS, tools: TOOLS, cliPrefix: 'You are Claude Code.', contextRendering: 'announced' });
  recs.push({ type: 'last-prompt', lastPrompt: 'Actually do it differently.', leafUuid: parent, sessionId: sid });

  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  return { sid, file, dir, cwd, session: { sid, file, project: PROJECT, cwd } };
}
