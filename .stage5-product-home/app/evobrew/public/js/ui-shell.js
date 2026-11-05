(function () {
  let baseInitialized = false;
  let initialized = false;
  let headerMetricsObserver = null;
  let runtimeContextObserver = null;
  let runtimeContextScheduled = false;
  let runtimeContextElements = null;

  const terminalFallbackActions = {
    toggleTerminalDock: () => {
      if (typeof window.showToast === 'function') {
        window.showToast('Terminal is not available. Verify terminal assets and restart Evobrew.', 'error');
      }
    },
    newTerminalSession: () => {
      if (typeof window.showToast === 'function') {
        window.showToast('Terminal is not available. Verify terminal assets and restart Evobrew.', 'error');
      }
    },
    focusTerminal: () => {
      if (typeof window.showToast === 'function') {
        window.showToast('Terminal is not available. Verify terminal assets and restart Evobrew.', 'error');
      }
    },
    killActiveTerminal: () => {
      if (typeof window.showToast === 'function') {
        window.showToast('Terminal is not available. Verify terminal assets and restart Evobrew.', 'error');
      }
    }
  };

  function parseArgs(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return [];
    try {
      return Function(`"use strict"; return [${trimmed}];`)();
    } catch (error) {
      console.warn('[UI Refresh] Failed to parse action args:', raw, error);
      return [];
    }
  }

  function runActionExpression(expr) {
    const trimmed = (expr || '').trim();
    const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/);
    if (!match) return;

    const fnName = match[1];
    const fn = window[fnName] || terminalFallbackActions[fnName];
    if (typeof fn !== 'function') {
      console.warn('[UI Refresh] Missing action function:', fnName);
      return;
    }

    const args = parseArgs(match[2]);
    return fn(...args);
  }

  function installDelegatedActions() {
    if (document.body.dataset.uiActionDelegation === 'ready') return;
    document.body.dataset.uiActionDelegation = 'ready';

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      if (target.disabled) return;

      const expr = target.getAttribute('data-action');
      if (!expr) return;

      event.preventDefault();
      runActionExpression(expr);

      if (target.closest('#runtime-context-sheet') && target.id !== 'runtime-context-summary') {
        requestAnimationFrame(() => closeRuntimeContextSheet());
      }
    });
  }

  function convertInlineActions() {
    const scope = [
      '.ide-header',
      '#sidebar',
      '#tablet-panel-bar',
      '.status-bar',
      '#search-panel',
      '#settings-panel',
      '#keyboard-help',
      '#folder-browser',
      '#brainPickerModal',
      '.header-overflow-menu',
      '#readme-tab-panel',
      '#query-tab-panel',
      '#explore-tab-panel',
      '#openclaw-tab-panel'
    ];

    const selector = scope
      .map((region) => `${region}[onclick], ${region} [onclick]`)
      .join(', ');
    document.querySelectorAll(selector).forEach((el) => {
      const onclick = el.getAttribute('onclick');
      if (!onclick) return;
      if (onclick.includes('if(') || onclick.includes(';')) return;
      el.setAttribute('data-action', onclick.trim());
      el.removeAttribute('onclick');
    });
  }

  function initOverflowMenu() {
    const toggle = document.getElementById('header-overflow-btn');
    const menu = document.getElementById('header-overflow-menu');
    if (!toggle || !menu) return;

    const closeMenu = () => {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', (event) => {
      if (menu.contains(event.target) || toggle.contains(event.target)) return;
      closeMenu();
    });

    window.closeHeaderOverflow = closeMenu;
    window.toggleHeaderOverflow = () => {
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
  }

  function normalizeA11y() {
    document.querySelectorAll('.btn-icon').forEach((btn) => {
      const hasLabel = btn.getAttribute('aria-label');
      if (!hasLabel) {
        const title = btn.getAttribute('title') || btn.getAttribute('data-tooltip') || 'Action';
        btn.setAttribute('aria-label', title);
      }
    });

    const sidePath = document.getElementById('sidebar-path');
    if (sidePath) {
      sidePath.setAttribute('role', 'button');
      sidePath.setAttribute('tabindex', '0');
      sidePath.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          runActionExpression(sidePath.getAttribute('data-action') || 'showFolderBrowser()');
        }
      });
    }
  }

  function syncHeaderMetrics() {
    const header = document.querySelector('.ide-header');
    if (!header) return;
    const height = Math.ceil(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--ui-shell-header-height', `${height}px`);
  }

  function bindHeaderMetrics() {
    syncHeaderMetrics();
    window.addEventListener('resize', syncHeaderMetrics);

    const header = document.querySelector('.ide-header');
    if (!header || typeof ResizeObserver !== 'function') return;

    if (headerMetricsObserver) {
      headerMetricsObserver.disconnect();
    }

    headerMetricsObserver = new ResizeObserver(() => syncHeaderMetrics());
    headerMetricsObserver.observe(header);
  }

  function getRuntimeContextElements() {
    if (runtimeContextElements) return runtimeContextElements;
    runtimeContextElements = {
      summaryEyebrow: document.querySelector('#runtime-context-summary .runtime-context-summary__eyebrow'),
      summaryButton: document.getElementById('runtime-context-summary'),
      summaryText: document.getElementById('runtime-context-summary-text'),
      sheet: document.getElementById('runtime-context-sheet'),
      setupChip: document.getElementById('runtime-setup-chip'),
      setupValue: document.getElementById('runtime-setup-chip-value'),
      folderChip: document.getElementById('runtime-folder-chip'),
      folderValue: document.getElementById('runtime-folder-chip-value'),
      workspaceChip: document.getElementById('runtime-workspace-chip'),
      workspaceValue: document.getElementById('runtime-workspace-chip-value'),
      brainChip: document.getElementById('runtime-brain-chip'),
      brainValue: document.getElementById('runtime-brain-chip-value'),
      modelChip: document.getElementById('runtime-model-chip'),
      modelValue: document.getElementById('runtime-model-chip-value'),
      editsChip: document.getElementById('runtime-edits-chip'),
      editsValue: document.getElementById('runtime-edits-chip-value'),
      terminalChip: document.getElementById('runtime-terminal-chip'),
      terminalValue: document.getElementById('runtime-terminal-chip-value'),
      sheetFolder: document.getElementById('runtime-sheet-folder'),
      sheetFolderValue: document.getElementById('runtime-sheet-folder-value'),
      sheetWorkspace: document.getElementById('runtime-sheet-workspace'),
      sheetWorkspaceValue: document.getElementById('runtime-sheet-workspace-value'),
      sheetBrain: document.getElementById('runtime-sheet-brain'),
      sheetBrainValue: document.getElementById('runtime-sheet-brain-value'),
      sheetModel: document.getElementById('runtime-sheet-model'),
      sheetModelValue: document.getElementById('runtime-sheet-model-value'),
      sheetEdits: document.getElementById('runtime-sheet-edits'),
      sheetEditsValue: document.getElementById('runtime-sheet-edits-value'),
      sheetTerminal: document.getElementById('runtime-sheet-terminal'),
      sheetTerminalValue: document.getElementById('runtime-sheet-terminal-value')
    };
    return runtimeContextElements;
  }

  function compactPath(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const normalized = raw.replace(/[\\/]+/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return raw;
    if (normalized.startsWith('/') && parts.length === 1) return `/${parts[0]}`;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]}/${parts[1]}`;
    return `…/${parts.slice(-2).join('/')}`;
  }

  function parsePendingEditsCount() {
    const edits = document.getElementById('status-edits');
    if (!edits || edits.classList.contains('hidden')) return 0;
    const text = String(edits.textContent || '').trim();
    const match = text.match(/(\d+)/);
    return match ? Number.parseInt(match[1], 10) || 0 : 0;
  }

  function isElementVisible(element) {
    if (!element) return false;
    return !element.classList.contains('hidden') && getComputedStyle(element).display !== 'none';
  }

  function isBrainConnectedLabel(label) {
    const normalized = String(label || '').trim().toLowerCase();
    if (!normalized) return false;
    return !['no brain', 'connect brain', 'no brain connected', 'not connected'].includes(normalized);
  }

  function hasModelSelection(label) {
    const normalized = String(label || '').trim().toLowerCase();
    if (!normalized) return false;
    return !['loading…', 'loading...', 'model'].includes(normalized);
  }

  function getSetupState(state) {
    const folderReady = Boolean(state.folderPath);
    const brainReady = folderReady && state.brainActive;
    const modelReady = brainReady && hasModelSelection(state.modelLabel);
    const workReady = modelReady;

    const next = !folderReady
      ? { action: 'showFolderBrowser()', label: 'Choose Folder' }
      : !brainReady
        ? { action: 'toggleBrainPicker()', label: 'Connect Brain' }
        : !modelReady
          ? { action: 'focusRuntimeModelPicker()', label: 'Choose Model' }
          : { action: "switchBrainTab('files')", label: 'Start Working' };

    return {
      folderReady,
      brainReady,
      modelReady,
      workReady,
      completedCount: [folderReady, brainReady, modelReady, workReady].filter(Boolean).length,
      next
    };
  }

  function readRuntimeContextState() {
    const sidebarPath = document.getElementById('sidebar-path');
    const workspaceBar = document.getElementById('workspace-bar');
    const branchName = document.getElementById('workspace-branch-name');
    const workspaceLabel = document.getElementById('workspace-label');
    const brainLabel = document.getElementById('brainPickerLabel');
    const modelSelect = document.getElementById('ai-model-select');
    const bottomDock = document.getElementById('bottom-dock');

    const folderPath = String(sidebarPath?.textContent || '').trim();
    const workspaceVisible = isElementVisible(workspaceBar);
    const workspaceActive = Boolean(window.activeWorkspaceId);
    const branch = String(branchName?.textContent || '').trim() || 'main';
    const workspaceText = workspaceActive
      ? `${branch}${workspaceLabel?.textContent ? ` · ${String(workspaceLabel.textContent).trim()}` : ''}`
      : workspaceVisible
        ? `Repo · ${branch}`
        : 'No workspace';

    const brainName = String(brainLabel?.textContent || '').trim() || 'Connect Brain';
    const selectedOption = modelSelect?.selectedOptions?.[0] || null;
    const modelLabel = String(selectedOption?.textContent || modelSelect?.value || 'Model').trim();
    const editsCount = parsePendingEditsCount();
    const terminalOpen = bottomDock ? !bottomDock.classList.contains('hidden') : false;
    const terminalAvailable = typeof window.toggleTerminalDock === 'function';

    return {
      folderPath,
      folderLabel: compactPath(folderPath, 'Choose Folder'),
      workspaceActive,
      workspaceVisible,
      workspaceLabel: workspaceText,
      brainActive: isBrainConnectedLabel(brainName),
      brainLabel: brainName,
      modelLabel,
      editsCount,
      terminalAvailable,
      terminalOpen,
      terminalLabel: terminalAvailable ? (terminalOpen ? 'Open' : 'Closed') : 'Unavailable'
    };
  }

  function setChipState(element, state) {
    if (!element) return;
    if (!state) {
      element.removeAttribute('data-state');
      return;
    }
    element.setAttribute('data-state', state);
  }

  function applyRuntimeContextState(state) {
    const els = getRuntimeContextElements();
    if (!els.summaryText) return;

    const setup = getSetupState(state);

    if (els.summaryEyebrow) {
      els.summaryEyebrow.textContent = `Setup · ${setup.completedCount}/4`;
    }

    if (els.setupValue) {
      els.setupValue.textContent = setup.workReady ? '4/4 · Ready' : `${setup.completedCount}/4 · ${setup.next.label}`;
    }

    if (els.setupChip) {
      els.setupChip.setAttribute('data-action', setup.next.action);
      els.setupChip.setAttribute('title', `Next recommended step: ${setup.next.label}`);
    }

    let summary = '';
    if (!setup.folderReady) {
      summary = 'Choose a folder to start working.';
    } else if (!setup.brainReady) {
      summary = 'Folder ready. Connect a brain for research and memory context.';
    } else if (!setup.modelReady) {
      summary = 'Folder and brain ready. Choose a model to continue.';
    } else {
      const summaryParts = [state.folderLabel, state.brainLabel, state.modelLabel, 'Ready to work'];
      if (state.editsCount > 0) {
        summaryParts.push(`${state.editsCount} edit${state.editsCount === 1 ? '' : 's'}`);
      }
      summary = summaryParts.filter(Boolean).join(' · ');
    }
    els.summaryText.textContent = summary;

    const valueMap = [
      [els.folderValue, state.folderLabel],
      [els.workspaceValue, state.workspaceLabel],
      [els.brainValue, state.brainLabel],
      [els.modelValue, state.modelLabel],
      [els.editsValue, `${state.editsCount} edit${state.editsCount === 1 ? '' : 's'} pending`],
      [els.terminalValue, state.terminalLabel],
      [els.sheetFolderValue, state.folderLabel],
      [els.sheetWorkspaceValue, state.workspaceLabel],
      [els.sheetBrainValue, state.brainLabel],
      [els.sheetModelValue, state.modelLabel],
      [els.sheetEditsValue, `${state.editsCount} edit${state.editsCount === 1 ? '' : 's'} pending`],
      [els.sheetTerminalValue, state.terminalLabel]
    ];

    valueMap.forEach(([element, value]) => {
      if (element) element.textContent = value;
    });

    const workspaceAction = state.workspaceActive
      ? 'workspaceDiff()'
      : state.workspaceVisible
        ? 'workspaceCreate()'
        : '';
    [els.workspaceChip, els.sheetWorkspace].forEach((element) => {
      if (!element) return;
      if (workspaceAction) element.setAttribute('data-action', workspaceAction);
      else element.removeAttribute('data-action');
      element.disabled = !workspaceAction;
    });

    [els.modelChip, els.sheetModel].forEach((element) => {
      if (!element) return;
      element.setAttribute('data-action', 'focusRuntimeModelPicker()');
    });

    [els.editsChip, els.sheetEdits].forEach((element) => {
      if (!element) return;
      element.classList.toggle('hidden', state.editsCount === 0);
    });

    setChipState(els.setupChip, setup.workReady ? 'success' : setup.folderReady ? 'attention' : 'warning');
    setChipState(els.folderChip, state.folderPath ? 'active' : null);
    setChipState(els.workspaceChip, state.workspaceActive ? 'attention' : state.workspaceVisible ? 'active' : null);
    setChipState(els.brainChip, state.brainActive ? 'active' : null);
    setChipState(els.modelChip, 'active');
    setChipState(els.editsChip, state.editsCount > 0 ? 'attention' : null);
    setChipState(els.terminalChip, state.terminalOpen ? 'success' : state.terminalAvailable ? 'active' : 'warning');
  }

  function syncRuntimeContext() {
    runtimeContextScheduled = false;
    applyRuntimeContextState(readRuntimeContextState());
    if (typeof window.refreshModeDescription === 'function') {
      window.refreshModeDescription();
    }
  }

  function scheduleRuntimeContextSync() {
    if (runtimeContextScheduled) return;
    runtimeContextScheduled = true;
    requestAnimationFrame(syncRuntimeContext);
  }

  function bindRuntimeContext() {
    const els = getRuntimeContextElements();
    if (!els.summaryText) return;
    const shell = document.getElementById('runtime-context-shell');
    if (shell) shell.classList.remove('hidden');

    if (runtimeContextObserver) {
      runtimeContextObserver.disconnect();
    }

    runtimeContextObserver = new MutationObserver(() => scheduleRuntimeContextSync());
    [
      document.getElementById('sidebar-path'),
      document.getElementById('workspace-bar'),
      document.getElementById('workspace-branch-name'),
      document.getElementById('workspace-label'),
      document.getElementById('brainPickerLabel'),
      document.getElementById('status-edits'),
      document.getElementById('bottom-dock')
    ].filter(Boolean).forEach((element) => {
      runtimeContextObserver.observe(element, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: ['class', 'style', 'data-state']
      });
    });

    document.addEventListener('change', (event) => {
      if (event.target?.id === 'ai-model-select') {
        scheduleRuntimeContextSync();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) {
        closeRuntimeContextSheet();
      }
      scheduleRuntimeContextSync();
    });
    window.addEventListener('cosmo:folderChanged', scheduleRuntimeContextSync);
    window.addEventListener('cosmo:brainLoaded', scheduleRuntimeContextSync);
    window.addEventListener('cosmo:brainUnloaded', scheduleRuntimeContextSync);
    window.addEventListener('evobrew:runtime-context-refresh', scheduleRuntimeContextSync);

    scheduleRuntimeContextSync();
    setTimeout(scheduleRuntimeContextSync, 250);
    setTimeout(scheduleRuntimeContextSync, 1000);
  }

  function closeRuntimeContextSheet() {
    const els = getRuntimeContextElements();
    if (!els.sheet || !els.summaryButton) return;
    els.sheet.classList.add('hidden');
    els.sheet.setAttribute('aria-hidden', 'true');
    els.summaryButton.setAttribute('aria-expanded', 'false');
  }

  function toggleRuntimeContextSheet() {
    const els = getRuntimeContextElements();
    if (!els.sheet || !els.summaryButton) return;
    const willOpen = els.sheet.classList.contains('hidden');
    els.sheet.classList.toggle('hidden', !willOpen);
    els.sheet.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
    els.summaryButton.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) scheduleRuntimeContextSync();
  }

  function focusRuntimeModelPicker() {
    if (typeof window.openRuntimeManager === 'function') {
      window.openRuntimeManager();
      return;
    }

    const select = document.getElementById('ai-model-select');
    if (!select) return;
    try {
      select.focus();
      select.click();
    } catch (_) {
      select.focus();
    }
  }

  function initShell() {
    if (initialized) return;
    initialized = true;

    document.body.classList.add('ui-refresh-enabled');
    const overflow = document.querySelector('.header-overflow');
    if (overflow) overflow.style.display = '';
    convertInlineActions();
    installDelegatedActions();
    initOverflowMenu();
    normalizeA11y();
    bindHeaderMetrics();
    bindRuntimeContext();

    if (window.UIRefreshPanels?.init) window.UIRefreshPanels.init();
    if (window.UIRefreshOnboarding?.init) window.UIRefreshOnboarding.init();
    if (window.UIRefreshShortcuts?.init) window.UIRefreshShortcuts.init();
    if (window.UIRefreshLiveSettings?.init) window.UIRefreshLiveSettings.init();
  }

  function maybeInitFromFlag(enabled) {
    if (!baseInitialized) {
      baseInitialized = true;
      installDelegatedActions();
      normalizeA11y();
    }

    if (enabled === false) {
      const overflow = document.querySelector('.header-overflow');
      if (overflow) overflow.style.display = 'none';
      return;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initShell, { once: true });
    } else {
      initShell();
    }
  }

  window.initUIRefresh = maybeInitFromFlag;
  window.toggleRuntimeContextSheet = toggleRuntimeContextSheet;
  window.closeRuntimeContextSheet = closeRuntimeContextSheet;
  window.focusRuntimeModelPicker = focusRuntimeModelPicker;
  window.refreshRuntimeContext = scheduleRuntimeContextSync;

  window.addEventListener('evobrew:ui-refresh-toggle', (event) => {
    maybeInitFromFlag(event?.detail?.enabled !== false);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      maybeInitFromFlag(window.uiRefreshEnabled === true);
    }, { once: true });
  } else {
    maybeInitFromFlag(window.uiRefreshEnabled === true);
  }
})();
