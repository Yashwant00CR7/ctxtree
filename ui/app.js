// ctxtree - WizTree Client Application
(function () {
  'use strict';

  // State
  const state = {
    sid: 'all',
    metric: 'alloc', // 'alloc' or 'tok'
    modelStats: null,
    sessions: [],
    currentTree: null,
    currentChunks: [],
    currentRegions: [],
    findings: { proven: [], inferred: [], provenTotal: 0, inferredTotal: 0 },
    forks: [],
    expandedNodes: new Set(['root']),
    selectedNodeKey: null,
    selectedTuids: new Set(),
    treemapRects: [],
    zoomStack: [], // stack of node keys/filters
    hoveredRect: null,
  };

  // Color Palette mapping (matching WizTree screenshot style)
  const COLOR_PALETTE = {
    'boot': '#6a1b9a',
    'tool schemas': '#7b1fa2',
    'system prompt': '#4a148c',
    'skills': '#311b92',
    'agent listing': '#283593',
    'tools': '#e65100',
    'Read': '#f57c00',
    'Bash': '#ff9800',
    'Write': '#d81b60',
    'Edit': '#c2185b',
    'Glob': '#ef6c00',
    'Grep': '#fb8c00',
    'conversation': '#2e7d32',
    'user': '#43a047',
    'assistant': '#1565c0',
    'thinking': '#8e24aa',
    'image': '#5d4037',
    'injected': '#00695c',
    'subcontext': '#00838f',
    'default': '#455a64'
  };

  function getColor(item) {
    if (!item) return COLOR_PALETTE.default;
    const key = item.sub || item.tool || item.cat || item.kind;
    if (COLOR_PALETTE[key]) return COLOR_PALETTE[key];
    if (item.cat && COLOR_PALETTE[item.cat]) return COLOR_PALETTE[item.cat];
    // Hash into palette
    let h = 0;
    const str = String(key);
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffff;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 65%, 45%)`;
  }

  // Formatting helpers
  function fmt(n) {
    if (n == null || isNaN(n)) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + ' k';
    return String(Math.round(n));
  }

  function fmtPct(p) {
    if (p == null || isNaN(p)) return '0.0%';
    return (p * 100).toFixed(1) + '%';
  }

  // DOM Elements
  const sessionSelect = document.getElementById('session-select');
  const btnScan = document.getElementById('btn-scan');
  const scanStatus = document.getElementById('scan-status');
  const statSelection = document.getElementById('stat-selection');
  const statAllocated = document.getElementById('stat-allocated');
  const statSize = document.getElementById('stat-size');
  const statCompacts = document.getElementById('stat-compacts');
  const meterPercent = document.getElementById('meter-percent');
  const meterBarFill = document.getElementById('meter-bar-fill');
  const badgeReclaim = document.getElementById('badge-reclaim');
  const windowTitleText = document.getElementById('window-title-text');

  const treeTbody = document.getElementById('tree-tbody');
  const regionsTbody = document.getElementById('regions-tbody');
  const forksTbody = document.getElementById('forks-tbody');
  const kindTbody = document.getElementById('kind-tbody');
  const projectsTbody = document.getElementById('projects-tbody');
  const findingsContainer = document.getElementById('findings-container');
  const findingsCountBadge = document.getElementById('findings-count-badge');
  const forksCountBadge = document.getElementById('forks-count-badge');

  const reclaimSelectedSavings = document.getElementById('reclaim-selected-savings');
  const btnPruneSelected = document.getElementById('btn-prune-selected');

  const treemapCanvas = document.getElementById('treemap-canvas');
  const treemapContainer = document.getElementById('treemap-container');
  const treemapTooltip = document.getElementById('treemap-tooltip');
  const treemapBreadcrumb = document.getElementById('treemap-breadcrumb');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const metricAllocBtn = document.getElementById('metric-alloc');
  const metricSizeBtn = document.getElementById('metric-size');

  // Modals
  const pruneModal = document.getElementById('prune-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');
  const modalChunkCount = document.getElementById('modal-chunk-count');
  const modalTokSaved = document.getElementById('modal-tok-saved');
  const modalAllocSaved = document.getElementById('modal-alloc-saved');
  const pruneNote = document.getElementById('prune-note');

  const successModal = document.getElementById('success-modal');
  const successCloseBtn = document.getElementById('success-close-btn');
  const successDoneBtn = document.getElementById('success-done-btn');
  const successCmdText = document.getElementById('success-cmd-text');
  const successTokSaved = document.getElementById('success-tok-saved');
  const btnCopyCmd = document.getElementById('btn-copy-cmd');

  // Tab switching
  document.querySelectorAll('.panel-tabs').forEach(tabGroup => {
    tabGroup.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      const targetId = btn.dataset.tab;
      const parentPanel = btn.closest('.panel');
      parentPanel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      parentPanel.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetContent = parentPanel.querySelector(`#${targetId}`);
      if (targetContent) targetContent.classList.add('active');
    });
  });

  // Metric Toggles
  metricAllocBtn.addEventListener('click', () => {
    if (state.metric === 'alloc') return;
    state.metric = 'alloc';
    metricAllocBtn.classList.add('active');
    metricSizeBtn.classList.remove('active');
    renderTreemap();
  });
  metricSizeBtn.addEventListener('click', () => {
    if (state.metric === 'tok') return;
    state.metric = 'tok';
    metricSizeBtn.classList.add('active');
    metricAllocBtn.classList.remove('active');
    renderTreemap();
  });

  // Scan Button
  btnScan.addEventListener('click', async () => {
    btnScan.disabled = true;
    scanStatus.textContent = 'Scanning sessions...';
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      await res.json();
      await loadAllData();
      scanStatus.textContent = `Scan complete in ${(state.modelStats.scanMs / 1000).toFixed(2)} seconds`;
    } catch (err) {
      console.error(err);
      scanStatus.textContent = 'Scan failed';
    } finally {
      btnScan.disabled = false;
    }
  });

  // Session Selector Change
  sessionSelect.addEventListener('change', async () => {
    state.sid = sessionSelect.value;
    state.zoomStack = [];
    state.selectedNodeKey = null;
    await loadSessionView();
  });

  // Reset Zoom
  btnZoomReset.addEventListener('click', () => {
    state.zoomStack = [];
    renderBreadcrumb();
    renderTreemap();
  });

  // Initial Load
  async function init() {
    await loadAllData();
    setupCanvas();
    window.addEventListener('resize', () => {
      resizeCanvas();
      renderTreemap();
    });
  }

  async function loadAllData() {
    const t0 = performance.now();
    try {
      const [statsRes, sessRes, forksRes] = await Promise.all([
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/sessions').then(r => r.json()),
        fetch('/api/forks').then(r => r.json())
      ]);

      state.modelStats = statsRes.stats;
      state.sessions = sessRes;
      state.forks = forksRes;

      // Populate Session dropdown
      populateSessionSelect();
      updateTopStats();
      renderForksTable();

      // Load session view (or all)
      await loadSessionView();

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      scanStatus.textContent = `Scan complete in ${elapsed} seconds`;
    } catch (e) {
      console.error('Error loading data:', e);
      scanStatus.textContent = 'Error loading data';
    }
  }

  function populateSessionSelect() {
    sessionSelect.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = `<All Sessions / Overview> (${state.sessions.length} sessions · ${fmt(state.modelStats.alloc)} alloc)`;
    sessionSelect.appendChild(allOpt);

    state.sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.sid;
      const sidShort = s.sid.slice(0, 8);
      opt.textContent = `${sidShort} | ${s.projectName} (${fmt(s.alloc)} alloc · ${s.turns} turns)`;
      sessionSelect.appendChild(opt);
    });

    sessionSelect.value = state.sid;
  }

  function updateTopStats() {
    forksCountBadge.textContent = state.forks.length;

    if (state.sid === 'all') {
      windowTitleText.textContent = `[All Sessions] - ctxtree`;
      statSelection.textContent = `<All Sessions (${state.sessions.length})>`;
      statAllocated.textContent = `${fmt(state.modelStats.alloc)} (Tokens × Turns)`;
      statSize.textContent = fmt(state.modelStats.tok);
      statCompacts.textContent = `${state.modelStats.compacts} ceiling hits`;

      const usedRatio = Math.min(1, state.modelStats.tok / (state.modelStats.peakMax || 200000));
      meterPercent.textContent = fmtPct(usedRatio);
      meterBarFill.style.width = fmtPct(usedRatio);
    } else {
      const cur = state.sessions.find(s => s.sid === state.sid);
      if (cur) {
        windowTitleText.textContent = `[${cur.sid.slice(0, 8)}] ${cur.projectName} - ctxtree`;
        statSelection.textContent = `${cur.sid.slice(0, 8)} (${cur.projectName})`;
        statAllocated.textContent = `${fmt(cur.alloc)} (Tokens × Turns)`;
        statSize.textContent = fmt(cur.tok);
        statCompacts.textContent = `${cur.compacts} ceiling hits · ${cur.turns} turns`;

        const usedRatio = Math.min(1, cur.tok / 200000);
        meterPercent.textContent = `${fmt(cur.tok)} / 200k (${fmtPct(usedRatio)})`;
        meterBarFill.style.width = fmtPct(usedRatio);
      }
    }
  }

  async function loadSessionView() {
    updateTopStats();

    const [treeRes, findingsRes, chunksRes] = await Promise.all([
      fetch(`/api/tree?sid=${state.sid}`).then(r => r.json()),
      fetch(`/api/findings?sid=${state.sid}`).then(r => r.json()),
      fetch(`/api/chunks?sid=${state.sid}`).then(r => r.json())
    ]);

    state.currentTree = treeRes;
    state.findings = findingsRes;
    state.currentChunks = chunksRes;

    badgeReclaim.textContent = `${fmt(findingsRes.provenTotal)} reclaimable`;

    // Pre-check proven findings tuids
    state.selectedTuids.clear();
    findingsRes.proven.forEach(p => {
      if (p.tuids) p.tuids.forEach(id => state.selectedTuids.add(id));
    });

    renderTreeTable();
    renderFindings();
    renderKindTable();
    renderProjectsTable();
    renderBreadcrumb();
    renderTreemap();

    // If specific session, load regions
    if (state.sid !== 'all') {
      const regs = await fetch(`/api/regions?sid=${state.sid}`).then(r => r.json());
      state.currentRegions = regs;
      renderRegionsTable();
    } else {
      state.currentRegions = [];
      regionsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">Select a specific session to inspect prompt regions</td></tr>`;
    }
  }

  // Render Tree Table
  function renderTreeTable() {
    treeTbody.innerHTML = '';
    if (!state.currentTree) return;

    function walk(node, depth, parentKey) {
      const fullKey = parentKey ? `${parentKey}/${node.key}` : node.key;
      const isExpanded = state.expandedNodes.has(fullKey);
      const hasKids = node.children && node.children.length > 0;

      const tr = document.createElement('tr');
      tr.dataset.key = fullKey;
      if (state.selectedNodeKey === fullKey) tr.classList.add('selected');

      const tdName = document.createElement('td');
      tdName.style.paddingLeft = `${depth * 18 + 8}px`;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tree-node-title';

      if (hasKids) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = isExpanded ? '[-] ' : '[+] ';
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) state.expandedNodes.delete(fullKey);
          else state.expandedNodes.add(fullKey);
          renderTreeTable();
        });
        titleSpan.appendChild(toggle);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'tree-toggle';
        spacer.textContent = '    ';
        titleSpan.appendChild(spacer);
      }

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = hasKids ? (isExpanded ? '📂' : '📁') : '📄';
      titleSpan.appendChild(icon);

      const label = document.createElement('span');
      label.textContent = node.name;
      titleSpan.appendChild(label);
      tdName.appendChild(titleSpan);

      // % of parent with mini bar
      const tdPct = document.createElement('td');
      const pctVal = node.pct || 0;
      tdPct.innerHTML = `
        <div class="col-pct-bar">
          <div class="pct-bar-bg"><div class="pct-bar-fill" style="width: ${fmtPct(pctVal)};"></div></div>
          <span>${fmtPct(pctVal)}</span>
        </div>
      `;

      const tdSize = document.createElement('td');
      tdSize.textContent = fmt(node.tok);

      const tdAlloc = document.createElement('td');
      tdAlloc.textContent = fmt(node.alloc);

      const tdItems = document.createElement('td');
      tdItems.textContent = node.n ? node.n.toLocaleString() : '1';

      tr.appendChild(tdName);
      tr.appendChild(tdPct);
      tr.appendChild(tdSize);
      tr.appendChild(tdAlloc);
      tr.appendChild(tdItems);

      tr.addEventListener('click', () => {
        state.selectedNodeKey = fullKey;
        document.querySelectorAll('#tree-tbody tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');

        // Zoom treemap to this branch if it has children
        state.zoomStack = [fullKey];
        renderBreadcrumb();
        renderTreemap();
      });

      treeTbody.appendChild(tr);

      if (hasKids && isExpanded) {
        node.children.forEach(child => walk(child, depth + 1, fullKey));
      }
    }

    walk(state.currentTree, 0, '');
  }

  // Render By Kind Table (WizTree Extensions panel)
  function renderKindTable() {
    kindTbody.innerHTML = '';
    const byKind = new Map();

    state.currentChunks.forEach(c => {
      const k = c.tool ? `tool:${c.tool}` : (c.sub || c.cat || c.kind);
      const e = byKind.get(k) || { key: k, tok: 0, alloc: 0, count: 0, cat: c.cat, tool: c.tool };
      e.tok += c.tok || 0;
      e.alloc += c.alloc || 0;
      e.count++;
      byKind.set(k, e);
    });

    const rows = Array.from(byKind.values()).sort((a, b) => b[state.metric] - a[state.metric]);
    const totalAlloc = rows.reduce((a, r) => a + r.alloc, 0) || 1;

    rows.forEach(r => {
      const tr = document.createElement('tr');
      const color = getColor({ sub: r.key, cat: r.cat, tool: r.tool });

      tr.innerHTML = `
        <td style="text-align: center;"><span class="color-swatch" style="background: ${color};"></span></td>
        <td><strong>${r.key}</strong></td>
        <td>${fmtPct(r.alloc / totalAlloc)}</td>
        <td>${fmt(r.tok)}</td>
        <td>${fmt(r.alloc)}</td>
        <td>${r.count.toLocaleString()}</td>
      `;

      tr.addEventListener('click', () => {
        // Filter treemap to this kind
        state.zoomStack = [`kind:${r.key}`];
        renderBreadcrumb();
        renderTreemap();
      });

      kindTbody.appendChild(tr);
    });
  }

  // Render Projects Table
  function renderProjectsTable() {
    projectsTbody.innerHTML = '';
    const byProj = new Map();

    state.sessions.forEach(s => {
      const e = byProj.get(s.project) || { project: s.project, name: s.projectName, tok: 0, alloc: 0, sessions: 0 };
      e.tok += s.tok;
      e.alloc += s.alloc;
      e.sessions++;
      byProj.set(s.project, e);
    });

    const rows = Array.from(byProj.values()).sort((a, b) => b.alloc - a.alloc);
    const totalAlloc = state.modelStats.alloc || 1;

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.name}</strong></td>
        <td>${fmtPct(r.alloc / totalAlloc)}</td>
        <td>${fmt(r.tok)}</td>
        <td>${fmt(r.alloc)}</td>
        <td>${r.sessions}</td>
      `;
      tr.addEventListener('click', () => {
        // Switch to first session in this project
        const firstSess = state.sessions.find(s => s.project === r.project);
        if (firstSess) {
          sessionSelect.value = firstSess.sid;
          sessionSelect.dispatchEvent(new Event('change'));
        }
      });
      projectsTbody.appendChild(tr);
    });
  }

  // Render Prompt Regions Table
  function renderRegionsTable() {
    regionsTbody.innerHTML = '';
    if (!state.currentRegions || state.currentRegions.length === 0) {
      regionsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">No regions available</td></tr>`;
      return;
    }

    state.currentRegions.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td title="${r.name}"><strong>💬 "${r.name}"</strong></td>
        <td>
          <div class="col-pct-bar">
            <div class="pct-bar-bg"><div class="pct-bar-fill" style="width: ${fmtPct(r.pct)};"></div></div>
            <span>${fmtPct(r.pct)}</span>
          </div>
        </td>
        <td>${fmt(r.tok)}</td>
        <td>${fmt(r.alloc)}</td>
        <td>${r.n}</td>
      `;
      tr.addEventListener('click', () => {
        state.zoomStack = [`region:${r.id}`];
        renderBreadcrumb();
        renderTreemap();
      });
      regionsTbody.appendChild(tr);
    });
  }

  // Render Forks Table
  function renderForksTable() {
    forksTbody.innerHTML = '';
    forksCountBadge.textContent = state.forks.length;

    if (!state.forks || state.forks.length === 0) {
      forksTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">No forked sessions yet. Cut fat chunks to fork a smaller context.</td></tr>`;
      return;
    }

    state.forks.forEach(f => {
      const tr = document.createElement('tr');
      const dateStr = new Date(f.createdAt).toLocaleDateString() + ' ' + new Date(f.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      tr.innerHTML = `
        <td><code style="color:#4ec9b0;">${f.forkSid.slice(0, 8)}</code></td>
        <td>${f.projectName}</td>
        <td style="color:#4caf50;">+${fmt(f.savedTok)} tok</td>
        <td style="color:#888;">${dateStr}</td>
        <td>
          <button class="wiz-btn small primary btn-resume-fork" data-sid="${f.forkSid}">Resume</button>
          <button class="wiz-btn small danger btn-revert-fork" data-sid="${f.forkSid}">Revert</button>
        </td>
      `;

      tr.querySelector('.btn-resume-fork').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(`claude --resume ${f.forkSid}`);
        alert(`Copied to clipboard:\nclaude --resume ${f.forkSid}`);
      });

      tr.querySelector('.btn-revert-fork').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Revert and delete fork ${f.forkSid.slice(0, 8)}?`)) {
          await fetch('/api/revert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ forkSid: f.forkSid })
          });
          state.forks = await fetch('/api/forks').then(r => r.json());
          renderForksTable();
          await loadAllData();
        }
      });

      forksTbody.appendChild(tr);
    });
  }

  // Render Findings Tab
  function renderFindings() {
    findingsContainer.innerHTML = '';
    const prov = state.findings.proven || [];
    const inf = state.findings.inferred || [];
    findingsCountBadge.textContent = prov.length + inf.length;

    function createFindingCard(item, tier) {
      const card = document.createElement('div');
      card.className = `finding-card tier-${tier}`;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'finding-check';
      const hasTuids = item.tuids && item.tuids.length > 0;
      check.disabled = !hasTuids;

      if (hasTuids && item.tuids.every(id => state.selectedTuids.has(id))) {
        check.checked = true;
      }

      check.addEventListener('change', () => {
        if (!item.tuids) return;
        if (check.checked) {
          item.tuids.forEach(id => state.selectedTuids.add(id));
        } else {
          item.tuids.forEach(id => state.selectedTuids.delete(id));
        }
        updateReclaimSummary();
      });

      const body = document.createElement('div');
      body.className = 'finding-content';

      const hdr = document.createElement('div');
      hdr.className = 'finding-header';

      const title = document.createElement('span');
      title.className = 'finding-title';
      title.textContent = item.title;

      const badge = document.createElement('span');
      badge.className = `finding-badge tier-${tier}`;
      badge.textContent = `Tier ${tier}: Saves ${fmt(item.saves)}`;

      hdr.appendChild(title);
      hdr.appendChild(badge);
      body.appendChild(hdr);

      if (item.evidence && item.evidence.length) {
        const ul = document.createElement('ul');
        ul.className = 'finding-evidence';
        item.evidence.forEach(e => {
          const li = document.createElement('li');
          li.textContent = `• ${e}`;
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }

      if (item.proxy) {
        const p = document.createElement('div');
        p.className = 'finding-proxy';
        p.textContent = item.proxy;
        body.appendChild(p);
      }

      if (item.how) {
        const h = document.createElement('div');
        h.className = 'finding-how';
        h.textContent = `Action: ${item.how}`;
        body.appendChild(h);
      }

      card.appendChild(check);
      card.appendChild(body);
      return card;
    }

    prov.forEach(p => findingsContainer.appendChild(createFindingCard(p, 1)));
    inf.forEach(i => findingsContainer.appendChild(createFindingCard(i, 2)));

    updateReclaimSummary();
  }

  function updateReclaimSummary() {
    let tokSaved = 0;
    let count = 0;
    const allFindings = [...state.findings.proven, ...state.findings.inferred];

    allFindings.forEach(f => {
      if (f.tuids && f.tuids.some(id => state.selectedTuids.has(id))) {
        tokSaved += f.saves || 0;
        count++;
      }
    });

    reclaimSelectedSavings.textContent = `${fmt(tokSaved)} (${count} items selected)`;
    btnPruneSelected.disabled = state.selectedTuids.size === 0 || state.sid === 'all';
    if (state.sid === 'all') {
      btnPruneSelected.title = 'Select a specific session from the dropdown to prune and fork';
    } else {
      btnPruneSelected.title = 'Tombstone selected results and fork session';
    }
  }

  // Prune Button & Modal Workflow
  btnPruneSelected.addEventListener('click', () => {
    if (state.selectedTuids.size === 0 || state.sid === 'all') return;
    modalChunkCount.textContent = state.selectedTuids.size;

    let tokSaved = 0;
    let allocSaved = 0;
    state.currentChunks.forEach(c => {
      if (c.tuid && state.selectedTuids.has(c.tuid)) {
        tokSaved += c.tok || 0;
        allocSaved += c.alloc || 0;
      }
    });

    modalTokSaved.textContent = fmt(tokSaved);
    modalAllocSaved.textContent = fmt(allocSaved);
    pruneModal.classList.remove('hidden');
  });

  modalCloseBtn.addEventListener('click', () => pruneModal.classList.add('hidden'));
  modalCancelBtn.addEventListener('click', () => pruneModal.classList.add('hidden'));

  modalConfirmBtn.addEventListener('click', async () => {
    modalConfirmBtn.disabled = true;
    modalConfirmBtn.textContent = 'Forking...';

    try {
      const res = await fetch('/api/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid: state.sid,
          tuids: Array.from(state.selectedTuids),
          note: pruneNote.value || 'Pruned with ctxtree'
        })
      });
      const data = await res.json();

      pruneModal.classList.add('hidden');
      modalConfirmBtn.disabled = false;
      modalConfirmBtn.textContent = 'Confirm & Fork';

      if (data.ok) {
        successCmdText.textContent = data.resumeCmd;
        successTokSaved.textContent = `${fmt(data.savedTok)} tokens reclaimed (${fmt(data.savedAlloc)} shipped)`;
        successModal.classList.remove('hidden');

        // Refresh forks list and sessions
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
      } else {
        alert(`Error: ${data.error || 'Failed to prune'}`);
      }
    } catch (e) {
      console.error(e);
      alert('Error forking session');
      modalConfirmBtn.disabled = false;
      modalConfirmBtn.textContent = 'Confirm & Fork';
    }
  });

  successCloseBtn.addEventListener('click', () => successModal.classList.add('hidden'));
  successDoneBtn.addEventListener('click', () => successModal.classList.add('hidden'));

  btnCopyCmd.addEventListener('click', () => {
    navigator.clipboard.writeText(successCmdText.textContent);
    btnCopyCmd.textContent = 'Copied!';
    setTimeout(() => { btnCopyCmd.textContent = 'Copy'; }, 1500);
  });

  // Breadcrumb
  function renderBreadcrumb() {
    treemapBreadcrumb.innerHTML = '';
    const rootCrumb = document.createElement('span');
    rootCrumb.className = `crumb ${state.zoomStack.length === 0 ? 'active' : ''}`;
    rootCrumb.textContent = state.sid === 'all' ? '[All Context]' : `[Session ${state.sid.slice(0, 8)}]`;
    rootCrumb.addEventListener('click', () => {
      state.zoomStack = [];
      renderBreadcrumb();
      renderTreemap();
    });
    treemapBreadcrumb.appendChild(rootCrumb);

    state.zoomStack.forEach((z, idx) => {
      const sep = document.createElement('span');
      sep.textContent = ' > ';
      treemapBreadcrumb.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.className = `crumb ${idx === state.zoomStack.length - 1 ? 'active' : ''}`;
      crumb.textContent = z;
      crumb.addEventListener('click', () => {
        state.zoomStack = state.zoomStack.slice(0, idx + 1);
        renderBreadcrumb();
        renderTreemap();
      });
      treemapBreadcrumb.appendChild(crumb);
    });
  }

  // ========================================================
  // Squarified Treemap Canvas Engine (WizTree 3D Bevel Look)
  // ========================================================
  let ctx = null;
  let dpr = 1;

  function setupCanvas() {
    ctx = treemapCanvas.getContext('2d');
    resizeCanvas();
    setupCanvasEvents();
  }

  function resizeCanvas() {
    const rect = treemapContainer.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    treemapCanvas.width = rect.width * dpr;
    treemapCanvas.height = rect.height * dpr;
    treemapCanvas.style.width = `${rect.width}px`;
    treemapCanvas.style.height = `${rect.height}px`;
  }

  // Squarified Treemap Algorithm (Bruls, Huizing, van Wijk)
  function layoutTreemap(items, x, y, width, height) {
    const rects = [];
    if (!items.length || width <= 0 || height <= 0) return rects;

    const totalValue = items.reduce((sum, item) => sum + item.value, 0);
    if (totalValue <= 0) return rects;

    function squarify(children, row, w, rx, ry, rw, rh) {
      if (children.length === 0) {
        layoutRow(row, w, rx, ry, rw, rh);
        return;
      }
      const c = children[0];
      const newRow = [...row, c];
      if (row.length === 0 || worst(row, w) >= worst(newRow, w)) {
        squarify(children.slice(1), newRow, w, rx, ry, rw, rh);
      } else {
        const [nx, ny, nw, nh] = layoutRow(row, w, rx, ry, rw, rh);
        squarify(children, [], Math.min(nw, nh), nx, ny, nw, nh);
      }
    }

    function worst(row, w) {
      const s = row.reduce((sum, item) => sum + item.area, 0);
      if (s === 0 || w === 0) return Infinity;
      let rMax = 0, rMin = Infinity;
      row.forEach(item => {
        rMax = Math.max(rMax, item.area);
        rMin = Math.min(rMin, item.area);
      });
      const w2 = w * w;
      const s2 = s * s;
      return Math.max((w2 * rMax) / s2, s2 / (w2 * rMin));
    }

    function layoutRow(row, w, rx, ry, rw, rh) {
      const rowSum = row.reduce((sum, item) => sum + item.area, 0);
      const isHorizontal = rw === w;
      const rowThickness = w > 0 ? rowSum / w : 0;
      let offset = 0;

      row.forEach(item => {
        const itemLen = rowThickness > 0 ? item.area / rowThickness : 0;
        let ix, iy, iw, ih;
        if (isHorizontal) {
          ix = rx;
          iy = ry + offset;
          iw = rowThickness;
          ih = itemLen;
        } else {
          ix = rx + offset;
          iy = ry;
          iw = itemLen;
          ih = rowThickness;
        }
        rects.push({
          ...item.raw,
          x: ix,
          y: iy,
          w: iw,
          h: ih,
        });
        offset += itemLen;
      });

      if (isHorizontal) {
        return [rx + rowThickness, ry, rw - rowThickness, rh];
      } else {
        return [rx, ry + rowThickness, rw, rh - rowThickness];
      }
    }

    const totalArea = width * height;
    const prepared = items
      .map(item => ({
        raw: item,
        value: item.value,
        area: (item.value / totalValue) * totalArea,
      }))
      .filter(item => item.area > 0)
      .sort((a, b) => b.value - a.value);

    squarify(prepared, [], Math.min(width, height), x, y, width, height);
    return rects;
  }

  function renderTreemap() {
    if (!ctx) return;
    const w = treemapCanvas.width;
    const h = treemapCanvas.height;

    ctx.save();
    ctx.scale(dpr, dpr);
    const canvasW = w / dpr;
    const canvasH = h / dpr;

    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Filter items based on current zoom / filter
    let items = state.currentChunks;
    if (state.zoomStack.length > 0) {
      const currentZoom = state.zoomStack[state.zoomStack.length - 1];
      if (currentZoom.startsWith('kind:')) {
        const targetKind = currentZoom.slice(5);
        items = items.filter(c => (c.tool ? `tool:${c.tool}` : (c.sub || c.cat || c.kind)) === targetKind);
      } else if (currentZoom.startsWith('region:')) {
        const rId = parseInt(currentZoom.slice(7), 10);
        const region = state.currentRegions.find(r => r.id === rId);
        if (region) {
          items = items.filter(c => c.i >= region.from && (region.to == null || c.i < region.to));
        }
      } else {
        // Node key from tree
        const leafPart = currentZoom.split('/').pop();
        items = items.filter(c => c.leaf === leafPart || c.sub === leafPart || c.cat === leafPart);
      }
    }

    // Map to layout items
    const layoutItems = items.map(c => {
      const val = c[state.metric] || 1;
      const label = c.target ? (c.target.split('/').pop() || c.target) : (c.tool || c.sub || c.kind);
      return {
        ...c,
        value: val,
        label,
      };
    }).filter(i => i.value > 0);

    state.treemapRects = layoutTreemap(layoutItems, 2, 2, canvasW - 4, canvasH - 4);

    // Draw rectangles with WizTree 3D beveled borders
    state.treemapRects.forEach(r => {
      if (r.w < 2 || r.h < 2) return;

      const baseColor = getColor(r);
      const isHovered = state.hoveredRect === r;

      // Base fill
      ctx.fillStyle = baseColor;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // Subtle gradient highlight
      const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // 3D Bevel borders (WizTree look: top/left bright, bottom/right shadow)
      ctx.lineWidth = 1;
      // Top & Left
      ctx.strokeStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
      ctx.beginPath();
      ctx.moveTo(r.x + r.w, r.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.stroke();

      // Bottom & Right
      ctx.strokeStyle = isHovered ? '#ffff00' : 'rgba(0, 0, 0, 0.7)';
      ctx.beginPath();
      ctx.moveTo(r.x + r.w, r.y);
      ctx.lineTo(r.x + r.w, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.stroke();

      // Text label inside larger rects
      if (r.w > 45 && r.h > 24) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
        ctx.clip();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';
        ctx.fillText(r.label, r.x + 5, r.y + 14);

        if (r.h > 36) {
          ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillText(fmt(r[state.metric]), r.x + 5, r.y + 26);
        }
        ctx.restore();
      }
    });

    ctx.restore();
  }

  function setupCanvasEvents() {
    treemapCanvas.addEventListener('mousemove', e => {
      const b = treemapCanvas.getBoundingClientRect();
      const mx = e.clientX - b.left;
      const my = e.clientY - b.top;

      let found = null;
      for (let i = state.treemapRects.length - 1; i >= 0; i--) {
        const r = state.treemapRects[i];
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
          found = r;
          break;
        }
      }

      if (found !== state.hoveredRect) {
        state.hoveredRect = found;
        renderTreemap();
      }

      if (found) {
        treemapTooltip.classList.remove('hidden');
        treemapTooltip.style.left = `${Math.min(mx + 14, b.width - 240)}px`;
        treemapTooltip.style.top = `${Math.min(my + 14, b.height - 180)}px`;

        const targetLabel = found.target ? `<div><span class="tooltip-val" style="font-size:10px;color:#9cdcfe;">${found.target}</span></div>` : '';
        treemapTooltip.innerHTML = `
          <div class="tooltip-title">${found.tool || found.sub || found.kind}</div>
          ${targetLabel}
          <div class="tooltip-row"><span>Category:</span><span class="tooltip-val">${found.cat || '(none)'}</span></div>
          <div class="tooltip-row"><span>Distinct Size:</span><span class="tooltip-val">${fmt(found.tok)} tokens</span></div>
          <div class="tooltip-row"><span>Allocated:</span><span class="tooltip-val">${fmt(found.alloc)} tokens</span></div>
          <div class="tooltip-row"><span>Residency:</span><span class="tooltip-val">${found.live || 1} turns</span></div>
          <div class="tooltip-row"><span>Characters:</span><span class="tooltip-val">${(found.chars || 0).toLocaleString()}</span></div>
        `;
      } else {
        treemapTooltip.classList.add('hidden');
      }
    });

    treemapCanvas.addEventListener('mouseleave', () => {
      state.hoveredRect = null;
      treemapTooltip.classList.add('hidden');
      renderTreemap();
    });

    treemapCanvas.addEventListener('click', () => {
      if (state.hoveredRect) {
        const r = state.hoveredRect;
        const zoomLabel = r.tool ? `tool:${r.tool}` : (r.sub || r.cat || r.kind);
        state.zoomStack.push(zoomLabel);
        renderBreadcrumb();
        renderTreemap();
      }
    });
  }

  // Initialize on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
