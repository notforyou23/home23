(function () {
  const STORAGE_KEY = 'evobrew.ui.shortcuts.v2';
  let initialized = false;
  let mappings = {};
  let chordState = null;
  let keydownAttached = false;

  function getCommands() {
    if (typeof window.getCommandRegistry === 'function') return window.getCommandRegistry();
    if (Array.isArray(window.evobrewCommands)) return window.evobrewCommands;
    return [];
  }

  function getDefaultMappings() {
    const defaults = {};
    getCommands().forEach((cmd) => {
      if (!cmd?.id || !cmd?.keys) return;
      const first = String(cmd.keys).split('/')[0].trim();
      if (!first) return;
      defaults[cmd.id] = canonicalizeShortcut(first);
    });
    return defaults;
  }

  function canonicalizeShortcut(raw) {
    if (!raw) return '';
    return String(raw)
      .trim()
      .toLowerCase()
      .replace(/control|ctrl/g, 'cmd')
      .replace(/option|alt/g, 'alt')
      .replace(/command|meta/g, 'cmd')
      .replace(/\s*\+\s*/g, '+')
      .replace(/\s+/g, ' ')
      .replace(/^cmd\+\?$/, 'cmd+shift+/');
  }

  function readMappings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (error) {
      console.warn('[UI Refresh] Failed to parse shortcut mappings:', error);
      return {};
    }
  }

  function saveMappings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  }

  function toComboFromEvent(event) {
    const parts = [];
    if (event.metaKey || event.ctrlKey) parts.push('cmd');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    let key = event.key.toLowerCase();
    if (key === ' ') key = 'space';
    if (key === '~') key = '`';
    if (key === 'arrowup') key = 'up';
    if (key === 'arrowdown') key = 'down';
    if (key === 'arrowleft') key = 'left';
    if (key === 'arrowright') key = 'right';
    if (key === ',') key = ',';

    if (['meta', 'shift', 'control', 'alt'].includes(key)) return null;
    parts.push(key);
    return parts.join('+');
  }

  function getActiveMappings() {
    const defaults = getDefaultMappings();
    const merged = { ...defaults, ...mappings };
    return Object.entries(merged)
      .filter(([, shortcut]) => Boolean(shortcut))
      .map(([id, shortcut]) => ({
        id,
        steps: canonicalizeShortcut(shortcut).split(' ')
      }));
  }

  function runCommand(commandId) {
    if (typeof window.executeCommandById === 'function') {
      window.executeCommandById(commandId);
      return;
    }

    const cmd = getCommands().find((c) => c.id === commandId);
    if (cmd?.action) cmd.action();
  }

  function isTypingContext(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (target.isContentEditable) return true;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKeydown(event) {
    const combo = toComboFromEvent(event);
    if (!combo) return;

    const active = getActiveMappings();

    if (chordState && Date.now() <= chordState.expiresAt) {
      const matched = active.find((m) => m.steps.length === 2 && m.steps[0] === chordState.step && m.steps[1] === combo);
      chordState = null;
      if (matched) {
        event.preventDefault();
        event.stopPropagation();
        runCommand(matched.id);
        return;
      }
    }

    const typing = isTypingContext(event.target);

    const single = active.find((m) => m.steps.length === 1 && m.steps[0] === combo);
    if (single && (!typing || combo.startsWith('cmd+'))) {
      event.preventDefault();
      event.stopPropagation();
      runCommand(single.id);
      return;
    }

    const chord = active.find((m) => m.steps.length === 2 && m.steps[0] === combo);
    if (chord && (!typing || combo.startsWith('cmd+'))) {
      chordState = {
        step: combo,
        expiresAt: Date.now() + 1500
      };
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function detectConflicts(nextMappings) {
    const seen = new Map();
    const conflicts = new Set();

    Object.entries(nextMappings).forEach(([id, combo]) => {
      const normalized = canonicalizeShortcut(combo);
      if (!normalized) return;
      if (seen.has(normalized)) {
        conflicts.add(id);
        conflicts.add(seen.get(normalized));
      } else {
        seen.set(normalized, id);
      }
    });

    return conflicts;
  }

  function renderSettingsUI() {
    const settingsContent = document.querySelector('#settings-panel .settings-content');
    if (!settingsContent) return;

    let group = document.getElementById('shortcut-mapper-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'setting-group shortcuts-group';
      group.id = 'shortcut-mapper-group';
      group.innerHTML = `
        <div class="setting-group-title">Shortcut Mapping</div>
        <div id="shortcut-mapper"></div>
        <div class="shortcut-map-help">Click a field and press your shortcut. Use space-separated chords (for example: Cmd+K A).</div>
        <div id="shortcut-map-error" class="shortcut-map-error" aria-live="polite"></div>
      `;
      settingsContent.appendChild(group);
    }

    const container = document.getElementById('shortcut-mapper');
    if (!container) return;

    const defaults = getDefaultMappings();
    const editable = { ...defaults, ...mappings };

    container.innerHTML = getCommands().filter(c => c?.id).map((cmd) => {
      const value = editable[cmd.id] || '';
      return `
        <div class="shortcut-map-item">
          <label for="shortcut-${cmd.id}">${cmd.label}</label>
          <input id="shortcut-${cmd.id}" data-command-id="${cmd.id}" value="${value}" placeholder="Unassigned" />
        </div>
      `;
    }).join('');

    container.querySelectorAll('input[data-command-id]').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const combo = toComboFromEvent(event);
        if (!combo) return;

        const id = input.dataset.commandId;
        const next = { ...mappings, [id]: combo };
        const conflicts = detectConflicts({ ...defaults, ...next });

        const errorEl = document.getElementById('shortcut-map-error');
        if (conflicts.size > 0) {
          input.value = combo;
          if (errorEl) {
            errorEl.textContent = 'Shortcut conflict detected. Each command must have a unique key binding.';
          }
          return;
        }

        mappings = next;
        input.value = combo;
        if (errorEl) errorEl.textContent = '';
        saveMappings();

        try {
          const savedSettings = JSON.parse(localStorage.getItem('evobrew-settings') || '{}');
          savedSettings.shortcuts = mappings;
          localStorage.setItem('evobrew-settings', JSON.stringify(savedSettings));
        } catch (_error) {
          // Ignore settings sync failures; shortcuts still persist in v2 key.
        }
      });
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;

    mappings = readMappings();

    if (!keydownAttached) {
      keydownAttached = true;
      document.addEventListener('keydown', onKeydown, true);
    }

    renderSettingsUI();

    document.addEventListener('evobrew:settings-opened', renderSettingsUI);
  }

  window.UIRefreshShortcuts = {
    init,
    getMappings: () => ({ ...mappings })
  };
})();
