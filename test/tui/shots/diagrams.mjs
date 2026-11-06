// The walkthrough's two diagrams (architecture, and what Apply does), drawn as
// HTML and saved as PNG by headless Chrome.
//   node test/tui/shots/diagrams.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../../docs/walkthrough/img');

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1d2330;background:#f6f7f9;padding:28px}
h1{font-size:19px;margin-bottom:18px;color:#0f1420}
.box{border-radius:12px;padding:14px 16px;background:#fff;border:1.5px solid #d5dae3;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.title{font-weight:700;margin-bottom:6px;font-size:15px}
.sub{color:#5b6475;font-size:13px}
ul{list-style:none;margin-top:4px}
li{font-size:13.5px;color:#2b3242;padding:2px 0 2px 14px;position:relative}
li:before{content:"";position:absolute;left:2px;top:10px;width:5px;height:5px;border-radius:50%;background:#9aa3b2}
code{font:12.5px Menlo,monospace;background:#eef1f5;border-radius:4px;padding:1px 5px}
.core{border-color:#6c8cf5;background:#f4f7ff}
.ui{border-color:#e0a93b;background:#fffaf0}
.cc{border:2px dashed #9aa3b2;background:#fbfcfd;padding:18px}
.ext{border-color:#7cc196;background:#f3fbf6}
.model{border-color:#c48ae0;background:#fbf5ff}
.arrow{color:#5b6475;font-size:12.5px;text-align:center}
`;

const architecture = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
.grid{display:grid;grid-template-columns:1fr 150px 1fr;gap:0;align-items:stretch}
.mid{display:flex;flex-direction:column;justify-content:center;gap:28px;align-items:center}
.arr{font-size:22px;color:#6b7385;line-height:1}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
</style></head><body>
<h1>How the ctxtree mod fits into Claude Code</h1>
<div class="box cc">
  <div class="title">Claude Code (one session)</div>
  <div class="sub" style="margin-bottom:14px">Two plugins: an Apply must start from a different plugin than the one whose hook rebuilds the conversation.</div>
  <div class="grid">
    <div class="box ui">
      <div class="title">ctxtree-ui</div>
      <ul>
        <li><b>Band</b> above the prompt: <code>N staged · −Xk</code>, keys <code>1</code> open, <code>2</code> review</li>
        <li><b>Pane</b> <code>/ctxtree</code>: tree (by task / by type), side column (details, types, keys), cushion <b>treemap</b> (a Raster) with a click overlay</li>
        <li><b>Review</b> dialog: the plan as it would apply now, bridge text you can edit, restore</li>
        <li><b>Apply</b> press: approve, then start the compaction (or queue it while Claude works)</li>
      </ul>
    </div>
    <div class="mid">
      <div class="arrow"><div class="arr">→</div>calls <code>$.ctxtree</code><br>(rows, mark, approve…)</div>
      <div class="arrow"><div class="arr">←</div>reads plan &amp; status<br>(<code>$.state</code>)</div>
      <div class="arrow"><div class="arr">→</div>Apply starts<br>the compaction</div>
    </div>
    <div class="box core">
      <div class="title">ctxtree (core)</div>
      <ul>
        <li><b>Map</b> of what Claude sees now (<code>$.session.messages({ as: 'api' })</code>), rebuilt after every turn</li>
        <li><b>One plan</b>: your marks and Claude's staged edits</li>
        <li><b>Claude's tools</b>: <code>map</code> <code>inspect</code> <code>stage</code> <code>unstage</code> <code>restore</code>. No apply tool</li>
        <li><b>Compaction hook</b>: rebuilds every message with the plan applied; saves the originals</li>
        <li><code>core/</code>: the shared engine (map, plan, treemap), also used by the CLI</li>
      </ul>
    </div>
  </div>
  <div class="row2">
    <div class="box model"><div class="title">Claude (the model)</div><div class="sub">Maps the window and stages a plan with the ctxtree tools when you ask it to clean up. It can never apply; you do.</div></div>
    <div class="box ext"><div class="title"><code>~/.claude/ctxtree/originals/</code></div><div class="sub">One small file per removed block, written at Apply. Restore puts them back. Pruned after 30 days.</div></div>
  </div>
</div>
<div class="row2">
  <div class="box ext"><div class="title">ctxtree CLI and web UI (Node)</div><div class="sub">The same <code>core/</code> engine over session files: every session, verified forks, boot overhead, uncompact, branches, slim, lineage. <code>npx ctxtree</code></div></div>
  <div class="box"><div class="title"><code>~/.claude/projects/**.jsonl</code></div><div class="sub">Claude Code's transcripts. The mod edits the live conversation; the web UI writes forks next to the original and never changes it.</div></div>
</div>
</body></html>`;

const step = (n, title, body, cls = '') => `<div class="box ${cls}" style="position:relative;padding-top:30px"><div style="position:absolute;top:-12px;left:14px;width:26px;height:26px;border-radius:50%;background:#2f54eb;color:#fff;font-weight:700;text-align:center;line-height:26px;font-size:13px">${n}</div><div class="title">${title}</div><div class="sub">${body}</div></div>`;
const apply = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:22px;margin-top:12px}
.note{margin-top:22px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px}
</style></head><body>
<h1>What happens when you press Apply</h1>
<div class="flow">
${step(1, 'Mark or stage', 'You mark items in the pane (<code>x</code>, Space, menu), or Claude stages them with its <code>stage</code> tool. Both land in <b>one plan</b>, keyed by address: a tool block by <code>tool_use_id</code>, text by position + fingerprint.', 'ui')}
${step(2, 'Review', 'The review re-checks every entry against the conversation as it is now, shows tokens per item, lets you edit bridge text, and warns about images (a rebuild can\'t carry them).', 'ui')}
${step(3, 'Approve', 'Pressing <code>a</code> re-checks again and runs a dry rebuild: every call still pairs with its result. Then it starts a compaction: at once if Claude is idle, queued until the turn ends if not.', 'ui')}
${step(4, 'Rebuild', 'The core\'s compaction hook resolves each entry in the live messages (anything changed or ambiguous is refused, never moved), rebuilds every message, erases the cleanup talk, adds one note, verifies, and saves the originals.', 'core')}
${step(5, 'Next turn', 'Claude Code installs the rebuilt conversation. The next request carries it: tombstones, shrunk inputs and bridges instead of the originals. Nothing is summarised; nothing else changes.', 'core')}
</div>
<div class="note">
  <div class="box"><div class="title">Never a surprise compaction</div><div class="sub">If anything fails, the hook answers <i>skip</i>: Claude Code's own summarising compaction never runs in its place. Background (<code>precompute</code>) and threshold (<code>auto</code>) compactions pass through untouched.</div></div>
  <div class="box"><div class="title">Reversible</div><div class="sub">Each replaced block's original is saved. <code>/ctxtree review</code> → restore (or <code>e</code> for all) → Apply puts it back in place.</div></div>
  <div class="box"><div class="title">Claude knows</div><div class="sub">One note, e.g. <code>[ctxtree: the user removed 4 items, bridged 1 … Re-run a tool if you need its output again.]</code>, so Claude re-reads instead of guessing.</div></div>
</div>
</body></html>`;

const c = await launchChrome();
await c.html(architecture, 1180, 760, 2);
const h1 = await c.eval('document.body.scrollHeight');
await c.size(1180, h1, 2); await c.sleep(300);
await c.shot(path.join(OUT, 'diagram-architecture.png'));
await c.html(apply, 1400, 560, 2);
const h2 = await c.eval('document.body.scrollHeight');
await c.size(1400, h2, 2); await c.sleep(300);
await c.shot(path.join(OUT, 'diagram-apply.png'));
await c.close();
console.log('diagrams written');
