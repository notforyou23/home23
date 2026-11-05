(function () {
  let initialized = false;
  let emptyStateEl = null;

  const folderRequiredSelectors = [
    '[data-action="createNewFile()"]',
    '[data-action="createNewFolder()"]',
    '[data-action="refreshFileTree()"]',
    '#go-home-btn',
    '#go-up-btn',
    '#auto-refresh-btn'
  ];

  function hasSelectedFolder() {
    const sidebarPath = document.getElementById('sidebar-path');
    return Boolean(sidebarPath && sidebarPath.textContent.trim());
  }

  function ensureEmptyState() {
    if (emptyStateEl) return emptyStateEl;

    const host = document.querySelector('.editor-wrapper');
    if (!host) return null;

    emptyStateEl = document.createElement('div');
    emptyStateEl.className = 'onboarding-empty-state';
    emptyStateEl.id = 'onboarding-empty-state';
    emptyStateEl.innerHTML = `
      <div class="onboarding-card" role="region" aria-label="Workspace setup">
        <h2>Choose a Working Folder</h2>
        <p>Start by choosing a folder. Then connect a brain when you want research, memory context, and graph exploration.</p>
        <div class="onboarding-actions">
          <button class="onboarding-action primary" data-action="showFolderBrowser()">Choose Folder</button>
          <button class="onboarding-action" data-action="toggleBrainPicker()">Connect Brain</button>
          <button class="onboarding-action" data-action="showRecentFiles()">Open Recent</button>
        </div>
      </div>
    `;
    host.appendChild(emptyStateEl);
    return emptyStateEl;
  }

  function setDisabledState(element, disabled, message) {
    if (!element) return;

    if (!element.dataset.readinessTitle) {
      element.dataset.readinessTitle = element.getAttribute('title') || element.getAttribute('data-tooltip') || '';
    }

    element.disabled = Boolean(disabled);
    element.classList.toggle('readiness-disabled', Boolean(disabled));

    if (disabled) {
      if (message) {
        element.setAttribute('title', message);
        element.setAttribute('aria-label', message);
      }
    } else if (element.dataset.readinessTitle) {
      element.setAttribute('title', element.dataset.readinessTitle);
      element.setAttribute('aria-label', element.dataset.readinessTitle);
    }
  }

  function updateWorkspaceReadinessChrome(hasFolder) {
    document.body.classList.toggle('agent-ide-no-folder', !hasFolder);

    const message = 'Choose a folder first to enable workspace actions.';
    folderRequiredSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => setDisabledState(element, !hasFolder, message));
    });

    const brainFolderBtn = document.getElementById('brain-folder-btn');
    if (brainFolderBtn) {
      const shouldDisable = !hasFolder || brainFolderBtn.style.display === 'none';
      setDisabledState(brainFolderBtn, shouldDisable, hasFolder ? 'Connect a brain to open its folder.' : message);
    }

    const sidebarPath = document.getElementById('sidebar-path');
    if (sidebarPath && !hasFolder) {
      sidebarPath.textContent = 'No folder selected · Choose Folder to start';
      sidebarPath.setAttribute('title', 'Choose a working folder to start');
    }

    const hint = document.getElementById('ai-context-hint');
    if (hint) {
      hint.innerHTML = hasFolder
        ? 'Use the top <strong>Connect Brain</strong> button to attach memory context. Click the brain indicator to see retrieved context.'
        : 'Choose a working folder to start coding. Then connect a brain when you want memory context and retrieval.';
    }
  }

  function updateVisibility() {
    const el = ensureEmptyState();
    if (!el) return;

    const hasFolder = hasSelectedFolder();

    updateWorkspaceReadinessChrome(hasFolder);

    if (!hasFolder) {
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  }

  function wrap(fnName) {
    const original = window[fnName];
    if (typeof original !== 'function' || original.__onboardingWrapped) return;

    const wrapped = async function (...args) {
      const result = await original.apply(this, args);
      updateVisibility();
      return result;
    };

    wrapped.__onboardingWrapped = true;
    window[fnName] = wrapped;
  }

  function init() {
    if (initialized) return;
    initialized = true;

    ensureEmptyState();
    ['selectAndLoadFolder', 'loadFileTree', 'closeFolderBrowser', 'showFolderBrowser'].forEach(wrap);

    setTimeout(updateVisibility, 0);
    setTimeout(updateVisibility, 500);

    window.addEventListener('cosmo:brainLoaded', updateVisibility);
    window.addEventListener('cosmo:brainUnloaded', updateVisibility);

    window.UIRefreshOnboarding = {
      updateVisibility
    };
  }

  window.UIRefreshOnboarding = {
    init,
    updateVisibility
  };
})();
