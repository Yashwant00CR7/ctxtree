// ctxtree - WizTree & Context Surgeon Client Application
(function () {
  'use strict';

  // The server embeds a per-process token in the page and refuses API calls
  // without it, so no other website can read sessions or write forks.
  const CTX_TOKEN = (document.querySelector('meta[name="ctxtree-token"]') || {}).content || '';
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/')) {
      const headers = new Headers(init.headers || {});
      headers.set('X-Ctxtree-Token', CTX_TOKEN);
      if ((init.method || 'GET').toUpperCase() === 'POST' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };

  // A block may be rewritten only if it is in the context `claude --resume`
  // loads and the server has not locked it (signed thinking, sidechains, ...).
  const canEdit = (b) => !!(b && b.live && b.editable);
  const canBridge = (b) => canEdit(b) && b.blockType !== 'tool_use';
  const problemsText = (data) => [data.error || 'Request failed']
    .concat((data.problems || []).map(p => `  - ${p.error}`)).join('\n');

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
  const chipCountDead = document.getElementById('chip-count-dead');

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
    if (queueSize() && state.queue.sid !== sessionSelect.value &&
        !confirm(`The delete queue holds ${queueSize()} item(s) for session ${String(state.queue.sid).slice(0, 8)}. Switching sessions empties it. Continue?`)) {
      sessionSelect.value = state.sid;
      return;
    }
    state.sid = sessionSelect.value;
    resetQueue(state.sid);
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
      if (b.tok >= 2000 && canBridge(b) && (b.kind === 'tool_result' || b.kind === 'image')) {
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
    forkModalCount.textContent = state.stagedEdits.size + (queueSize() ? ` (plus ${queueSize()} item(s) from the delete queue)` : '');

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
    forkModalConfirmBtn.textContent = 'Forking...';

    // Staged edits and anything in the delete queue go into one fork. The
    // fingerprint lets the server refuse an edit whose block changed after this
    // page loaded, instead of writing over content you never saw.
    const payload = buildPayload();

    try {
      const res = await fetch('/api/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          note: forkNote.value || `Pruned ${state.stagedEdits.size} paragraphs without jumps`
        })
      });
      const data = await res.json();

      forkModal.classList.add('hidden');
      forkModalConfirmBtn.disabled = false;
      forkModalConfirmBtn.textContent = 'Confirm & Fork';

      if (data.ok) {
        showForkSuccess(data, (data.boot || []).filter(b => b.lasts).map(b => `${b.name}: ${b.lasts}`));

        state.stagedEdits.clear();
        state.openInlineEditors.clear();
        resetQueue(state.sid);
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
      } else {
        alert(`Fork not created. Nothing was written.\n\n${problemsText(data)}`);
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
      promises.push(fetch(`/api/boot?sid=${state.sid}`).then(r => r.json()).catch(() => null));
      promises.push(fetch(`/api/structure?sid=${state.sid}`).then(r => r.json()).catch(() => null));
    }

    const results = await Promise.all(promises);
    state.currentTree = results[0];
    state.findings = results[1];
    state.currentChunks = results[2];

    if (state.sid !== 'all') {
      state.contextData = results[3];
      state.boot = results[4] && !results[4].error ? results[4] : null;
      state.structure = results[5] && !results[5].error ? results[5] : null;
      if (state.queue.sid !== state.sid) resetQueue(state.sid);
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
      state.boot = null;
      state.structure = null;
    }
    updateQueueBadge();

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
        <div class="region-nav-prompt">💬 ${escapeHtml(r.prompt)}</div>
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

    const allBlocks = state.contextData.blocks;
    const deadBlocks = allBlocks.filter(b => !b.live);
    const blocks = allBlocks.filter(b => b.live);
    if (chipCountDead) chipCountDead.textContent = deadBlocks.length;

    chipCountAll.textContent = blocks.length;
    chipCountUser.textContent = blocks.filter(b => b.role === 'user' && b.kind === 'text').length;
    chipCountAssistant.textContent = blocks.filter(b => b.role === 'assistant').length;
    chipCountTools.textContent = blocks.filter(b => b.kind === 'tool_result' || b.kind === 'tool_use').length;
    chipCountHeavy.textContent = blocks.filter(b => b.tok >= 2000).length;
    chipCountRisk.textContent = blocks.filter(b => b.continuity.riskLevel === 'high' || b.continuity.riskLevel === 'medium').length;
    chipCountEdited.textContent = state.stagedEdits.size;

    let filtered = (state.filter === 'dead' ? deadBlocks : blocks).filter(b => {
      if (state.filter === 'dead') return true;
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
          <span>📍 Milestone: "${escapeHtml(regionObj.prompt)}"</span>
          <span style="font-size:11px;color:#888;font-weight:normal;">(${regionBlocks.length} items · ${fmt(regionObj.tok)} tok)</span>
        </div>
        <div class="region-narrative-meta">
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

      regionHdr.querySelector('.region-narrative-meta').addEventListener('click', e => e.stopPropagation());
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
    if (deadBlocks.length) narrativeStream.prepend(renderDeadBanner(deadBlocks));
    if (state.filter !== 'dead') {
      const bp = renderBootPanel();
      if (bp) narrativeStream.prepend(bp);
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
    if (!block.live) card.classList.add('is-dead');
    else if (!block.editable) card.classList.add('is-locked');
    card.id = `card-${block.id}`;

    const isEdited = state.stagedEdits.has(block.id);
    if (isEdited) card.classList.add('is-edited');

    const editObj = state.stagedEdits.get(block.id);
    const isInlineOpen = state.openInlineEditors.has(block.id) && canEdit(block);

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
          <span class="role-badge ${escapeHtml(block.kind)}">${escapeHtml(roleText)}</span>
          ${block.target ? `<span class="target-label" title="${escapeHtml(block.target)}">${escapeHtml(block.target)}</span>` : ''}
          ${!block.live ? `<span class="continuity-badge dead" title="Not in the context claude --resume loads">${escapeHtml(deadLabel(block))}</span>` : ''}
          ${block.live && !block.editable ? `<span class="continuity-badge locked" title="${escapeHtml(block.lock)}">🔒 Locked</span>` : ''}
          ${block.live ? `<span class="continuity-badge ${risk}" title="${escapeHtml(riskTooltip)}">${riskLabel}</span>` : ''}
        </div>
        <div class="card-metrics">
          <span>Turn ${block.turn}</span> ·
          <strong>${fmt(block.tok)} tok</strong> ·
          <span>${fmt(block.alloc)} alloc</span>
        </div>
        <div class="card-actions">
          <button class="wiz-btn small btn-card-edit" title="Edit this paragraph inline (or double-click text)" ${canEdit(block) ? '' : 'disabled'}>✏️ Edit</button>
          <button class="wiz-btn small btn-card-bridge" title="Insert seamless continuity bridge" ${canBridge(block) ? '' : 'disabled'}>🌉 Bridge</button>
          <button class="wiz-btn small btn-card-contract" title="Extract interface contract / signatures" ${canBridge(block) ? '' : 'disabled'}>📑 Contract</button>
          <button class="wiz-btn small btn-card-condense" title="Keep head & tail, condense middle" ${canBridge(block) ? '' : 'disabled'}>🗜️</button>
          ${isEdited ? `<button class="wiz-btn small danger btn-card-revert" title="Revert to original">↩️</button>` : ''}
        </div>
      </div>
      <div class="card-body">
        ${!block.live ? `<div class="card-lock-note">Not in the context <code>claude --resume</code> loads, so deleting or editing it saves nothing. ${escapeHtml(deadHint(block))}</div><div class="dead-actions-slot"></div>` : ''}
        ${block.live && !block.editable ? `<div class="card-lock-note">${escapeHtml(block.lock)}</div>` : ''}
        ${canEdit(block) && block.blockType === 'tool_use' ? `<div class="card-lock-note">Tool call input: edit as a JSON object. To reclaim its output, edit the matching result instead.</div>` : ''}
        <div class="card-content-preview ${isLongText ? 'card-content-collapsed' : ''}" title="Double-click to edit this paragraph">${escapeHtml(block.text)}</div>
        ${isLongText ? `<div class="card-content-toggle">▶ Show full content (${fmt(block.chars)} chars)</div>` : ''}

        <!-- In-Card Inline Editor -->
        ${isInlineOpen ? `
          <div class="card-inline-editor" id="inline-editor-${block.id}">
            <div class="inline-presets-row">
              <span>Quick Presets:</span>
              <button class="wiz-btn small btn-inline-bridge" ${canBridge(block) ? '' : 'disabled'}>🌉 Smart Bridge</button>
              <button class="wiz-btn small btn-inline-contract" ${canBridge(block) ? '' : 'disabled'}>📑 Contract / Signatures</button>
              <button class="wiz-btn small btn-inline-headtail" ${canBridge(block) ? '' : 'disabled'}>🗜️ Head & Tail</button>
              <button class="wiz-btn small warn btn-inline-autoheal" title="Auto-append downstream anchor terms for 100% zero-jump continuity">⚡ Auto-Heal Anchors</button>
            </div>
            ${block.continuity.downstreamCount > 0 ? `
              <div class="anchor-terms-row">
                <span style="color:#ffb74d;">Downstream anchors:</span>
                ${block.continuity.downstreamRefs.map(r => `<span class="anchor-term-pill" data-term="${escapeHtml(r.term)}" title="Click to insert into text">+ ${escapeHtml(r.term)} (turn ${r.turn})</span>`).join('')}
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
              <span>✓ STAGED FOR FORK</span>
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
        if (!canEdit(block)) return;
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

    const slot = card.querySelector('.dead-actions-slot');
    if (slot) { const acts = deadCardActions(block); if (acts) slot.replaceWith(acts); else slot.remove(); }
    return card;
  }

  function escapeHtml(str) {
    if (str == null || str === '') return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
              ${m.isEdited ? `<div class="sim-msg-tag">✓ BRIDGED CONTEXT (${escapeHtml(m.tool || m.kind)})</div>` : ''}
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

    function walk(node, depth, parentKey, path = []) {
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

      tr.addEventListener('contextmenu', (e) => {
        state.selectedNodeKey = fullKey;
        document.querySelectorAll('#tree-tbody tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
        openNodeMenu(e, { title: node.name, tok: node.tok, path });
      });

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
        node.children.forEach(child => walk(child, depth + 1, fullKey, [...path, child.key]));
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
        <td><strong>${escapeHtml(r.key)}</strong></td>
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
        <td><strong>${escapeHtml(r.name)}</strong></td>
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
        <td>${escapeHtml(f.projectName)}${f.grown ? ' <span class="continuity-badge medium" title="You resumed this fork and kept working in it">continued</span>' : ''}</td>
        <td style="color:#4caf50;">+${fmt(f.savedTok)} tok</td>
        <td style="color:#888;">${dateStr}</td>
        <td>
          <button class="wiz-btn small primary btn-resume-fork" data-sid="${f.forkSid}">Resume</button>
          <button class="wiz-btn small danger btn-revert-fork" data-sid="${f.forkSid}">Revert</button>
        </td>
      `;

      tr.querySelector('.btn-resume-fork').addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = f.resumeCmd || (f.cwd ? `cd ${JSON.stringify(f.cwd)} && claude --resume ${f.forkSid}` : `claude --resume ${f.forkSid}`);
        navigator.clipboard.writeText(cmd);
        alert(`Copied to clipboard:\n${cmd}${f.profileFile ? `\n\nThis fork removed boot overhead: always resume it with its --settings profile (or: ctxtree resume ${f.forkSid.slice(0, 8)}).` : ''}`);
      });

      tr.querySelector('.btn-revert-fork').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Revert and delete fork ${f.forkSid.slice(0, 8)}? The parent session is never touched.`)) return;
        const revert = (force) => fetch('/api/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forkSid: f.forkSid, force })
        }).then(r => r.json());
        let data = await revert(false);
        // The server refuses to delete a fork you resumed and kept working in.
        if (!data.ok && confirm(`${data.error}\n\nDelete it anyway?`)) data = await revert(true);
        if (!data.ok && data.error) alert(problemsText(data));
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
        await loadAllData();
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
        successTokSaved.textContent = `Resumed context ~${fmt(data.resume.before)} → ~${fmt(data.resume.after)} tokens (${fmt(data.savedTok)} reclaimed)` +
          (data.deadEdits ? ` · ${data.deadEdits} result(s) outside the resumed context saved nothing` : '');
        successModal.classList.remove('hidden');
        state.selectedTuids.clear();
        state.forks = await fetch('/api/forks').then(r => r.json());
        renderForksTable();
      } else {
        alert(`Fork not created. Nothing was written.\n\n${problemsText(data)}`);
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

        const targetLabel = found.target ? `<div><span class="tooltip-val" style="font-size:10px;color:#9cdcfe;">${escapeHtml(found.target)}</span></div>` : '';
        treemapTooltip.innerHTML = `
          <div class="tooltip-title">${escapeHtml(found.tool || found.sub || found.kind)}</div>
          ${targetLabel}
          <div class="tooltip-row"><span>Category:</span><span class="tooltip-val">${escapeHtml(found.cat || '(none)')}</span></div>
          <div class="tooltip-row"><span>Distinct Size:</span><span class="tooltip-val">${fmt(found.tok)} tokens</span></div>
          <div class="tooltip-row"><span>Allocated:</span><span class="tooltip-val">${fmt(found.alloc)} tokens</span></div>
          <div class="tooltip-row"><span>Residency:</span><span class="tooltip-val">${found.live || 1} turns</span></div>
          <div class="tooltip-row"><span>Action:</span><span class="tooltip-val" style="color:#4caf50;">Click: open in editor · Right-click: delete</span></div>
        `;
      } else {
        treemapTooltip.classList.add('hidden');
      }
    });

    treemapCanvas.addEventListener('contextmenu', (e) => {
      const b = treemapCanvas.getBoundingClientRect();
      const mx = e.clientX - b.left, my = e.clientY - b.top;
      let found = null;
      for (let i = state.treemapRects.length - 1; i >= 0; i--) {
        const r = state.treemapRects[i];
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) { found = r; break; }
      }
      if (!found) return;
      treemapTooltip.classList.add('hidden');
      openRectMenu(e, found);
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

  // ==========================================
  // DELETE QUEUE · NODE MENU · BOOT OVERHEAD · GREY CONTENT
  // ==========================================
  // WizTree's loop: pick things in the tree or treemap, delete them together.
  // Every kind of deletion lands in one queue and one verified fork:
  //   tool results  -> tombstones
  //   boot overhead -> removed from the transcript + a launch profile
  //   grey content  -> uncompact / branch switch / slim (it saves nothing to
  //                    delete, so the actions that do something are offered)
  const btnQueue = document.getElementById('btn-queue');
  const queueCount = document.getElementById('queue-count');
  const queueDrawer = document.getElementById('queue-drawer');
  const queueBody = document.getElementById('queue-body');
  const queuePreview = document.getElementById('queue-preview');
  const queueSession = document.getElementById('queue-session');
  const queueNote = document.getElementById('queue-note');
  const queueApplyBtn = document.getElementById('queue-apply-btn');
  const queuePreviewBtn = document.getElementById('queue-preview-btn');
  const nodeMenu = document.getElementById('node-menu');
  const successProfile = document.getElementById('success-profile');

  const newQueue = (sid) => ({ sid, blocks: new Map(), boot: new Map(), uncompact: false, slim: false, switchTo: null });
  state.queue = newQueue(null);
  state.boot = null;
  state.structure = null;
  state.bootPanelOpen = false;
  state.bootExpanded = new Set();

  const queueSize = () => {
    const q = state.queue;
    return q.blocks.size + q.boot.size + (q.uncompact ? 1 : 0) + (q.slim ? 1 : 0) + (q.switchTo ? 1 : 0);
  };
  const TOMB_TOK = 30;   // a tombstone marker is roughly this long
  function queueEstimate() {
    const q = state.queue;
    let saved = 0;
    for (const b of q.blocks.values()) if (!state.stagedEdits.has(b.id)) saved += Math.max(0, b.tok - TOMB_TOK);
    for (const b of q.boot.values()) saved += b.tok;
    if (q.uncompact && state.structure && state.structure.compaction) saved -= state.structure.compaction.compactedTok;
    return saved;
  }
  function resetQueue(sid) {
    state.queue = newQueue(sid);
    queuePreview.innerHTML = '';
    updateQueueBadge();
  }
  function updateQueueBadge() {
    const n = queueSize();
    queueCount.textContent = n;
    btnQueue.classList.toggle('pulse', n > 0);
    if (!queueDrawer.classList.contains('hidden')) renderQueue();
  }
  function openQueue() { renderQueue(); queueDrawer.classList.remove('hidden'); }
  function closeQueue() { queueDrawer.classList.add('hidden'); }
  btnQueue.addEventListener('click', () => (queueDrawer.classList.contains('hidden') ? openQueue() : closeQueue()));
  document.getElementById('queue-close-btn').addEventListener('click', closeQueue);
  document.getElementById('queue-clear-btn').addEventListener('click', () => {
    if (queueSize() && !confirm('Empty the delete queue?')) return;
    resetQueue(state.sid);
    renderQueue();
    rerenderSurgeonExtras();
  });
  queuePreviewBtn.addEventListener('click', () => submitQueue(true));
  queueApplyBtn.addEventListener('click', () => submitQueue(false));

  function queueBlocks(items) {
    if (state.queue.sid !== state.sid) resetQueue(state.sid);
    for (const it of items) state.queue.blocks.set(it.id, it);
    queuePreview.innerHTML = '';
    updateQueueBadge();
  }
  function queueBoot(items) {
    if (state.queue.sid !== state.sid) resetQueue(state.sid);
    for (const it of items) state.queue.boot.set(it.id, it);
    queuePreview.innerHTML = '';
    updateQueueBadge();
    rerenderSurgeonExtras();
  }
  function setStructure(key, value) {
    if (state.queue.sid !== state.sid) resetQueue(state.sid);
    state.queue[key] = value;
    queuePreview.innerHTML = '';
    updateQueueBadge();
    rerenderSurgeonExtras();
  }

  function renderQueue() {
    const q = state.queue;
    const cur = state.sessions.find(s => s.sid === state.sid);
    queueSession.textContent = cur ? `${cur.sid.slice(0, 8)} · ${cur.projectName}` : '';
    queueBody.innerHTML = '';
    const staged = state.stagedEdits.size;
    if (!queueSize() && !staged) {
      queueBody.innerHTML = `<div class="queue-empty">Nothing queued.<br>Right-click a node in the tree or a rectangle in the treemap to delete it,<br>tick boot overhead in the Context Surgeon,<br>or use the actions on grey (outside-context) content.</div>`;
      queueApplyBtn.disabled = true; queuePreviewBtn.disabled = true;
      return;
    }
    queueApplyBtn.disabled = state.sid === 'all'; queuePreviewBtn.disabled = state.sid === 'all';

    const group = (title, sub, rows, tok) => {
      const g = document.createElement('div');
      g.className = 'queue-group';
      g.innerHTML = `<div class="queue-group-title"><span>${title}</span><span>${tok}</span></div>${sub ? `<div class="queue-group-sub">${sub}</div>` : ''}`;
      rows.forEach(r => g.appendChild(r));
      queueBody.appendChild(g);
    };
    const row = (label, detail, tok, onRemove, { grow = false, warn = '' } = {}) => {
      const r = document.createElement('div');
      r.className = 'queue-row';
      r.innerHTML = `<span class="q-label" title="${escapeHtml(label)}">${escapeHtml(label)}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}${warn ? `<span class="q-warn">⚠ ${escapeHtml(warn)}</span>` : ''}</span><span class="q-tok ${grow ? 'grow' : ''}">${tok}</span><button title="Remove from queue">✕</button>`;
      r.querySelector('button').addEventListener('click', () => { onRemove(); queuePreview.innerHTML = ''; updateQueueBadge(); renderQueue(); rerenderSurgeonExtras(); });
      return r;
    };

    const st = state.structure;
    const sRows = [];
    if (q.switchTo) {
      const b = st && st.branches.find(x => x.tip === q.switchTo);
      sRows.push(row(`⎇ Switch to rewind branch ${q.switchTo.slice(0, 8)}`, b && b.firstText ? `"${b.firstText}"` : 'The branch you are on stays in the parent session.', b ? `~${fmt(b.tok)} tok` : '', () => { q.switchTo = null; }, { grow: true }));
    }
    if (q.uncompact) {
      const c = st && st.compaction;
      sRows.push(row('↺ Uncompact: restore the history before the last compaction', 'The lossy summary is replaced by the real conversation. Queue tombstones for its heavy parts in the same fork.', c ? `+${fmt(c.compactedTok)} tok` : '', () => { q.uncompact = false; }, { grow: true }));
    }
    if (q.slim) sRows.push(row('🧹 Slim: drop everything resume never loads', `File ${st ? fmt(st.bytes) : '?'}B shrinks; the resumed request is byte-identical.`, '0 tok', () => { q.slim = false; }));
    if (sRows.length) group('Grey content', 'Deleting grey content saves nothing, so these act on it instead.', sRows, '');

    if (q.boot.size) {
      const items = [...q.boot.values()].sort((a, b) => b.tok - a.tok);
      const rows = items.map(it => row(it.label, '', `−${fmt(it.tok)}`, () => q.boot.delete(it.id), { warn: it.warn || '' }));
      const lasts = [...new Set(items.map(it => it.lasts).filter(Boolean))];
      group(`Boot overhead (${q.boot.size})`, `Removed from the fork's transcript. Anything Claude Code would re-announce is blocked by a launch profile the resume command passes.${lasts.length ? '<br>' + lasts.map(l => `• ${escapeHtml(l)}`).join('<br>') : ''}`, rows, `−${fmt(items.reduce((a, b) => a + b.tok, 0))} tok`);
    }
    if (q.blocks.size) {
      const list = [...q.blocks.values()].sort((a, b) => b.tok - a.tok);
      const rows = list.slice(0, 200).map(it => row(it.label, it.detail || '', `−${fmt(Math.max(0, it.tok - TOMB_TOK))}`, () => q.blocks.delete(it.id)));
      group(`Tool results → tombstones (${q.blocks.size})`, list.length > 200 ? `Showing the 200 largest of ${list.length}.` : '', rows, `−${fmt(list.reduce((a, b) => a + Math.max(0, b.tok - TOMB_TOK), 0))} tok`);
    }
    if (staged) {
      let savedEdits = 0;
      for (const e of state.stagedEdits.values()) savedEdits += (e.tokBefore - e.tokAfter);
      group(`Staged paragraph edits (${staged})`, 'From the Context Surgeon; they go into the same fork.', [], `−${fmt(savedEdits)} tok`);
    }
    const est = queueEstimate();
    const tot = document.createElement('div');
    tot.className = 'queue-group-sub';
    tot.textContent = `Estimated change to the resumed context: ${est >= 0 ? '−' : '+'}${fmt(Math.abs(est))} tokens. "Verify" builds and checks the fork without writing it.`;
    queueBody.appendChild(tot);
  }

  function buildPayload() {
    const q = state.queue;
    const blocksById = new Map(((state.contextData && state.contextData.blocks) || []).map(b => [b.id, b]));
    const edits = Array.from(state.stagedEdits.values()).map(e => ({ id: e.id, fp: (blocksById.get(e.id) || {}).fp, newText: e.newText }));
    for (const b of q.blocks.values()) if (!state.stagedEdits.has(b.id)) edits.push({ id: b.id, fp: b.fp, op: 'tombstone' });
    const structure = [];
    if (q.switchTo) structure.push({ op: 'switch', tip: q.switchTo });
    if (q.uncompact) structure.push({ op: 'uncompact' });
    if (q.slim) structure.push({ op: 'slim' });
    return { sid: state.sid, edits, boot: [...q.boot.keys()], structure };
  }

  async function submitQueue(dryRun) {
    if (state.sid === 'all') return;
    const payload = buildPayload();
    if (!payload.edits.length && !payload.boot.length && !payload.structure.length) return;
    if (!dryRun) {
      const parts = [
        payload.edits.length && `${payload.edits.length} block edit(s)/tombstone(s)`,
        payload.boot.length && `${payload.boot.length} boot removal(s)`,
        ...payload.structure.map(s => s.op),
      ].filter(Boolean).join(', ');
      if (!confirm(`Create a fork of ${state.sid.slice(0, 8)} with: ${parts}?\n\nThe parent session is never modified.`)) return;
    }
    queueApplyBtn.disabled = true; queuePreviewBtn.disabled = true;
    queuePreview.innerHTML = `<div class="qp-box">${dryRun ? 'Building and verifying the fork (nothing is written)…' : 'Forking…'}</div>`;
    let data;
    try {
      data = await fetch('/api/fork', { method: 'POST', body: JSON.stringify({ ...payload, dryRun, note: queueNote.value || '' }) }).then(r => r.json());
    } catch (err) {
      data = { error: String(err) };
    }
    queueApplyBtn.disabled = false; queuePreviewBtn.disabled = false;
    if (!data.ok) {
      queuePreview.innerHTML = `<div class="qp-box err">Fork not created. Nothing was written.\n${escapeHtml(problemsText(data))}</div>`;
      return;
    }
    const delta = data.resume.before - data.resume.after;
    const lasts = (data.boot || []).filter(b => b.lasts).map(b => `${b.name}: ${b.lasts}`);
    const box = `<div class="qp-box ok">
      <div>${dryRun ? '✅ Verified (dry run, nothing written)' : '✅ Fork created'}: <code>${escapeHtml(data.forkSid.slice(0, 8))}</code></div>
      <div>Resumed context: ~${fmt(data.resume.before)} → ~${fmt(data.resume.after)} tokens (${delta >= 0 ? `${fmt(delta)} reclaimed` : `${fmt(-delta)} more — restored history`})</div>
      <div>File: ${fmt(data.bytes.before)}B → ${fmt(data.bytes.after)}B</div>
      ${(data.structure || []).map(s => `<div>• ${escapeHtml(s.note)}</div>`).join('')}
      ${data.profile ? `<div>Launch profile (a --settings overlay; your config files are not touched):</div><pre>${escapeHtml(JSON.stringify(data.profile, null, 2))}</pre>` : ''}
      ${data.deadEdits ? `<div>${data.deadEdits} edit(s) were outside the resumed context and saved nothing.</div>` : ''}
      ${(data.structure || []).some(x => x.op === 'uncompact') && data.resume.after > 180000 ? `<div style="color:var(--accent-orange)">⚠ ~${fmt(data.resume.after)} tokens is near or over a 200k window. Queue tombstones for the restored history's heavy results, or resume with a 1M-context model.</div>` : ''}
    </div>`;
    queuePreview.innerHTML = box;
    if (!dryRun) {
      showForkSuccess(data, lasts);
      state.stagedEdits.clear();
      state.openInlineEditors.clear();
      resetQueue(state.sid);
      state.forks = await fetch('/api/forks').then(r => r.json());
      renderForksTable();
      closeQueue();
      await loadAllData();
    }
  }

  function showForkSuccess(data, lasts = []) {
    successCmdText.textContent = data.resumeCmd;
    const delta = data.resume.before - data.resume.after;
    successTokSaved.textContent = `Resumed context ~${fmt(data.resume.before)} → ~${fmt(data.resume.after)} tokens (${delta >= 0 ? `${fmt(delta)} reclaimed` : `${fmt(-delta)} restored`})` +
      (data.deadEdits ? ` · ${data.deadEdits} edit(s) outside the resumed context saved nothing` : '');
    if (data.profileFile) {
      successProfile.innerHTML = `<strong>Always resume this fork with its launch profile.</strong> Without <code>--settings</code> Claude Code re-announces the boot overhead you removed. Shortcut: <code>ctxtree resume ${escapeHtml(data.forkSid.slice(0, 8))}</code><br>Profile: <code>${escapeHtml(data.profileFile)}</code>` +
        (lasts.length ? `<br><br>${lasts.map(l => escapeHtml(l)).join('<br>')}` : '');
      successProfile.classList.remove('hidden');
    } else {
      successProfile.classList.add('hidden');
      successProfile.innerHTML = '';
    }
    successModal.classList.remove('hidden');
  }

  // ------------------------------------------------------------ node menu
  function closeNodeMenu() { nodeMenu.classList.add('hidden'); nodeMenu.innerHTML = ''; }
  document.addEventListener('click', (e) => { if (!nodeMenu.contains(e.target)) closeNodeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeNodeMenu(); } });
  window.addEventListener('blur', closeNodeMenu);

  function placeMenu(x, y) {
    nodeMenu.classList.remove('hidden');
    const r = nodeMenu.getBoundingClientRect();
    nodeMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    nodeMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }
  function menuItem(label, onClick, { danger = false, disabled = false } = {}) {
    const b = document.createElement('button');
    b.className = `nm-item${danger ? ' danger' : ''}`;
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeNodeMenu(); onClick(); });
    return b;
  }
  const menuNote = (text, warn = false) => { const d = document.createElement('div'); d.className = `nm-note${warn ? ' warn' : ''}`; d.textContent = text; return d; };
  const menuSep = () => { const d = document.createElement('div'); d.className = 'nm-sep'; return d; };

  function startMenu(e, title, sub) {
    e.preventDefault();
    e.stopPropagation();
    nodeMenu.innerHTML = `<div class="nm-head"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span>${escapeHtml(sub || '')}</span></div>`;
    placeMenu(e.clientX, e.clientY);
  }
  const deleteNow = (fn) => () => { fn(); openQueue(); submitQueue(true); };

  // path: [cat, sub, leaf] of a tree node (root = [])
  async function openNodeMenu(e, { title, tok, path }) {
    startMenu(e, title, `${fmt(tok)} tok`);
    if (state.sid === 'all') {
      nodeMenu.appendChild(menuNote('Deleting works on one session at a time. Pick a session from the dropdown first.'));
      placeMenu(e.clientX, e.clientY);
      return;
    }
    const [cat = 'root', sub = '', leaf = ''] = path;
    if (!['boot', 'tools', 'root'].includes(cat)) {
      const plan = await fetch(`/api/node-plan?sid=${state.sid}&cat=${encodeURIComponent(cat)}`).then(r => r.json());
      nodeMenu.appendChild(menuNote(plan.note || ''));
      nodeMenu.appendChild(menuItem('📖 Open the Context Surgeon', () => setViewMode('dual')));
      placeMenu(e.clientX, e.clientY);
      return;
    }
    nodeMenu.appendChild(menuNote('Working out what this node deletes…'));
    const qs = `sid=${state.sid}&cat=${encodeURIComponent(cat === 'root' ? 'tools' : cat)}&sub=${encodeURIComponent(sub)}&leaf=${encodeURIComponent(leaf)}`;
    const plan = await fetch(`/api/node-plan?${qs}`).then(r => r.json());
    nodeMenu.lastChild.remove();
    if (plan.error) { nodeMenu.appendChild(menuNote(plan.error, true)); placeMenu(e.clientX, e.clientY); return; }
    renderPlanMenu(plan, cat === 'root');
    placeMenu(e.clientX, e.clientY);
  }

  function renderPlanMenu(plan, isRoot = false) {
    if (plan.kind === 'boot') {
      const items = plan.items.map(it => ({ id: it.id, tok: it.tok, label: `${it.kind === 'mcp' ? 'MCP server' : it.kind === 'md' ? 'CLAUDE.md' : it.kind === 'sys' ? 'System prompt' : it.kind === 'tool' ? 'Tool' : it.kind === 'skill' ? 'Skill' : 'Agent'}: ${it.name}`, lasts: it.lasts, warn: it.warn }));
      if (!items.length) { nodeMenu.appendChild(menuNote(plan.note || 'Nothing here can be removed.')); return; }
      const n = items.length;
      nodeMenu.appendChild(menuItem(`🗑 Remove from context… (${n} item${n > 1 ? 's' : ''}, ~${fmt(plan.tok)} tok)`, deleteNow(() => queueBoot(items)), { danger: true }));
      nodeMenu.appendChild(menuItem(`➕ Add to delete queue`, () => queueBoot(items)));
      const warns = [...new Set(plan.items.map(i => i.warn).filter(Boolean))];
      warns.slice(0, 3).forEach(w => nodeMenu.appendChild(menuNote(`⚠ ${w}`, true)));
      if (n === 1) nodeMenu.appendChild(menuNote(`${plan.items[0].how} Lasts: ${plan.items[0].lasts}`));
      else nodeMenu.appendChild(menuNote('Removed from the fork; a launch profile keeps Claude Code from re-announcing what it would.'));
      (plan.skipped || []).slice(0, 2).forEach(s => nodeMenu.appendChild(menuNote(`Skipped ${s.name}: ${s.reason}`)));
      return;
    }
    if (plan.kind === 'blocks') {
      const mk = (list) => list.map(it => ({ id: it.id, fp: it.fp, tok: it.tok, label: `${it.tool || 'Tool'} result`, detail: it.target }));
      const all = plan.items;
      if (!all.length) nodeMenu.appendChild(menuNote('No live tool result here that a tombstone would shrink.'));
      else {
        nodeMenu.appendChild(menuItem(`🗑 Delete ${all.length} result${all.length > 1 ? 's' : ''}… (~${fmt(plan.tok)} tok)`, deleteNow(() => queueBlocks(mk(all))), { danger: true }));
        nodeMenu.appendChild(menuItem(`➕ Add ${all.length} to delete queue`, () => queueBlocks(mk(all))));
        for (const min of [5000, 1000]) {
          const big = all.filter(i => i.tok >= min);
          if (big.length && big.length < all.length) {
            const t = big.reduce((a, b) => a + b.tok, 0);
            nodeMenu.appendChild(menuItem(`🗑 Delete only the ${big.length} over ${fmt(min)} tok… (~${fmt(t)})`, deleteNow(() => queueBlocks(mk(big))), { danger: true }));
          }
        }
      }
      const sk = plan.skipped || {};
      const bits = [sk.dead && `${sk.dead} outside the resumed context (~${fmt(sk.deadTok)} tok, saves nothing)`, sk.done && `${sk.done} already tombstoned`, sk.locked && `${sk.locked} locked`, sk.small && `${sk.small} under the size cut`].filter(Boolean);
      if (bits.length) nodeMenu.appendChild(menuNote(`Skipped: ${bits.join(' · ')}.`));
      if (isRoot) nodeMenu.appendChild(menuNote('Boot overhead has its own node: right-click "boot overhead" or anything under it.'));
      return;
    }
    nodeMenu.appendChild(menuNote(plan.note || 'Nothing here can be deleted.'));
  }

  // A treemap rectangle is one chunk: one tool result, or one boot item.
  function openRectMenu(e, r) {
    const title = r.target ? `${r.tool || r.sub}: ${r.target}` : (r.leaf ? `${r.sub}: ${r.leaf}` : (r.sub || r.kind));
    startMenu(e, title, `${fmt(r.tok)} tok · ${fmt(r.alloc)} alloc`);
    if (state.sid === 'all') {
      nodeMenu.appendChild(menuNote('Deleting works on one session at a time. Pick a session from the dropdown first.'));
      placeMenu(e.clientX, e.clientY);
      return;
    }
    if (r.cat === 'boot') {
      fetch(`/api/node-plan?sid=${state.sid}&cat=boot&sub=${encodeURIComponent(r.sub || '')}&leaf=${encodeURIComponent(r.leaf || '')}`)
        .then(x => x.json()).then(plan => { renderPlanMenu(plan); placeMenu(e.clientX, e.clientY); });
      return;
    }
    const blocks = (state.contextData && state.contextData.blocks) || [];
    const b = r.tuid ? blocks.find(x => x.tuid === r.tuid && x.blockType === 'tool_result') : null;
    if (b) {
      if (!b.live) addDeadMenu(b);
      else if (!b.editable) nodeMenu.appendChild(menuNote(b.lock || 'Locked.'));
      else {
        const item = { id: b.id, fp: b.fp, tok: b.tok, label: `${b.tool || 'Tool'} result`, detail: b.target };
        nodeMenu.appendChild(menuItem(`🗑 Delete this result… (~${fmt(b.tok)} tok)`, deleteNow(() => queueBlocks([item])), { danger: true }));
        nodeMenu.appendChild(menuItem('➕ Add to delete queue', () => queueBlocks([item])));
      }
      nodeMenu.appendChild(menuSep());
      nodeMenu.appendChild(menuItem('📖 Show in the Context Surgeon', () => jumpToBlock(b)));
    } else {
      nodeMenu.appendChild(menuNote('This is conversation or injected content: edit or bridge it in the Context Surgeon.'));
      nodeMenu.appendChild(menuItem('📖 Open the Context Surgeon', () => setViewMode('dual')));
    }
    placeMenu(e.clientX, e.clientY);
  }

  function addDeadMenu(b) {
    const st = state.structure;
    if (b.deadKind === 'compacted') {
      nodeMenu.appendChild(menuNote('Before the last compaction: resume does not load it, so deleting it saves 0 tokens.'));
      if (st && st.compaction && st.compaction.restorable)
        nodeMenu.appendChild(menuItem(`↺ Bring it back: uncompact (+~${fmt(st.compaction.compactedTok)} tok)`, () => { setStructure('uncompact', true); openQueue(); }));
    } else if (b.deadKind === 'branch' && st && st.branches.some(x => x.tip === b.branchTip)) {
      nodeMenu.appendChild(menuNote('On a rewind branch you left: resume does not load it, so deleting it saves 0 tokens.'));
      nodeMenu.appendChild(menuItem('⎇ Switch the fork to this branch', () => { setStructure('switchTo', b.branchTip); openQueue(); }));
    } else {
      nodeMenu.appendChild(menuNote('Stray result of an interrupted or retried call; resume never loads it (0 tokens).'));
    }
    if (st) nodeMenu.appendChild(menuItem('🧹 Slim the fork: drop everything resume never loads (0 tok, smaller file)', () => { setStructure('slim', true); openQueue(); }));
  }

  function jumpToBlock(b) {
    setViewMode('dual');
    if (!b.live) { state.filter = 'dead'; filterChips.forEach(c => c.classList.toggle('active', c.dataset.filter === 'dead')); }
    if (b.regionId != null) state.collapsedRegions.delete(b.regionId);
    renderNarrativeStream();
    setTimeout(() => {
      const card = document.getElementById(`card-${b.id}`);
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('highlight-flash'); setTimeout(() => card.classList.remove('highlight-flash'), 1800); }
    }, 100);
  }

  // ---------------------------------------------------- boot panel (surgeon)
  const KIND_ORDER = ['built-in tools', 'MCP servers', 'skills', 'CLAUDE.md', 'system prompt', 'agent listing'];
  function renderBootPanel() {
    const boot = state.boot;
    if (!boot || !boot.items.length) return null;
    const q = state.queue.sid === state.sid ? state.queue : newQueue(state.sid);
    const panel = document.createElement('div');
    panel.className = 'boot-panel';
    const queuedTok = [...q.boot.values()].reduce((a, b) => a + b.tok, 0);
    panel.innerHTML = `<div class="boot-panel-header"><span>${state.bootPanelOpen ? '▼' : '▶'}</span><strong>🧱 Boot overhead</strong><span class="bp-sub">~${fmt(boot.total)} tok re-sent with every turn: tool schemas, MCP servers, skills, CLAUDE.md, system prompt${queuedTok ? ` · ${fmt(queuedTok)} queued for removal` : ''}</span></div>`;
    panel.querySelector('.boot-panel-header').addEventListener('click', () => { state.bootPanelOpen = !state.bootPanelOpen; renderNarrativeStream(); });
    if (!state.bootPanelOpen) return panel;
    const body = document.createElement('div');
    body.className = 'boot-panel-body';
    const groups = new Map();
    for (const it of boot.items) { const l = groups.get(it.sub) || []; l.push(it); groups.set(it.sub, l); }
    const subs = [...groups.keys()].sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99));
    for (const sub of subs) {
      const list = groups.get(sub);
      const g = document.createElement('div');
      g.className = 'boot-group';
      g.innerHTML = `<div class="boot-group-title"><span>${escapeHtml(sub)} (${list.length})</span><span>~${fmt(list.reduce((a, i) => a + i.tok, 0))} tok</span></div>`;
      const open = state.bootExpanded.has(sub);
      for (const it of (open ? list : list.slice(0, 6))) {
        const row = document.createElement('div');
        const queued = q.boot.has(it.id);
        row.className = `boot-item${queued ? ' queued' : ''}${it.removable ? '' : ' locked'}`;
        const tip = [it.how, it.lasts && `Lasts: ${it.lasts}`, it.warn && `⚠ ${it.warn}`, it.reason].filter(Boolean).join('\n');
        row.innerHTML = `<input type="checkbox" ${queued ? 'checked' : ''} ${it.removable ? '' : 'disabled'} title="Remove from the fork"><label title="${escapeHtml(tip)}">${escapeHtml(it.display || it.name)}${it.source && it.kind === 'mcp' ? ` <span style="color:#888">(${escapeHtml(it.source)})</span>` : ''}${it.warn ? ' <span style="color:var(--accent-orange)">⚠</span>' : ''}</label><span class="bi-tok">${fmt(it.tok)}</span>`;
        const cb = row.querySelector('input');
        const toggle = () => {
          if (!it.removable) return;
          if (state.queue.boot.has(it.id)) { state.queue.boot.delete(it.id); queuePreview.innerHTML = ''; updateQueueBadge(); rerenderSurgeonExtras(); }
          else queueBoot([{ id: it.id, tok: it.tok, label: `${sub}: ${it.name}`, lasts: it.lasts, warn: it.warn }]);
        };
        cb.addEventListener('change', toggle);
        row.querySelector('label').addEventListener('click', toggle);
        g.appendChild(row);
      }
      if (list.length > 6) {
        const more = document.createElement('button');
        more.className = 'boot-more';
        more.textContent = open ? 'show fewer' : `show all ${list.length}`;
        more.addEventListener('click', () => { if (open) state.bootExpanded.delete(sub); else state.bootExpanded.add(sub); renderNarrativeStream(); });
        g.appendChild(more);
      }
      body.appendChild(g);
    }
    panel.appendChild(body);
    return panel;
  }

  // ------------------------------------------------- grey content actions
  function renderDeadBanner(deadBlocks) {
    const st = state.structure;
    const q = state.queue.sid === state.sid ? state.queue : newQueue(state.sid);
    const deadTok = deadBlocks.reduce((a, b) => a + (b.tok || 0), 0);
    const note = document.createElement('div');
    note.className = 'dead-context-banner';
    note.innerHTML = `<div>${deadBlocks.length.toLocaleString()} blocks (~${fmt(deadTok)} tokens) are outside what <code>claude --resume</code> loads, so deleting them saves nothing. What you can do instead:</div><div class="dead-actions"></div>`;
    const actions = note.querySelector('.dead-actions');
    const btn = (label, on, fn, title = '') => {
      const b = document.createElement('button');
      b.className = `dead-action-btn${on ? ' queued' : ''}`;
      b.textContent = on ? `✓ ${label} (queued)` : label;
      b.title = title;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    if (st && st.compaction && st.compaction.restorable)
      btn(`↺ Uncompact: bring back ~${fmt(st.compaction.compactedTok)} tok of real history`, q.uncompact, () => setStructure('uncompact', !q.uncompact), 'Replaces the lossy compaction summary with the conversation it summarised. Tombstone its heavy parts in the same fork.');
    if (st && st.branches.length)
      btn(`⎇ ${st.branches.length} rewind branch${st.branches.length > 1 ? 'es' : ''} you left — show`, false, () => { state.filter = 'dead'; filterChips.forEach(c => c.classList.toggle('active', c.dataset.filter === 'dead')); renderNarrativeStream(); });
    btn(`🧹 Slim: drop it all from the fork (0 tok, smaller file)`, q.slim, () => setStructure('slim', !q.slim), 'The resumed request stays byte-identical; the file shrinks and parses faster.');
    btn('Show it', false, () => { state.filter = 'dead'; filterChips.forEach(c => c.classList.toggle('active', c.dataset.filter === 'dead')); renderNarrativeStream(); });
    return note;
  }

  function deadCardActions(block) {
    const st = state.structure;
    const q = state.queue.sid === state.sid ? state.queue : newQueue(state.sid);
    const wrap = document.createElement('div');
    wrap.className = 'dead-actions';
    const btn = (label, on, fn) => {
      const b = document.createElement('button');
      b.className = `dead-action-btn${on ? ' queued' : ''}`;
      b.textContent = on ? `✓ ${label} (queued)` : label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      wrap.appendChild(b);
    };
    if (block.deadKind === 'compacted' && st && st.compaction && st.compaction.restorable)
      btn('↺ Bring back into context (uncompact)', q.uncompact, () => setStructure('uncompact', !q.uncompact));
    else if (block.deadKind === 'branch' && st && st.branches.some(x => x.tip === block.branchTip))
      btn('⎇ Switch the fork to this branch', q.switchTo === block.branchTip, () => setStructure('switchTo', q.switchTo === block.branchTip ? null : block.branchTip));
    return wrap.children.length ? wrap : null;
  }
  const isRealBranch = (b) => b.deadKind === 'branch' && state.structure && state.structure.branches.some(x => x.tip === b.branchTip);
  const deadHint = (b) => (b.deadKind === 'compacted' ? 'Uncompacting the fork brings it back.'
    : isRealBranch(b) ? 'Switching the fork to its branch makes it the resumed conversation.'
      : 'It is a stray record of an interrupted or retried call.');
  const deadLabel = (b) => (b.deadKind === 'compacted' ? '⏸ Before the last compaction'
    : (b.deadKind === 'branch' && state.structure && state.structure.branches.some(x => x.tip === b.branchTip)) ? '⎇ On a rewind branch you left'
      : '⏸ Stray result, never loaded');

  function rerenderSurgeonExtras() {
    if (state.contextData) renderNarrativeStream();
  }

  // Initialize on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
