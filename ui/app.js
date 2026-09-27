// ctxtree - WizTree & Context Surgeon Client Application
(function () {
  'use strict';

  // Application State
  const state = {
    sid: 'all',
    viewMode: 'surgeon', // 'surgeon' | 'wiztree' | 'dual'
    metric: 'alloc', // 'alloc' or 'tok'
    modelStats: null,
    sessions: [],
    contextData: null, // full session context with paragraphs & regions
    stagedEdits: new Map(), // blockId -> edit object
    filter: 'all', // 'all' | 'user' | 'assistant' | 'tools' | 'heavy' | 'risk' | 'edited'
    searchQuery: '',
    selectedRegionId: null,
    activeEditingBlock: null,
    collapsedRegions: new Set(),
    openInlineEditors: new Set(),

    // WizTree components
    currentTree: null,
    currentChunks: [],
    findings: { proven: [], inferred: [], provenTotal: 0, inferredTotal: 0 },
    forks: [],
    expandedNodes: new Set(['root']),
    selectedNodeKey: null,
    selectedTuids: new Set(),
    treemapRects: [],
    zoomStack: [],
    hoveredRect: null,
  };

  // Color Palette mapping
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
    let h = 0;
    const str = String(key);
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffff;
    return `hsl(${Math.abs(h) % 360}, 65%, 45%)`;
  }

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
  const windowTitleText = document.getElementById('window-title-text');
  const mainWorkspace = document.getElementById('main-workspace');

  // Top Stats
  const statSelection = document.getElementById('stat-selection');
  const statAllocated = document.getElementById('stat-allocated');
  const statSize = document.getElementById('stat-size');
  const statCompacts = document.getElementById('stat-compacts');
  const meterPercent = document.getElementById('meter-percent');
  const meterBarFill = document.getElementById('meter-bar-fill');
  const badgeReclaim = document.getElementById('badge-reclaim');

  // Mode buttons
  const modeSurgeonBtn = document.getElementById('mode-surgeon-btn');
  const modeWizTreeBtn = document.getElementById('mode-wiztree-btn');
  const modeDualBtn = document.getElementById('mode-dual-btn');

  // Views
  const surgeonView = document.getElementById('surgeon-view');
  const wiztreeView = document.getElementById('wiztree-view');
  const surgeonToolbar = document.getElementById('surgeon-toolbar');

  // Surgeon Elements
  const surgeonRegionsList = document.getElementById('surgeon-regions-list');
  const narrativeStream = document.getElementById('narrative-stream');
  const surgeonSearchInput = document.getElementById('surgeon-search-input');
  const btnToggleRegions = document.getElementById('btn-toggle-regions');
  const btnBatchBridge = document.getElementById('btn-batch-bridge');
  const btnResetEdits = document.getElementById('btn-reset-edits');
  const btnForkJumpfree = document.getElementById('btn-fork-jumpfree');
  const stagedCountLabel = document.getElementById('staged-count-label');

  // Delta tracker
  const deltaOrigTok = document.getElementById('delta-orig-tok');
  const deltaNewTok = document.getElementById('delta-new-tok');
  const deltaSavedTok = document.getElementById('delta-saved-tok');
  const deltaContinuityStatus = document.getElementById('delta-continuity-status');

  // Filter chips
  const filterChips = document.querySelectorAll('.filter-chip');
  const chipCountAll = document.getElementById('chip-count-all');
  const chipCountUser = document.getElementById('chip-count-user');
  const chipCountAssistant = document.getElementById('chip-count-assistant');
  const chipCountTools = document.getElementById('chip-count-tools');
  const chipCountHeavy = document.getElementById('chip-count-heavy');
  const chipCountRisk = document.getElementById('chip-count-risk');
  const chipCountEdited = document.getElementById('chip-count-edited');

  // WizTree Elements
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

  // Treemap Elements
  const treemapCanvas = document.getElementById('treemap-canvas');
  const treemapContainer = document.getElementById('treemap-container');
  const treemapTooltip = document.getElementById('treemap-tooltip');
  const treemapBreadcrumb = document.getElementById('treemap-breadcrumb');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const metricAllocBtn = document.getElementById('metric-alloc');
  const metricSizeBtn = document.getElementById('metric-size');

  // Edit Paragraph Modal
  const editParagraphModal = document.getElementById('edit-paragraph-modal');
  const editModalTitle = document.getElementById('edit-modal-title');
  const editModalCloseBtn = document.getElementById('edit-modal-close-btn');
  const editModalCancelBtn = document.getElementById('edit-modal-cancel-btn');
  const editModalSaveBtn = document.getElementById('edit-modal-save-btn');
  const editMetaBadge = document.getElementById('edit-meta-badge');
  const editMetaTarget = document.getElementById('edit-meta-target');
  const editMetaTok = document.getElementById('edit-meta-tok');
  const editContinuityWarning = document.getElementById('edit-continuity-warning');
  const editContinuityTerms = document.getElementById('edit-continuity-terms');
  const editParagraphTextarea = document.getElementById('edit-paragraph-textarea');
  const editTokOrig = document.getElementById('edit-tok-orig');
  const editTokNew = document.getElementById('edit-tok-new');
  const editTokSaved = document.getElementById('edit-tok-saved');
  const btnPresetBridge = document.getElementById('btn-preset-bridge');
  const btnPresetHeadtail = document.getElementById('btn-preset-headtail');
  const btnPresetTombstone = document.getElementById('btn-preset-tombstone');
  const btnPresetOrig = document.getElementById('btn-preset-orig');

  // Fork Modal
  const forkModal = document.getElementById('fork-modal');
  const forkModalCloseBtn = document.getElementById('fork-modal-close-btn');
  const forkModalCancelBtn = document.getElementById('fork-modal-cancel-btn');
  const forkModalConfirmBtn = document.getElementById('fork-modal-confirm-btn');
  const forkModalCount = document.getElementById('fork-modal-count');
  const forkModalTokSaved = document.getElementById('fork-modal-tok-saved');
  const forkModalPctSaved = document.getElementById('fork-modal-pct-saved');
  const forkNote = document.getElementById('fork-note');

  // Success Modal
  const successModal = document.getElementById('success-modal');
  const successCloseBtn = document.getElementById('success-close-btn');
  const successDoneBtn = document.getElementById('success-done-btn');
  const successCmdText = document.getElementById('success-cmd-text');
  const successTokSaved = document.getElementById('success-tok-saved');
  const btnCopyCmd = document.getElementById('btn-copy-cmd');

  // Simulation & Auto-Heal Elements
  const simModal = document.getElementById('sim-modal');
  const simModalCloseBtn = document.getElementById('sim-modal-close-btn');
  const simModalCloseBottom = document.getElementById('sim-modal-close-bottom');
  const simBtnForkNow = document.getElementById('sim-btn-fork-now');
  const simOrigTok = document.getElementById('sim-orig-tok');
  const simNewTok = document.getElementById('sim-new-tok');
  const simSavedTok = document.getElementById('sim-saved-tok');
  const simPctSaved = document.getElementById('sim-pct-saved');
  const simContinuityBadge = document.getElementById('sim-continuity-badge');
  const simStream = document.getElementById('sim-stream');
  const btnOpenSim = document.getElementById('btn-open-sim');
  const btnAutoHealAll = document.getElementById('btn-auto-heal-all');

  // Mode switching
  function setViewMode(mode) {
    state.viewMode = mode;
    modeSurgeonBtn.classList.toggle('active', mode === 'surgeon');
    modeWizTreeBtn.classList.toggle('active', mode === 'wiztree');
    modeDualBtn.classList.toggle('active', mode === 'dual');

    mainWorkspace.classList.toggle('dual-mode', mode === 'dual');

    if (mode === 'surgeon') {
      surgeonView.classList.add('active');
      wiztreeView.classList.remove('active');
      surgeonToolbar.style.display = 'flex';
    } else if (mode === 'wiztree') {
      surgeonView.classList.remove('active');
      wiztreeView.classList.add('active');
      surgeonToolbar.style.display = 'none';
      renderTreemap();
    } else if (mode === 'dual') {
      surgeonView.classList.add('active');
      wiztreeView.classList.add('active');
      surgeonToolbar.style.display = 'flex';
      renderTreemap();
    }
  }

  modeSurgeonBtn.addEventListener('click', () => setViewMode('surgeon'));
  modeWizTreeBtn.addEventListener('click', () => setViewMode('wiztree'));
  modeDualBtn.addEventListener('click', () => setViewMode('dual'));

  // Tab switching in WizTree upper panel
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

  // Reset Zoom in Treemap
  btnZoomReset.addEventListener('click', () => {
    state.zoomStack = [];
    renderBreadcrumb();
    renderTreemap();
  });

  // Re-scan Button
  btnScan.addEventListener('click', async () => {
    btnScan.disabled = true;
    scanStatus.textContent = 'Scanning sessions...';
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await loadAllData();
      scanStatus.textContent = `Scan complete in ${(state.modelStats.scanMs / 1000).toFixed(2)} seconds`;
    } catch (err) {
      console.error(err);
      scanStatus.textContent = 'Scan failed';
    } finally {
      btnScan.disabled = false;
    }
  });

  // Session Dropdown Change
  sessionSelect.addEventListener('change', async () => {
    state.sid = sessionSelect.value;
    state.zoomStack = [];
    state.selectedNodeKey = null;
    state.stagedEdits.clear();
    state.collapsedRegions.clear();
    state.openInlineEditors.clear();
    await loadSessionView();
  });

  // Filter chips in Surgeon
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderNarrativeStream();
    });
  });

  // Search input in Surgeon
  surgeonSearchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderNarrativeStream();
  });

  // Toggle Regions (Expand All / Collapse All)
  if (btnToggleRegions) {
    btnToggleRegions.addEventListener('click', () => {
      if (!state.contextData || !state.contextData.regions) return;
      if (state.collapsedRegions.size > 0) {
        state.collapsedRegions.clear();
        btnToggleRegions.textContent = '📁 Collapse All';
      } else {
        state.contextData.regions.forEach(r => state.collapsedRegions.add(r.id));
        btnToggleRegions.textContent = '📁 Expand All';
      }
      renderNarrativeStream();
    });
  }

  // Batch Auto-Bridge Heavy
  btnBatchBridge.addEventListener('click', async () => {
    if (!state.contextData || !state.contextData.blocks) return;
    let count = 0;
    for (const b of state.contextData.blocks) {
      if (b.tok >= 2000 && (b.kind === 'tool_result' || b.kind === 'tool_use')) {
        let bridgeText = b.suggestedBridge;
        if (b.tool === 'Read' && b.target) {
          try {
            const cRes = await fetch('/api/context/contract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: b.text, filename: b.target })
            }).then(r => r.json());
            if (cRes.contract && cRes.contract.startsWith('[Interface Contract')) {
              bridgeText = cRes.contract;
            }
          } catch {}
        }
        // Auto heal downstream anchors for guaranteed zero jumps
        const downstream = b.continuity?.downstreamRefs || [];
        if (downstream.length > 0) {
          const textLower = bridgeText.toLowerCase();
          const missing = downstream.filter(r => !textLower.includes(r.term.toLowerCase())).map(r => r.term);
          if (missing.length > 0) {
            bridgeText = bridgeText.trim() + `\n[Continuity Anchors: ${Array.from(new Set(missing)).slice(0, 10).join(', ')}]`;
          }
        }

        const newTok = Math.max(1, Math.round(bridgeText.length / 3.6));
        state.stagedEdits.set(b.id, {
          id: b.id,
          recordIndex: b.recordIndex,
          contentIndex: b.contentIndex,
          newText: bridgeText,
          origText: b.originalText,
          tokBefore: b.tok,
          tokAfter: newTok,
          allocBefore: b.alloc,
          allocAfter: newTok * b.liveTurns,
          isBridged: true,
          note: 'Auto-bridged heavy block'
        });
        count++;
      }
    }

    renderNarrativeStream();
    updateDeltaTracker();
  });

  // Reset All Edits
  btnResetEdits.addEventListener('click', () => {
    if (state.stagedEdits.size === 0) return;
    if (confirm('Discard all staged paragraph edits?')) {
      state.stagedEdits.clear();
      state.openInlineEditors.clear();
      renderNarrativeStream();
      updateDeltaTracker();
    }
  });

  // Open Fork Modal
  btnForkJumpfree.addEventListener('click', () => {
    if (state.stagedEdits.size === 0 || state.sid === 'all') return;
    forkModalCount.textContent = state.stagedEdits.size;

    let savedTok = 0;
    for (const edit of state.stagedEdits.values()) {
      savedTok += (edit.tokBefore - edit.tokAfter);
    }
    const origTotal = state.contextData.totalTokens || 1;
    const pct = ((savedTok / origTotal) * 100).toFixed(1);

    forkModalTokSaved.textContent = fmt(savedTok);
    forkModalPctSaved.textContent = `${pct}% reclaimed`;
    forkModal.classList.remove('hidden');
  });

  forkModalCloseBtn.addEventListener('click', () => forkModal.classList.add('hidden'));
  forkModalCancelBtn.addEventListener('click', () => forkModal.classList.add('hidden'));

  forkModalConfirmBtn.addEventListener('click', async () => {
    forkModalConfirmBtn.disabled = true;
    forkModalConfirmBtn.textContent = 'Forking without jumps...';

    const editsArray = Array.from(state.stagedEdits.values()).map(e => ({
      id: e.id,
      recordIndex: e.recordIndex,
      contentIndex: e.contentIndex,
      newText: e.newText,
      tokBefore: e.tokBefore,
      tokAfter: e.tokAfter,
      allocBefore: e.allocBefore,
      allocAfter: e.allocAfter,
    }));

    try {
      const res = await fetch('/api/context/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid: state.sid,
          edits: editsArray,
          note: forkNote.value || `Pruned ${editsArray.length} paragraphs without jumps`
        })
      });
      const data = await res.json();

      forkModal.classList.add('hidden');
      forkModalConfirmBtn.disabled = false;
      forkModalConfirmBtn.textContent = 'Confirm & Fork';

      if (data.ok) {
        successCmdText.textContent = data.resumeCmd;
        successTokSaved.textContent = `${fmt(data.savedTok)} tokens reclaimed (${fmt(data.savedAlloc)} shipped)`;
        successModal.classList.remove('hidden');

        state.stagedEdits.clear();
        state.openInlineEditors.clear();
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
      } else {
        alert(`Error: ${data.error || 'Failed to save fork'}`);
      }
    } catch (err) {
      console.error(err);
      alert('Error saving forked session');
      forkModalConfirmBtn.disabled = false;
      forkModalConfirmBtn.textContent = 'Confirm & Fork';
    }
  });

  successCloseBtn.addEventListener('click', () => successModal.classList.add('hidden'));
  successDoneBtn.addEventListener('click', () => successModal.classList.add('hidden'));

  btnCopyCmd.addEventListener('click', () => {
    navigator.clipboard.writeText(successCmdText.textContent);
    btnCopyCmd.textContent = 'Copied!';
    setTimeout(() => { btnCopyCmd.textContent = 'Copy'; }, 1500);
  });

  // Simulation & Auto-Heal Listeners
  if (btnOpenSim) {
    btnOpenSim.addEventListener('click', openSimulationModal);
  }
  if (btnAutoHealAll) {
    btnAutoHealAll.addEventListener('click', autoHealAllEdits);
  }
  if (simModalCloseBtn) {
    simModalCloseBtn.addEventListener('click', () => simModal.classList.add('hidden'));
  }
  if (simModalCloseBottom) {
    simModalCloseBottom.addEventListener('click', () => simModal.classList.add('hidden'));
  }
  if (simBtnForkNow) {
    simBtnForkNow.addEventListener('click', () => {
      simModal.classList.add('hidden');
      btnForkJumpfree.click();
    });
  }

  // Initial Load
  async function init() {
    setupCanvas();
    await loadAllData();
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

      populateSessionSelect();
      updateTopStats();
      renderForksTable();

      if (state.sid === 'all' && state.sessions.length > 0) {
        state.sid = state.sessions[0].sid;
        sessionSelect.value = state.sid;
      }

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
      windowTitleText.textContent = `[All Sessions] - ctxtree Context Surgeon`;
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
        windowTitleText.textContent = `[${cur.sid.slice(0, 8)}] ${cur.projectName} - ctxtree Context Surgeon`;
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

    const promises = [
      fetch(`/api/tree?sid=${state.sid}`).then(r => r.json()),
      fetch(`/api/findings?sid=${state.sid}`).then(r => r.json()),
      fetch(`/api/chunks?sid=${state.sid}`).then(r => r.json())
    ];

    if (state.sid !== 'all') {
      promises.push(fetch(`/api/context?sid=${state.sid}`).then(r => r.json()));
    }

    const results = await Promise.all(promises);
    state.currentTree = results[0];
    state.findings = results[1];
    state.currentChunks = results[2];

    if (state.sid !== 'all') {
      state.contextData = results[3];
      state.currentRegions = state.contextData.regions || [];

      // Automatically collapse regions beyond the first 3 for fast initial view
      state.collapsedRegions.clear();
      if (state.currentRegions.length > 4) {
        for (let i = 3; i < state.currentRegions.length; i++) {
          state.collapsedRegions.add(state.currentRegions[i].id);
        }
        if (btnToggleRegions) btnToggleRegions.textContent = '📁 Expand All';
      }
    } else {
      state.contextData = null;
      state.currentRegions = [];
    }

    badgeReclaim.textContent = `${fmt(state.findings.provenTotal)} reclaimable`;

    renderTreeTable();
    renderFindings();
    renderKindTable();
    renderProjectsTable();
    renderBreadcrumb();
    renderTreemap();

    if (state.contextData) {
      renderRegionsSidebar();
      renderNarrativeStream();
      updateDeltaTracker();
    } else {
      surgeonRegionsList.innerHTML = `<div style="padding:15px;color:#888;">Select a specific session to inspect and edit paragraphs</div>`;
      narrativeStream.innerHTML = `<div style="text-align:center;padding:40px;color:#888;">Please select a specific session from the dropdown above to use the Context Surgeon</div>`;
    }
  }

  // ==========================================
  // CONTEXT SURGEON RENDERING & LOGIC
  // ==========================================

  function renderRegionsSidebar() {
    surgeonRegionsList.innerHTML = '';
    if (!state.contextData || !state.contextData.regions) return;

    state.contextData.regions.forEach(r => {
      const item = document.createElement('div');
      item.className = `region-nav-item ${state.selectedRegionId === r.id ? 'active' : ''}`;
      item.innerHTML = `
        <div class="region-nav-prompt">💬 ${r.prompt}</div>
        <div class="region-nav-meta">
          <span>Turn ${r.turn} · ${r.blocksCount} items</span>
          <span>${fmt(r.tok)} tok</span>
        </div>
      `;

      item.addEventListener('click', () => {
        state.selectedRegionId = r.id;
        document.querySelectorAll('.region-nav-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');

        // Expand region if collapsed
        state.collapsedRegions.delete(r.id);
        const wrapper = document.getElementById(`blocks-wrapper-${r.id}`);
        const caret = document.getElementById(`caret-${r.id}`);
        if (wrapper) wrapper.classList.remove('collapsed');
        if (caret) caret.textContent = '▼';

        const targetHeader = document.getElementById(`narrative-region-${r.id}`);
        if (targetHeader) {
          targetHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      surgeonRegionsList.appendChild(item);
    });
  }

  function renderNarrativeStream() {
    narrativeStream.innerHTML = '';
    if (!state.contextData || !state.contextData.blocks) return;

    const blocks = state.contextData.blocks;

    chipCountAll.textContent = blocks.length;
    chipCountUser.textContent = blocks.filter(b => b.role === 'user' && b.kind === 'text').length;
    chipCountAssistant.textContent = blocks.filter(b => b.role === 'assistant').length;
    chipCountTools.textContent = blocks.filter(b => b.kind === 'tool_result' || b.kind === 'tool_use').length;
    chipCountHeavy.textContent = blocks.filter(b => b.tok >= 2000).length;
    chipCountRisk.textContent = blocks.filter(b => b.continuity.riskLevel === 'high' || b.continuity.riskLevel === 'medium').length;
    chipCountEdited.textContent = state.stagedEdits.size;

    let filtered = blocks.filter(b => {
      if (state.filter === 'user') return b.role === 'user' && b.kind === 'text';
      if (state.filter === 'assistant') return b.role === 'assistant';
      if (state.filter === 'tools') return b.kind === 'tool_result' || b.kind === 'tool_use';
      if (state.filter === 'heavy') return b.tok >= 2000;
      if (state.filter === 'risk') return b.continuity.riskLevel === 'high' || b.continuity.riskLevel === 'medium';
      if (state.filter === 'edited') return state.stagedEdits.has(b.id);
      return true;
    });

    if (state.searchQuery) {
      const q = state.searchQuery;
      filtered = filtered.filter(b =>
        b.text.toLowerCase().includes(q) ||
        (b.target && b.target.toLowerCase().includes(q)) ||
        (b.tool && b.tool.toLowerCase().includes(q))
      );
    }

    // Group by region
    const blocksByRegion = new Map();
    filtered.forEach(b => {
      const rId = b.regionId || 0;
      const list = blocksByRegion.get(rId) || [];
      list.push(b);
      blocksByRegion.set(rId, list);
    });

    state.contextData.regions.forEach(regionObj => {
      const regionBlocks = blocksByRegion.get(regionObj.id);
      if (!regionBlocks || regionBlocks.length === 0) return;

      const isCollapsed = state.collapsedRegions.has(regionObj.id);

      const regionHdr = document.createElement('div');
      regionHdr.className = 'region-narrative-header';
      regionHdr.id = `narrative-region-${regionObj.id}`;
      regionHdr.innerHTML = `
        <div class="region-narrative-title">
          <span class="region-toggle-caret" id="caret-${regionObj.id}">${isCollapsed ? '▶' : '▼'}</span>
          <span>📍 Milestone: "${regionObj.prompt}"</span>
          <span style="font-size:11px;color:#888;font-weight:normal;">(${regionBlocks.length} items · ${fmt(regionObj.tok)} tok)</span>
        </div>
        <div class="region-narrative-meta" onclick="event.stopPropagation();">
          <button class="wiz-btn small btn-synth-region" data-region-id="${regionObj.id}" title="Synthesize this entire milestone into a clean continuity bridge">
            ✨ Synthesize Milestone
          </button>
        </div>
      `;

      regionHdr.addEventListener('click', () => {
        const wrapper = document.getElementById(`blocks-wrapper-${regionObj.id}`);
        const caret = document.getElementById(`caret-${regionObj.id}`);
        if (state.collapsedRegions.has(regionObj.id)) {
          state.collapsedRegions.delete(regionObj.id);
          if (wrapper) wrapper.classList.remove('collapsed');
          if (caret) caret.textContent = '▼';
        } else {
          state.collapsedRegions.add(regionObj.id);
          if (wrapper) wrapper.classList.add('collapsed');
          if (caret) caret.textContent = '▶';
        }
      });

      regionHdr.querySelector('.btn-synth-region').addEventListener('click', () => {
        synthesizeRegion(regionObj.id);
      });

      narrativeStream.appendChild(regionHdr);

      // Wrapper for cards
      const wrapper = document.createElement('div');
      wrapper.className = `region-blocks-wrapper ${isCollapsed ? 'collapsed' : ''}`;
      wrapper.id = `blocks-wrapper-${regionObj.id}`;

      regionBlocks.forEach(b => {
        const card = createParagraphCard(b);
        wrapper.appendChild(card);
      });

      narrativeStream.appendChild(wrapper);
    });

    if (filtered.length === 0) {
      narrativeStream.innerHTML = `<div style="text-align:center;padding:40px;color:#888;">No paragraphs match the selected filter.</div>`;
    }
  }

  function updateSingleCard(blockId) {
    const card = document.getElementById(`card-${blockId}`);
    if (!card || !state.contextData || !state.contextData.blocks) return;
    const block = state.contextData.blocks.find(b => b.id === blockId);
    if (!block) return;
    const newCard = createParagraphCard(block);
    card.replaceWith(newCard);
  }

  function createParagraphCard(block) {
    const card = document.createElement('div');
    card.className = 'paragraph-card';
    card.id = `card-${block.id}`;

    const isEdited = state.stagedEdits.has(block.id);
    if (isEdited) card.classList.add('is-edited');

    const editObj = state.stagedEdits.get(block.id);
    const isInlineOpen = state.openInlineEditors.has(block.id);

    const risk = block.continuity.riskLevel || 'low';
    const riskLabel = risk === 'high' ? '🔴 Critical Anchor' : (risk === 'medium' ? '🟡 Anchor' : '🟢 Safe to trim');
    const riskTooltip = block.continuity.downstreamCount > 0
      ? `Referenced in ${block.continuity.downstreamCount} subsequent turns: ${block.continuity.downstreamRefs.map(r => r.term).join(', ')}`
      : 'No downstream references detected';

    let roleText = block.role;
    if (block.kind === 'tool_result') roleText = `Tool Result: ${block.tool || 'Output'}`;
    else if (block.kind === 'tool_use') roleText = `Tool Call: ${block.tool}`;
    else if (block.kind === 'thinking') roleText = 'Thinking';
    else if (block.role === 'user') roleText = 'User Prompt';
    else if (block.role === 'assistant') roleText = 'Assistant';

    const isLongText = (block.text || '').length > 1200;

    card.innerHTML = `
      <div class="card-header">
        <div class="card-badges">
          <span class="role-badge ${block.kind}">${roleText}</span>
          ${block.target ? `<span class="target-label" title="${block.target}">${block.target}</span>` : ''}
          <span class="continuity-badge ${risk}" title="${riskTooltip}">${riskLabel}</span>
        </div>
        <div class="card-metrics">
          <span>Turn ${block.turn}</span> ·
          <strong>${fmt(block.tok)} tok</strong> ·
          <span>${fmt(block.alloc)} alloc</span>
        </div>
        <div class="card-actions">
          <button class="wiz-btn small btn-card-edit" title="Edit this paragraph inline (or double-click text)">✏️ Edit</button>
          <button class="wiz-btn small btn-card-bridge" title="Insert seamless continuity bridge">🌉 Bridge</button>
          <button class="wiz-btn small btn-card-contract" title="Extract interface contract / signatures">📑 Contract</button>
          <button class="wiz-btn small btn-card-condense" title="Keep head & tail, condense middle">🗜️</button>
          ${isEdited ? `<button class="wiz-btn small danger btn-card-revert" title="Revert to original">↩️</button>` : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="card-content-preview ${isLongText ? 'card-content-collapsed' : ''}" title="Double-click to edit this paragraph">${escapeHtml(block.text)}</div>
        ${isLongText ? `<div class="card-content-toggle">▶ Show full content (${fmt(block.chars)} chars)</div>` : ''}

        <!-- In-Card Inline Editor -->
        ${isInlineOpen ? `
          <div class="card-inline-editor" id="inline-editor-${block.id}">
            <div class="inline-presets-row">
              <span>Quick Presets:</span>
              <button class="wiz-btn small btn-inline-bridge">🌉 Smart Bridge</button>
              <button class="wiz-btn small btn-inline-contract">📑 Contract / Signatures</button>
              <button class="wiz-btn small btn-inline-headtail">🗜️ Head & Tail</button>
              <button class="wiz-btn small warn btn-inline-autoheal" title="Auto-append downstream anchor terms for 100% zero-jump continuity">⚡ Auto-Heal Anchors</button>
            </div>
            ${block.continuity.downstreamCount > 0 ? `
              <div class="anchor-terms-row">
                <span style="color:#ffb74d;">Downstream anchors:</span>
                ${block.continuity.downstreamRefs.map(r => `<span class="anchor-term-pill" data-term="${r.term}" title="Click to insert into text">+ ${r.term} (turn ${r.turn})</span>`).join('')}
              </div>
            ` : ''}
            <textarea class="inline-edit-textarea" rows="6" placeholder="Type edited paragraph context... (Cmd+Enter to save, Esc to cancel)">${escapeHtml(isEdited ? editObj.newText : block.text)}</textarea>
            <div class="inline-editor-bottom">
              <span class="inline-delta-preview">Original: ${fmt(block.tok)} tok ➔ Staged: <strong class="inline-new-tok">${fmt(isEdited ? editObj.tokAfter : block.tok)}</strong> tok</span>
              <div class="inline-editor-btns">
                <button class="wiz-btn small btn-inline-cancel">Cancel (Esc)</button>
                <button class="wiz-btn small primary btn-inline-save">Save Edit (Cmd+Enter)</button>
              </div>
            </div>
          </div>
        ` : ''}

        ${isEdited && !isInlineOpen ? `
          <div class="card-edited-state">
            <div class="card-edited-tag">
              <span>✓ STAGED FOR FORK (Zero Jumps)</span>
              <span>Tokens: ${fmt(editObj.tokBefore)} ➔ ${fmt(editObj.tokAfter)} (${fmt(editObj.tokBefore - editObj.tokAfter)} saved)</span>
            </div>
            <div class="card-edited-text">${escapeHtml(editObj.newText)}</div>
          </div>
        ` : ''}
      </div>
    `;

    // Long text preview toggle
    if (isLongText) {
      const toggleBtn = card.querySelector('.card-content-toggle');
      const previewEl = card.querySelector('.card-content-preview');
      if (toggleBtn && previewEl) {
        toggleBtn.addEventListener('click', () => {
          const isCollapsed = previewEl.classList.toggle('card-content-collapsed');
          toggleBtn.textContent = isCollapsed
            ? `▶ Show full content (${fmt(block.chars)} chars)`
            : `▲ Collapse content`;
        });
      }
    }

    // Double-click to open inline editor
    const previewEl = card.querySelector('.card-content-preview');
    if (previewEl) {
      previewEl.addEventListener('dblclick', () => {
        state.openInlineEditors.add(block.id);
        updateSingleCard(block.id);
      });
    }

    // Button actions
    card.querySelector('.btn-card-edit').addEventListener('click', () => {
      if (state.openInlineEditors.has(block.id)) {
        state.openInlineEditors.delete(block.id);
      } else {
        state.openInlineEditors.add(block.id);
      }
      updateSingleCard(block.id);
    });

    card.querySelector('.btn-card-bridge').addEventListener('click', () => applyBridgeToBlock(block));
    card.querySelector('.btn-card-contract').addEventListener('click', () => applyContractToBlock(block));
    card.querySelector('.btn-card-condense').addEventListener('click', () => applyCondenseToBlock(block));

    const revertBtn = card.querySelector('.btn-card-revert');
    if (revertBtn) {
      revertBtn.addEventListener('click', () => revertBlockEdit(block.id));
    }

    // In-Card Inline Editor handlers
    if (isInlineOpen) {
      const editorDiv = card.querySelector(`#inline-editor-${block.id}`);
      const textarea = editorDiv.querySelector('.inline-edit-textarea');
      const newTokEl = editorDiv.querySelector('.inline-new-tok');

      setTimeout(() => {
        textarea.focus();
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
      }, 10);

      const updateTok = () => {
        const newTok = Math.max(1, Math.round(textarea.value.length / 3.6));
        newTokEl.textContent = fmt(newTok);
      };

      textarea.addEventListener('input', updateTok);

      // Keyboard shortcuts: Cmd+Enter to save, Esc to cancel
      textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          saveCurrentInlineEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          state.openInlineEditors.delete(block.id);
          updateSingleCard(block.id);
        }
      });

      editorDiv.querySelector('.btn-inline-bridge').addEventListener('click', () => {
        textarea.value = block.suggestedBridge;
        updateTok();
      });

      editorDiv.querySelector('.btn-inline-contract').addEventListener('click', async () => {
        const cRes = await fetch('/api/context/contract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: block.text, filename: block.target })
        }).then(r => r.json());
        textarea.value = cRes.contract || block.suggestedBridge;
        updateTok();
      });

      editorDiv.querySelector('.btn-inline-headtail').addEventListener('click', () => {
        const lines = block.text.split('\n');
        if (lines.length > 30) {
          textarea.value = lines.slice(0, 15).join('\n') + `\n\n... [${lines.length - 30} lines condensed to eliminate context bloat] ...\n\n` + lines.slice(-15).join('\n');
        } else {
          textarea.value = block.text;
        }
        updateTok();
      });

      const autoHealBtn = editorDiv.querySelector('.btn-inline-autoheal');
      if (autoHealBtn) {
        autoHealBtn.addEventListener('click', async () => {
          try {
            const hRes = await fetch('/api/context/heal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sid: state.sid, blockId: block.id, text: textarea.value })
            }).then(r => r.json());
            if (hRes.healedText) {
              textarea.value = hRes.healedText;
              updateTok();
            }
          } catch {}
        });
      }

      // Anchor pills click to insert
      editorDiv.querySelectorAll('.anchor-term-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          const term = pill.dataset.term;
          textarea.value += `\n[Preserved symbol: ${term}]`;
          updateTok();
        });
      });

      editorDiv.querySelector('.btn-inline-cancel').addEventListener('click', () => {
        state.openInlineEditors.delete(block.id);
        updateSingleCard(block.id);
      });

      const saveCurrentInlineEdit = () => {
        const newText = textarea.value;
        const newTok = Math.max(1, Math.round(newText.length / 3.6));
        state.stagedEdits.set(block.id, {
          id: block.id,
          recordIndex: block.recordIndex,
          contentIndex: block.contentIndex,
          newText,
          origText: block.originalText,
          tokBefore: block.tok,
          tokAfter: newTok,
          allocBefore: block.alloc,
          allocAfter: newTok * block.liveTurns,
          isBridged: true,
          note: 'Inline edited'
        });
        state.openInlineEditors.delete(block.id);
        updateSingleCard(block.id);
        updateDeltaTracker();
      };

      editorDiv.querySelector('.btn-inline-save').addEventListener('click', saveCurrentInlineEdit);
    }

    return card;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function applyContractToBlock(block) {
    const cRes = await fetch('/api/context/contract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: block.text, filename: block.target })
    }).then(r => r.json());

    let contractText = cRes.contract || block.suggestedBridge;
    const newTok = Math.max(1, Math.round(contractText.length / 3.6));

    state.stagedEdits.set(block.id, {
      id: block.id,
      recordIndex: block.recordIndex,
      contentIndex: block.contentIndex,
      newText: contractText,
      origText: block.originalText,
      tokBefore: block.tok,
      tokAfter: newTok,
      allocBefore: block.alloc,
      allocAfter: newTok * block.liveTurns,
      isBridged: true,
      note: 'Extracted interface contract'
    });

    updateSingleCard(block.id);
    updateDeltaTracker();
  }

  function applyBridgeToBlock(block) {
    const bridgeText = block.suggestedBridge || `[Context Bridge: Condensed ${block.chars} chars (${block.tool}) to maintain continuity]`;
    const newTok = Math.max(1, Math.round(bridgeText.length / 3.6));
    state.stagedEdits.set(block.id, {
      id: block.id,
      recordIndex: block.recordIndex,
      contentIndex: block.contentIndex,
      newText: bridgeText,
      origText: block.originalText,
      tokBefore: block.tok,
      tokAfter: newTok,
      allocBefore: block.alloc,
      allocAfter: newTok * block.liveTurns,
      isBridged: true,
      note: 'Applied smart bridge'
    });

    updateSingleCard(block.id);
    updateDeltaTracker();
  }

  function applyCondenseToBlock(block) {
    const lines = block.text.split('\n');
    let condensedText = block.text;
    if (lines.length > 30) {
      const head = lines.slice(0, 15).join('\n');
      const tail = lines.slice(-15).join('\n');
      condensedText = `${head}\n\n... [${lines.length - 30} lines condensed to eliminate context bloat] ...\n\n${tail}`;
    } else {
      condensedText = block.suggestedBridge;
    }

    const newTok = Math.max(1, Math.round(condensedText.length / 3.6));
    state.stagedEdits.set(block.id, {
      id: block.id,
      recordIndex: block.recordIndex,
      contentIndex: block.contentIndex,
      newText: condensedText,
      origText: block.originalText,
      tokBefore: block.tok,
      tokAfter: newTok,
      allocBefore: block.alloc,
      allocAfter: newTok * block.liveTurns,
      isBridged: true,
      note: 'Condensed head & tail'
    });

    updateSingleCard(block.id);
    updateDeltaTracker();
  }

  function revertBlockEdit(blockId) {
    state.stagedEdits.delete(blockId);
    state.openInlineEditors.delete(blockId);
    updateSingleCard(blockId);
    updateDeltaTracker();
  }

  async function synthesizeRegion(regionId) {
    if (!state.sid || state.sid === 'all') return;
    try {
      const res = await fetch('/api/context/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: state.sid, regionId })
      }).then(r => r.json());

      if (res.ok && res.edits) {
        for (const edit of res.edits) {
          state.stagedEdits.set(edit.id, edit);
          updateSingleCard(edit.id);
        }
        updateDeltaTracker();
      }
    } catch (err) {
      console.error('Error synthesizing region:', err);
    }
  }

  async function autoHealAllEdits() {
    if (state.stagedEdits.size === 0) return;
    try {
      const editsArray = Array.from(state.stagedEdits.values()).map(e => ({
        id: e.id,
        newText: e.newText
      }));
      const valRes = await fetch('/api/context/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: state.sid, edits: editsArray })
      }).then(r => r.json());

      if (valRes.warnings && valRes.warnings.length > 0) {
        const missingByBlock = new Map();
        for (const w of valRes.warnings) {
          if (!missingByBlock.has(w.blockId)) missingByBlock.set(w.blockId, new Set());
          missingByBlock.get(w.blockId).add(w.missingTerm);
        }

        for (const [blockId, termsSet] of missingByBlock.entries()) {
          const edit = state.stagedEdits.get(blockId);
          if (!edit) continue;
          const blk = state.contextData.blocks.find(b => b.id === blockId);
          const terms = Array.from(termsSet).slice(0, 10);
          edit.newText = edit.newText.trim() + `\n[Continuity Anchors: ${terms.join(', ')}]`;
          edit.tokAfter = Math.max(1, Math.round(edit.newText.length / 3.6));
          if (blk) edit.allocAfter = edit.tokAfter * blk.liveTurns;
          state.stagedEdits.set(blockId, edit);
          updateSingleCard(blockId);
        }
        updateDeltaTracker();
      }
    } catch (err) {
      console.error('Error auto-healing edits:', err);
    }
  }

  async function openSimulationModal() {
    if (!state.sid || state.sid === 'all') return;
    try {
      const editsArray = Array.from(state.stagedEdits.values()).map(e => ({
        id: e.id,
        newText: e.newText,
        tokBefore: e.tokBefore,
        tokAfter: e.tokAfter
      }));
      const simRes = await fetch('/api/context/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: state.sid, edits: editsArray })
      }).then(r => r.json());

      simOrigTok.textContent = fmt(simRes.totalOriginalTok);
      simNewTok.textContent = fmt(simRes.totalSimulatedTok);
      simSavedTok.textContent = `${fmt(simRes.savedTok)} tok`;
      simPctSaved.textContent = `${simRes.pctSaved}%`;

      if (simRes.continuity.isClean) {
        simContinuityBadge.className = 'sim-badge ok';
        simContinuityBadge.textContent = '🛡️ 100% Continuity Verified (Zero Jumps)';
      } else {
        simContinuityBadge.className = 'sim-badge warn';
        simContinuityBadge.textContent = `⚠️ Continuity: ${simRes.continuity.healthScore}% (${simRes.continuity.warnings.length} anchors missing)`;
      }

      simStream.innerHTML = '';
      simRes.turns.forEach(turn => {
        const turnCard = document.createElement('div');
        turnCard.className = `sim-turn-card ${turn.role || 'assistant'}`;
        turnCard.innerHTML = `
          <div class="sim-turn-header">
            <span><strong>Turn ${turn.turn}</strong> · ${turn.role === 'user' ? '👤 User' : '🤖 Assistant'}</span>
            <span>${fmt(turn.tok)} tok</span>
          </div>
          ${turn.messages.map(m => `
            <div class="sim-msg-item ${m.isEdited ? 'edited' : ''}">
              ${m.isEdited ? `<div class="sim-msg-tag">✓ BRIDGED CONTEXT (${m.tool || m.kind})</div>` : ''}
              ${escapeHtml(m.text)}
            </div>
          `).join('')}
        `;
        simStream.appendChild(turnCard);
      });

      simModal.classList.remove('hidden');
    } catch (err) {
      console.error(err);
      alert('Failed to simulate resumed session');
    }
  }

  async function updateDeltaTracker() {
    if (!state.contextData) {
      deltaOrigTok.textContent = '0 tok';
      deltaNewTok.textContent = '0 tok';
      deltaSavedTok.textContent = '0 tok (0%)';
      btnForkJumpfree.disabled = true;
      stagedCountLabel.textContent = '0';
      deltaContinuityStatus.textContent = '100% Clean (Zero Jumps)';
      return;
    }

    const origTok = state.contextData.totalTokens || 0;
    let savedTok = 0;

    for (const edit of state.stagedEdits.values()) {
      savedTok += (edit.tokBefore - edit.tokAfter);
    }

    const newTok = Math.max(0, origTok - savedTok);
    const pct = origTok > 0 ? ((savedTok / origTok) * 100).toFixed(1) : 0;

    deltaOrigTok.textContent = `${fmt(origTok)} tok`;
    deltaNewTok.textContent = `${fmt(newTok)} tok`;
    deltaSavedTok.textContent = `${fmt(savedTok)} tok (-${pct}%)`;

    stagedCountLabel.textContent = state.stagedEdits.size;
    btnForkJumpfree.disabled = state.stagedEdits.size === 0;

    // Validate Continuity with server
    if (state.stagedEdits.size > 0) {
      try {
        const editsArray = Array.from(state.stagedEdits.values()).map(e => ({
          id: e.id,
          newText: e.newText
        }));
        const valRes = await fetch('/api/context/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: state.sid, edits: editsArray })
        }).then(r => r.json());

        if (valRes.isClean) {
          deltaContinuityStatus.textContent = `100% Verified (Zero Jumps)`;
          deltaContinuityStatus.style.color = '#4ec9b0';
        } else {
          deltaContinuityStatus.textContent = `Continuity: ${valRes.healthScore}% (${valRes.warnings.length} anchor terms suggested)`;
          deltaContinuityStatus.style.color = '#ff9800';
          deltaContinuityStatus.title = valRes.warnings.map(w => w.message).join('\n');
        }
      } catch {}
    } else {
      deltaContinuityStatus.textContent = `100% Clean (Zero Jumps)`;
      deltaContinuityStatus.style.color = '#4ec9b0';
    }
  }

  // ==========================================
  // WIZTREE ENGINE & TREEMAP
  // ==========================================

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
        state.zoomStack = [`kind:${r.key}`];
        renderBreadcrumb();
        renderTreemap();
      });

      kindTbody.appendChild(tr);
    });
  }

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
        const firstSess = state.sessions.find(s => s.project === r.project);
        if (firstSess) {
          sessionSelect.value = firstSess.sid;
          sessionSelect.dispatchEvent(new Event('change'));
        }
      });
      projectsTbody.appendChild(tr);
    });
  }

  function renderForksTable() {
    forksTbody.innerHTML = '';
    forksCountBadge.textContent = state.forks.length;

    if (!state.forks || state.forks.length === 0) {
      forksTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">No forked sessions yet. Edit and fork to resume smaller contexts.</td></tr>`;
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
  }

  btnPruneSelected.addEventListener('click', async () => {
    if (state.selectedTuids.size === 0 || state.sid === 'all') return;
    if (confirm(`Tombstone ${state.selectedTuids.size} duplicate/fat results and fork session?`)) {
      const res = await fetch('/api/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid: state.sid,
          tuids: Array.from(state.selectedTuids),
          note: 'Pruned findings'
        })
      });
      const data = await res.json();
      if (data.ok) {
        successCmdText.textContent = data.resumeCmd;
        successTokSaved.textContent = `${fmt(data.savedTok)} tokens reclaimed`;
        successModal.classList.remove('hidden');
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
      }
    }
  });

  // Treemap Breadcrumbs
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

  // Squarified Treemap Canvas Engine
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

    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, canvasW, canvasH);

    let items = state.currentChunks;
    if (state.zoomStack.length > 0) {
      const currentZoom = state.zoomStack[state.zoomStack.length - 1];
      if (currentZoom.startsWith('kind:')) {
        const targetKind = currentZoom.slice(5);
        items = items.filter(c => (c.tool ? `tool:${c.tool}` : (c.sub || c.cat || c.kind)) === targetKind);
      } else {
        const leafPart = currentZoom.split('/').pop();
        items = items.filter(c => c.leaf === leafPart || c.sub === leafPart || c.cat === leafPart);
      }
    }

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

    state.treemapRects.forEach(r => {
      if (r.w < 2 || r.h < 2) return;

      const baseColor = getColor(r);
      const isHovered = state.hoveredRect === r;

      ctx.fillStyle = baseColor;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      ctx.lineWidth = 1;
      ctx.strokeStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
      ctx.beginPath();
      ctx.moveTo(r.x + r.w, r.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.stroke();

      ctx.strokeStyle = isHovered ? '#ffff00' : 'rgba(0, 0, 0, 0.7)';
      ctx.beginPath();
      ctx.moveTo(r.x + r.w, r.y);
      ctx.lineTo(r.x + r.w, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.stroke();

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
          <div class="tooltip-row"><span>Action:</span><span class="tooltip-val" style="color:#4caf50;">Click to jump to Context Editor ➔</span></div>
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
        if (state.contextData && state.contextData.blocks) {
          const matchBlock = state.contextData.blocks.find(b =>
            (b.tuid && b.tuid === r.tuid) ||
            (b.tool === r.tool && b.target === r.target && Math.abs(b.tok - r.tok) < 10)
          );

          if (matchBlock) {
            setViewMode('dual');
            // Expand region if collapsed
            if (matchBlock.regionId != null) {
              state.collapsedRegions.delete(matchBlock.regionId);
              renderNarrativeStream();
            }

            setTimeout(() => {
              const card = document.getElementById(`card-${matchBlock.id}`);
              if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('highlight-flash');
                setTimeout(() => card.classList.remove('highlight-flash'), 1800);
              }
            }, 100);
            return;
          }
        }

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
