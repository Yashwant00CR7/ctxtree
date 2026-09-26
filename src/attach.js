// Attachment records carry most of what people think of as "boot overhead":
// the system prompt, every tool schema, skill listings, MCP instructions and
// CLAUDE.md. They reach the model but live outside message.content, so anything
// that only reads message.content undercounts the context badly.

const len = (v) => {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((a, x) => a + len(x), 0);
  if (typeof v === 'object') return JSON.stringify(v).length;
  return String(v).length;
};

export const serverOf = (toolName = '') =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] || 'mcp' : null;

// cat = top-level lever branch, sub = the node you would actually act on.
export function extractAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const t = a.type;
  switch (t) {
    case 'prompt_snapshot': {
      const sp = len(a.systemPrompt);
      const tools = Array.isArray(a.tools) ? a.tools : [];
      const parts = [];
      if (sp) parts.push({ cat: 'boot', sub: 'system prompt', chars: sp, exact: true });
      const byServer = new Map();
      for (const tool of tools) {
        const name = (tool && tool.name) || '?';
        const srv = serverOf(name);
        const key = srv ? `MCP: ${srv}` : 'built-in tools';
        const cur = byServer.get(key) || { chars: 0, n: 0, names: [] };
        cur.chars += len(tool); cur.n++; if (cur.names.length < 60) cur.names.push(name);
        byServer.set(key, cur);
      }
      for (const [key, v] of byServer)
        parts.push({ cat: 'boot', sub: 'tool schemas', leaf: key, chars: v.chars, n: v.n, names: v.names, exact: true });
      return { resident: true, parts, snapshot: true };
    }
    case 'deferred_tools_delta':
    case 'deferred_tools_record': {
      const chars = len(a.addedLines) + len(a.addedNames) + len(a.entries) + len(a.nameOnlyAnnouncements);
      const names = [...(a.addedNames || []), ...((a.entries || []).map(e => e && e.name).filter(Boolean))];
      const byServer = new Map();
      for (const n of names) {
        const key = serverOf(n) ? `MCP: ${serverOf(n)}` : 'built-in tools';
        byServer.set(key, (byServer.get(key) || 0) + 1);
      }
      const total = names.length || 1;
      const parts = [...byServer].map(([key, n]) =>
        ({ cat: 'boot', sub: 'tool schemas', leaf: key, chars: Math.round(chars * n / total), n, exact: false }));
      return { resident: true, parts: parts.length ? parts : [{ cat: 'boot', sub: 'tool schemas', chars, exact: false }] };
    }
    case 'mcp_instructions_delta': {
      const blocks = a.addedBlocks || [];
      const names = a.addedNames || [];
      const parts = blocks.map((b, i) =>
        ({ cat: 'boot', sub: 'MCP instructions', leaf: `MCP: ${names[i] || '?'}`, chars: len(b), exact: true }));
      return { resident: true, parts: parts.length ? parts : [{ cat: 'boot', sub: 'MCP instructions', chars: len(blocks) + len(names), exact: true }] };
    }
    case 'skill_listing':
      return { resident: true, parts: [{ cat: 'boot', sub: 'skill listing', chars: len(a.content),
        n: a.skillCount || (a.names || []).length, exact: true }] };
    case 'invoked_skills':
      return { resident: true, parts: (a.skills || []).map(s =>
        ({ cat: 'boot', sub: 'invoked skills', leaf: (s && (s.name || s.skill)) || 'skill', chars: len(s), exact: true })) };
    case 'agent_listing_delta':
      return { resident: true, parts: [{ cat: 'boot', sub: 'agent listing', chars: len(a.addedLines) + len(a.addedTypes),
        n: (a.addedTypes || []).length, exact: true }] };
    case 'instructions':
      return { resident: true, parts: (a.files || []).map(f =>
        ({ cat: 'boot', sub: 'CLAUDE.md', leaf: (f && (f.path || f.displayPath)) || 'CLAUDE.md', chars: len(f), exact: true })) };
    case 'nested_memory':
      return { resident: true, parts: [{ cat: 'boot', sub: 'CLAUDE.md', leaf: a.displayPath || a.path || 'nested memory', chars: len(a.content), exact: true }] };

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
