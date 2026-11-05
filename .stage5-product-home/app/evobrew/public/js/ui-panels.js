(function () {
  const STORAGE_KEY = 'evobrew.ui.layout.v2';
  let initialized = false;

  const state = {
    activeMode: 'files',
    leftPanel: 'open',
    rightPanel: 'open',
    overlays: {
      settings: false,
      palette: false,
      keyboardHelp: false,
      folderBrowser: false
    }
  };

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[UI Refresh] Failed to parse saved layout:', error);
      return null;
    }
  }

  function writeState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function syncFromDom() {
    const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
    if (activeTab) state.activeMode = activeTab;

    const sidebar = document.getElementById('sidebar');
    state.leftPanel = sidebar?.classList.contains('collapsed') ? 'collapsed' : 'open';

    const aiPanel = document.getElementById('ai-panel');
    state.rightPanel = aiPanel?.classList.contains('hidden') ? 'hidden' : 'open';

    state.overlays.settings = document.getElementById('settings-panel')?.classList.contains('open') || false;
    state.overlays.palette = !document.getElementById('command-palette')?.classList.contains('hidden');
    state.overlays.keyboardHelp = !document.getElementById('keyboard-help')?.classList.contains('hidden');
    state.overlays.folderBrowser = !document.getElementById('folder-browser')?.classList.contains('hidden');

    writeState();
  }

  function wrap(fnName) {
    const original = window[fnName];
    if (typeof original !== 'function' || original.__uiWrapped) return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      Promise.resolve(result).finally(() => {
        setTimeout(syncFromDom, 0);
      });
      return result;
    };

    wrapped.__uiWrapped = true;
    window[fnName] = wrapped;
  }

  function restoreState() {
    const saved = readState();
    if (!saved) return;

    Object.assign(state, saved);

    if (saved.activeMode && typeof window.switchBrainTab === 'function' && saved.activeMode !== 'files') {
      window.switchBrainTab(saved.activeMode);
    }

    if (saved.leftPanel === 'collapsed') {
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('collapsed') && typeof window.toggleSidebar === 'function') {
        window.toggleSidebar();
      }
    }

    if (saved.rightPanel === 'hidden') {
      const aiPanel = document.getElementById('ai-panel');
      if (aiPanel && !aiPanel.classList.contains('hidden') && typeof window.toggleAI === 'function') {
        window.toggleAI();
      }
    } else if (saved.rightPanel === 'open') {
      const aiPanel = document.getElementById('ai-panel');
      if (aiPanel && aiPanel.classList.contains('hidden') && typeof window.toggleAI === 'function') {
        window.toggleAI();
      }
    }

    syncFromDom();
  }

  function init() {
    if (initialized) return;
    initialized = true;

    [
      'switchBrainTab',
      'toggleSidebar',
      'toggleAI',
      'toggleSettings',
      'toggleKeyboardHelp',
      'toggleCommandPalette',
      'closeAllModals',
      'tabletShowPanel',
      'closeTabletSidebar',
      'closeTabletAI',
      'showFolderBrowser',
      'closeFolderBrowser'
    ].forEach(wrap);

    setTimeout(() => {
      restoreState();
      syncFromDom();
    }, 0);

    const observer = new MutationObserver(() => syncFromDom());
    ['sidebar', 'ai-panel', 'settings-panel', 'command-palette', 'keyboard-help', 'folder-browser'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    });

    window.addEventListener('beforeunload', syncFromDom);
    window.UIState = state;
  }

  window.UIRefreshPanels = { init, syncFromDom };
})();
