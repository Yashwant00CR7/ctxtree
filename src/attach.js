// Attachment records carry most of what people think of as "boot overhead":
// the system prompt, every tool schema, skill listings, MCP instructions and
// CLAUDE.md. They reach the model but live outside message.content, so anything
// that only reads message.content undercounts the context badly.

import { BOOT_SUB, serverKey, serverOfTool, listEntries, sysLabel } from './boot.js';

const len = (v) => {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((a, x) => a + len(x), 0);
  if (typeof v === 'object') return JSON.stringify(v).length;
  return String(v).length;
};

export const serverOf = (toolName = '') => serverOfTool(toolName) || null;

// A tool's node: its MCP server, or itself if built in.
const toolPart = (name, part, chars) => {
  const key = serverOfTool(name);
  return key ? { cat: 'boot', sub: BOOT_SUB.mcp, leaf: key, part, chars, n: 1, exact: true }
    : { cat: 'boot', sub: BOOT_SUB.tool, leaf: name, part, chars, n: 1, exact: true };
};
// Several tools on one server are one node, one part.
function mergeParts(parts) {
  const by = new Map();
  for (const p of parts) {
    const k = `${p.sub}|${p.leaf}|${p.part}`;
    const e = by.get(k);
    if (e) { e.chars += p.chars; e.n += p.n || 0; } else by.set(k, { ...p });
  }
  return [...by.values()];
}

// cat = top-level lever branch; sub/leaf = the node you would act on, laid out
// exactly as boot.js inventories it, so a node resolves to one removable item.
// `part` separates what one node carries (a server's instructions vs its tool
// names vs its schemas) so re-statements dedupe per part, never across parts.
export function extractAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const t = a.type;
  switch (t) {
    case 'prompt_snapshot': {
      const parts = [];
      for (const sec of a.systemPrompt || []) {
        if (typeof sec !== 'string' || !sec.trim()) continue;
        parts.push({ cat: 'boot', sub: BOOT_SUB.sys, leaf: sysLabel(sec), part: 'section', chars: sec.length, exact: true });
      }
      for (const tool of Array.isArray(a.tools) ? a.tools : []) {
        if (tool && tool.name) parts.push(toolPart(tool.name, 'inline schema', len(tool)));
      }
      return { resident: true, parts: mergeParts(parts), snapshot: true };
    }
    case 'deferred_tools_delta':
      return { resident: true, parts: mergeParts((a.addedNames || []).map(n => toolPart(n, 'tool names', n.length + 1))) };
    case 'deferred_tools_record':
      return { resident: true, parts: mergeParts((a.entries || []).filter(e => e && e.name).map(e => toolPart(e.name, 'loaded schema', len(e)))) };
    case 'mcp_instructions_delta': {
      const blocks = a.addedBlocks || [];
      const parts = (a.addedNames || []).map((n, i) =>
        ({ cat: 'boot', sub: BOOT_SUB.mcp, leaf: serverKey(n), part: 'instructions', chars: len(blocks[i]), exact: true }));
      return { resident: true, parts: parts.filter(p => p.chars) };
    }
    case 'skill_listing':
      return { resident: true, parts: listEntries(a.content).map(e =>
        ({ cat: 'boot', sub: BOOT_SUB.skill, leaf: e.name, part: 'listing', chars: e.text.length, exact: true })) };
    case 'invoked_skills':
      return { resident: true, parts: (a.skills || []).map(s =>
        ({ cat: 'boot', sub: 'invoked skills', leaf: (s && (s.name || s.skill)) || 'skill', chars: len(s), exact: true })) };
    case 'agent_listing_delta':
      return { resident: true, parts: listEntries((a.addedLines || []).join('\n')).map(e =>
        ({ cat: 'boot', sub: BOOT_SUB.agent, leaf: e.name, part: 'listing', chars: e.text.length, exact: true })) };
    case 'instructions':
      return { resident: true, parts: (a.files || []).map(f =>
        ({ cat: 'boot', sub: BOOT_SUB.md, leaf: (f && (f.path || f.displayPath)) || 'CLAUDE.md', part: 'file', chars: len(f && f.content), exact: true })) };
    case 'nested_memory': {
      const c = typeof a.content === 'string' ? a.content : (a.content && a.content.content);
      return { resident: true, parts: [{ cat: 'boot', sub: BOOT_SUB.md, leaf: a.path || (a.content && a.content.path) || a.displayPath || 'nested memory', part: 'file', chars: len(c), exact: true }] };
    }

    case 'file':
    case 'edited_text_file':
    case 'compact_file_reference':
    case 'opened_file_in_ide':
    case 'selected_lines_in_ide':
      return { resident: false, parts: [{ cat: 'injected', sub: 'file content',
        leaf: a.displayPath || a.filename || a.path || '(file)',
        chars: len(a.content) + len(a.snippet), exact: true }] };
    case 'diagnostics':
      return { resident: false, parts: [{ cat: 'injected', sub: 'diagnostics', chars: len(a.files), exact: true }] };
    case 'queued_command':
      return { resident: false, parts: [{ cat: 'injected', sub: 'queued commands', chars: len(a.prompt), exact: true }] };
    case 'hook_success':
    case 'hook_system_message':
    case 'hook_non_blocking_error':
      return { resident: false, parts: [{ cat: 'injected', sub: 'hook output',
        leaf: a.hookName || 'hook', chars: len(a.content) + len(a.stderr), exact: true }] };
    case 'total_tokens_reminder':
    case 'task_reminder':
    case 'session_context':
    case 'environment':
    case 'date': case 'date_change': case 'model': case 'auto_mode':
    case 'command_permissions': case 'plan_mode_exit': case 'remote_session_change':
    case 'ultrathink_effort': case 'workflow_keyword_request':
      return { resident: false, parts: [{ cat: 'injected', sub: 'system reminders',
        leaf: t, chars: len(a) - len(t), exact: true }] };
    default:
      return { resident: false, parts: [{ cat: 'injected', sub: 'other attachments', leaf: t || '?', chars: len(a), exact: false }] };
  }
}
