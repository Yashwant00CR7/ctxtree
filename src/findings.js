import { serverOf } from './attach.js';
import { BOOT_SUB } from './boot.js';

// Two tiers, never summed together. Tier 1 asserts only what the logs record.
// Tier 2 is inference and must print the proxy it used, so a wrong row is
// arguable rather than authoritative.
export function findings(model) {
  const proven = [], inferred = [];

  // --- MCP servers whose schemas are resident but which are never invoked ---
  const schemaByServer = new Map();   // server -> {tok, alloc, tools, sessions:Set}
  const callsByServer = new Map();
  for (const s of model.sessions) {
    const v = model.byId.get(s.sid);
    for (const c of v.chunks) {
      if (c.side) continue;
      if (c.cat === 'boot' && c.sub === BOOT_SUB.mcp && c.leaf) {
        const srv = c.leaf;
        const e = schemaByServer.get(srv) || { tok: 0, alloc: 0, tools: 0, sessions: new Set() };
        e.tok += c.tok; e.alloc += c.alloc; if (c.part !== 'instructions') e.tools = Math.max(e.tools, c.n || 0); e.sessions.add(s.sid);
        schemaByServer.set(srv, e);
      }
      if (c.kind === 'tool_use' && c.tool) {
        const srv = serverOf(c.tool);
        if (srv) callsByServer.set(srv, (callsByServer.get(srv) || 0) + 1);
      }
    }
  }
  for (const [srv, e] of [...schemaByServer].sort((a, b) => b[1].alloc - a[1].alloc)) {
    const calls = callsByServer.get(srv) || 0;
    if (calls > 0 && calls > e.sessions.size) continue;
    proven.push({
      tier: 1, kind: 'mcp', id: `mcp:${srv}`,
      title: `MCP server "${srv}" is loaded but ${calls === 0 ? 'never called' : `called only ${calls}x`}`,
      action: calls === 0 ? `Disable MCP server "${srv}"` : `Consider disabling "${srv}"`,
      saves: e.alloc, size: e.tok,
      evidence: [
        `${e.tools || '?'} tools plus instructions resident, ${e.tok.toLocaleString()} tokens`,
        `${calls} call${calls === 1 ? '' : 's'} across ${e.sessions.size} session${e.sessions.size === 1 ? '' : 's'}`,
        `re-shipped every turn: ${e.alloc.toLocaleString()} tokens allocated`,
      ],
      how: 'Right-click it in the tree (boot overhead > MCP servers) and remove it from a fork: its tools are denied at launch and its instructions dropped from the transcript. Or disable it in your config for every future session.',
    });
  }

  // --- byte-identical content loaded more than once in the same session ---
  for (const s of model.sessions) {
    const v = model.byId.get(s.sid);
    const seen = new Map();
    for (const c of v.chunks) {
      if (c.side || c.kind !== 'tool_result' || c.chars < 2000) continue;
      const e = seen.get(c.fp) || { n: 0, tok: 0, alloc: 0, tool: c.tool, target: c.target, tuids: [] };
      e.n++; e.tok = c.tok; e.alloc += c.alloc; if (c.tuid) e.tuids.push(c.tuid);
      seen.set(c.fp, e);
    }
    for (const [fp, e] of seen) {
      if (e.n < 2) continue;
      const wasted = e.alloc - Math.round(e.alloc / e.n);
      if (wasted < 2000) continue;
      proven.push({
        tier: 1, kind: 'dup', id: `dup:${s.sid}:${fp}`,
        sid: s.sid, project: s.projectName, tuids: e.tuids.slice(1),
        title: `${e.tool} result loaded ${e.n}x, byte-identical`,
        action: `Tombstone ${e.n - 1} duplicate${e.n > 2 ? 's' : ''}`,
        saves: wasted, size: e.tok,
        evidence: [
          `${e.target || '(no target)'}`.slice(0, 110),
          `${e.n} identical copies in one session, ${e.tok.toLocaleString()} tokens each`,
          `session ${s.sid.slice(0, 8)} - ${s.projectName}`,
        ],
        how: 'Prune + fork: keeps the first copy, tombstones the rest.',
      });
    }
  }

  // --- the fattest single chunks anywhere ---
  const fat = [];
  for (const s of model.sessions) {
    const v = model.byId.get(s.sid);
    for (const c of v.chunks) {
      if (c.side || c.cat !== 'tools' || c.kind !== 'tool_result') continue;
      if (c.tok > 8000) fat.push({ c, s });
    }
  }
  fat.sort((a, b) => b.c.alloc - a.c.alloc);
  for (const { c, s } of fat.slice(0, 25)) {
    inferred.push({
      tier: 2, kind: 'fat', id: `fat:${s.sid}:${c.tuid || c.i}`,
      sid: s.sid, project: s.projectName, tuids: c.tuid ? [c.tuid] : [],
      title: `${c.tool} returned ${c.tok.toLocaleString()} tokens in one call`,
      action: 'Tombstone this result',
      saves: c.alloc, size: c.tok,
      evidence: [
        `${c.target || '(no target)'}`.slice(0, 110),
        `resident for ${c.live} turns -> ${c.alloc.toLocaleString()} tokens allocated`,
        `session ${s.sid.slice(0, 8)} - ${s.projectName}`,
      ],
      proxy: 'Proxy: size alone. Large output is often still needed - this row says it was expensive, not that it was useless.',
      how: 'Prune + fork. Re-run the command if you need it back.',
    });
  }

  // --- resident prefix items that dominate by sheer residency ---
  const resident = new Map();
  for (const s of model.sessions) {
    const v = model.byId.get(s.sid);
    for (const c of v.chunks) {
      if (c.side || c.cat !== 'boot' || !c.resident) continue;
      const key = `${c.sub}|${c.leaf || ''}`;
      const e = resident.get(key) || { sub: c.sub, leaf: c.leaf, tok: 0, alloc: 0, sessions: 0 };
      e.tok = Math.max(e.tok, c.tok); e.alloc += c.alloc; e.sessions++;
      resident.set(key, e);
    }
  }
  for (const [key, e] of [...resident].sort((a, b) => b[1].alloc - a[1].alloc).slice(0, 8)) {
    if (e.sub === BOOT_SUB.mcp) continue; // already tier 1
    if (e.alloc < 5_000_000) continue;
    inferred.push({
      tier: 2, kind: 'resident', id: `res:${key}`,
      title: `${e.sub}${e.leaf ? ` - ${e.leaf}` : ''} rides every turn`,
      action: `Trim ${e.sub}`,
      saves: e.alloc, size: e.tok,
      evidence: [
        `${e.tok.toLocaleString()} tokens resident, across ${e.sessions} sessions`,
        `re-shipped every turn: ${e.alloc.toLocaleString()} tokens allocated`,
      ],
      proxy: 'Proxy: residency x size. Says nothing about whether the content earns its place.',
      how: 'Remove it from a fork (right-click in the tree), or trim the source file or listing for every future session.',
    });
  }

  proven.sort((a, b) => b.saves - a.saves);
  inferred.sort((a, b) => b.saves - a.saves);
  return {
    proven, inferred,
    provenTotal: proven.reduce((a, f) => a + f.saves, 0),
    inferredTotal: inferred.reduce((a, f) => a + f.saves, 0),
  };
}
