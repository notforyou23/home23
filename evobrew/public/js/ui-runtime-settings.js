(function () {
  const STORAGE_KEY = 'evobrew.ui.runtime-prefs.v1';
  const DEFAULTS = {
    favorites: [
      'anthropic/latest-sonnet',
      'anthropic/latest-opus',
      'openai-codex/latest-codex',
      'openai-codex/latest-mini',
      'openai-codex/latest-nano',
      'xai/latest-4-20',
      'xai/latest-4-20-moe',
      'ollama-cloud/latest-kimi',
      'ollama-cloud/latest-minimax',
      'ollama-cloud/latest-nemotron',
      'openclaw/openclaw:coz'
    ],
    recent: [],
    defaults: {
      chat: 'anthropic/latest-sonnet',
      query: 'anthropic/latest-sonnet',
      pgsSweep: 'anthropic/latest-sonnet',
      pgsSynth: 'anthropic/latest-sonnet'
    }
  };

  const RECOMMENDED_SECTIONS = [
    {
      title: 'Anthropic',
      note: 'Use stable Claude channels instead of dated model IDs.',
      values: ['anthropic/latest-sonnet', 'anthropic/latest-opus', 'anthropic/latest-haiku']
    },
    {
      title: 'OpenAI Codex',
      note: 'OAuth-backed Codex channels. Keep these separate from the OpenAI API catalog.',
      values: ['openai-codex/latest-codex', 'openai-codex/latest-mini', 'openai-codex/latest-nano']
    },
    {
      title: 'xAI',
      note: 'Curated Grok channels for fast, reasoning, and current 4.20 variants when available.',
      values: ['xai/latest-4-20', 'xai/latest-4-20-moe', 'xai/latest-reasoning', 'xai/latest-fast']
    },
    {
      title: 'Ollama Cloud',
      note: 'Low-cost cloud models worth rotating through.',
      values: ['ollama-cloud/latest-kimi', 'ollama-cloud/latest-minimax', 'ollama-cloud/latest-nemotron', 'ollama-cloud/latest-coder']
    },
    {
      title: 'Agents',
      note: 'Local or gateway-backed agent runtimes.',
      values: ['openclaw/openclaw:coz']
    }
  ];

  let initialized = false;
  let prefs = loadPrefs();
  let catalogCache = null;
  let catalogPromise = null;
  let catalogSearch = '';
  let showLegacyCatalog = false;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }
    console.log(`[runtime-settings:${type}]`, message);
  }

  function dedupe(values = []) {
    const seen = new Set();
    return values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  }

  function normalizePrefs(raw = {}) {
    const mergedDefaults = {
      ...DEFAULTS.defaults,
      ...(raw.defaults || {})
    };

    return {
      favorites: dedupe(raw.favorites || DEFAULTS.favorites),
      recent: dedupe(raw.recent || []).slice(0, 8),
      defaults: {
        chat: String(mergedDefaults.chat || DEFAULTS.defaults.chat),
        query: String(mergedDefaults.query || DEFAULTS.defaults.query),
        pgsSweep: String(mergedDefaults.pgsSweep || DEFAULTS.defaults.pgsSweep),
        pgsSynth: String(mergedDefaults.pgsSynth || DEFAULTS.defaults.pgsSynth)
      }
    };
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return normalizePrefs(DEFAULTS);
      return normalizePrefs(JSON.parse(raw));
    } catch (_error) {
      return normalizePrefs(DEFAULTS);
    }
  }

  function savePrefs(notify = true) {
    prefs = normalizePrefs(prefs);
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_error) {
      return;
    }

    if (notify) {
      window.dispatchEvent(new CustomEvent('evobrew:runtime-prefs-changed', {
        detail: getState()
      }));
    }
  }

  function getState() {
    return JSON.parse(JSON.stringify(normalizePrefs(prefs)));
  }

  function reset() {
    prefs = normalizePrefs(DEFAULTS);
    try {
      window.localStorage?.removeItem(STORAGE_KEY);
    } catch (_error) {
      return;
    }
    window.dispatchEvent(new CustomEvent('evobrew:runtime-prefs-changed', {
      detail: getState()
    }));
  }

  function setDefault(context, value) {
    if (!prefs.defaults[context]) return;
    prefs.defaults[context] = String(value || '').trim() || DEFAULTS.defaults[context];
    savePrefs(true);
  }

  function addFavorite(value) {
    const normalized = String(value || '').trim();
    if (!normalized || prefs.favorites.includes(normalized)) return false;
    prefs.favorites.push(normalized);
    savePrefs(true);
    return true;
  }

  function removeFavorite(value) {
    const normalized = String(value || '').trim();
    const next = prefs.favorites.filter((entry) => entry !== normalized);
    if (next.length === prefs.favorites.length) return false;
    prefs.favorites = next;
    savePrefs(true);
    return true;
  }

  function moveFavorite(value, direction) {
    const normalized = String(value || '').trim();
    const index = prefs.favorites.indexOf(normalized);
    if (index < 0) return false;

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= prefs.favorites.length) return false;

    const next = prefs.favorites.slice();
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    prefs.favorites = next;
    savePrefs(true);
    return true;
  }

  function recordRecent(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    prefs.recent = [normalized, ...prefs.recent.filter((entry) => entry !== normalized)].slice(0, 8);
    savePrefs(false);
  }

  function clearRecents() {
    prefs.recent = [];
    savePrefs(true);
  }

  function buildModelMap(data) {
    const map = new Map();
    (data?.models || []).forEach((model) => {
      const value = String(model.value || model.id || '').trim();
      if (!value || map.has(value)) return;
      map.set(value, model);
    });
    return map;
  }

  function optionHtml(model, selectedValue) {
    const value = String(model?.value || model?.id || '').trim();
    if (!value) return '';
    const selected = value === selectedValue ? 'selected' : '';
    return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(model.label || model.id || value)}</option>`;
  }

  function getRecommendedSections(modelMap) {
    return RECOMMENDED_SECTIONS.map((section) => ({
      ...section,
      items: section.values.map((value) => modelMap.get(value)).filter(Boolean)
    })).filter((section) => section.items.length > 0);
  }

  function getPickerGroups(data, currentValue) {
    const modelMap = buildModelMap(data);
    const used = new Set();
    const groups = [];

    const pick = (values) => values
      .map((value) => String(value || '').trim())
      .filter((value) => value && modelMap.has(value) && !used.has(value))
      .map((value) => {
        used.add(value);
        return modelMap.get(value);
      });

    const favorites = pick(prefs.favorites);
    if (favorites.length > 0) groups.push({ label: 'Favorites', items: favorites });

    const recent = pick(prefs.recent);
    if (recent.length > 0) groups.push({ label: 'Recent', items: recent });

    const agents = pick(Array.from(modelMap.values())
      .filter((model) => model.provider === 'openclaw')
      .map((model) => model.value || model.id));
    if (agents.length > 0) groups.push({ label: 'Agents', items: agents });

    const localAgents = pick(Array.from(modelMap.values())
      .filter((model) => model.provider?.startsWith('local:') && !model.isAlias)
      .map((model) => model.value || model.id));
    if (localAgents.length > 0) groups.push({ label: 'Local Agents', items: localAgents });

    const curatedCount = favorites.length + recent.length + agents.length;
    if (curatedCount < 6) {
      const fallbackRecommended = pick(RECOMMENDED_SECTIONS.flatMap((section) => section.values));
      if (fallbackRecommended.length > 0) groups.push({ label: 'Channels', items: fallbackRecommended });
    }

    const normalizedCurrent = String(currentValue || '').trim();
    if (normalizedCurrent && modelMap.has(normalizedCurrent) && !used.has(normalizedCurrent)) {
      groups.unshift({ label: 'Current', items: [modelMap.get(normalizedCurrent)] });
    }

    return groups;
  }

  function renderSelect(select, data, options = {}) {
    if (!select || !data?.models?.length) return false;

    const context = String(options.context || 'chat');
    const currentValue = String(options.currentValue || select.value || '').trim();
    const groups = getPickerGroups(data, currentValue);
    if (groups.length === 0) return false;

    const fragment = document.createDocumentFragment();
    groups.forEach((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.items.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.value || model.id;
        option.dataset.provider = model.provider;
        option.dataset.modelId = model.id;
        option.textContent = model.label || model.id;
        optgroup.appendChild(option);
      });
      fragment.appendChild(optgroup);
    });

    select.innerHTML = '';
    select.appendChild(fragment);

    const desired = [currentValue, prefs.defaults[context], DEFAULTS.defaults[context]]
      .map((value) => String(value || '').trim())
      .find((value) => value && Array.from(select.options).some((option) => option.value === value));

    if (desired) {
      select.value = desired;
    } else if (select.options[0]) {
      select.options[0].selected = true;
    }

    return true;
  }

  async function loadCatalog(force = false) {
    if (!force && catalogCache?.models?.length) return catalogCache;
    if (!force && catalogPromise) return catalogPromise;

    const modelCatalog = window.EvobrewModelCatalog;
    const cached = modelCatalog?.getCached?.();
    if (!force && cached?.models?.length) {
      catalogCache = cached;
      return cached;
    }

    catalogPromise = (modelCatalog?.fetch
      ? modelCatalog.fetch({ refresh: force === true })
      : fetch(force ? '/api/providers/models?refresh=1' : '/api/providers/models').then((response) => response.json()))
      .then((data) => {
        if (data?.models?.length) {
          catalogCache = data;
        }
        return catalogCache;
      })
      .finally(() => {
        catalogPromise = null;
      });

    return catalogPromise;
  }

  function ensureStyles() {
    if (document.getElementById('runtime-manager-styles')) return;
    const style = document.createElement('style');
    style.id = 'runtime-manager-styles';
    style.textContent = `
      .runtime-manager-modal.hidden { display: none; }
      .runtime-manager-modal { position: fixed; inset: 0; z-index: 10020; display: flex; align-items: center; justify-content: center; }
      .runtime-manager-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); border: none; cursor: pointer; }
      .runtime-manager-panel { position: relative; width: min(960px, 94vw); max-height: 88vh; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.45); }
      .runtime-manager-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 18px 20px; border-bottom: 1px solid var(--border-color); }
      .runtime-manager-title { font-size: 18px; font-weight: 700; color: var(--text-primary); }
      .runtime-manager-subtitle { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); max-width: 680px; }
      .runtime-manager-close { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 22px; line-height: 1; }
      .runtime-manager-body { padding: 18px 20px 22px; overflow: auto; display: grid; gap: 18px; }
      .runtime-manager-section { display: grid; gap: 10px; }
      .runtime-manager-section-title { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); }
      .runtime-manager-note { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
      .runtime-manager-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .runtime-manager-chip { border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary); border-radius: 999px; padding: 7px 11px; font-size: 11px; cursor: pointer; }
      .runtime-manager-chip.is-favorite { border-color: var(--accent-primary); color: var(--accent-primary); }
      .runtime-manager-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .runtime-manager-card { background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
      .runtime-manager-card-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
      .runtime-manager-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .runtime-manager-search { flex: 1; min-width: 240px; padding: 9px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); }
      .runtime-manager-list { display: grid; gap: 8px; }
      .runtime-manager-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--border-color); background: var(--bg-tertiary); border-radius: 10px; }
      .runtime-manager-row strong { display: block; font-size: 13px; color: var(--text-primary); }
      .runtime-manager-row span { display: block; font-size: 11px; color: var(--text-secondary); margin-top: 3px; }
      .runtime-manager-actions { display: inline-flex; gap: 6px; flex-wrap: wrap; }
      .runtime-manager-select-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .runtime-manager-select-grid select { width: 100%; padding: 9px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; }
      @media (max-width: 820px) { .runtime-manager-grid, .runtime-manager-select-grid { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    let modal = document.getElementById('runtime-manager-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'runtime-manager-modal';
    modal.className = 'runtime-manager-modal hidden';
    modal.innerHTML = `
      <button class="runtime-manager-backdrop" type="button" data-runtime-manager-action="close" aria-label="Close runtime manager"></button>
      <div class="runtime-manager-panel" role="dialog" aria-modal="true" aria-labelledby="runtime-manager-title">
        <div class="runtime-manager-header">
          <div>
            <div class="runtime-manager-title" id="runtime-manager-title">Runtime Manager</div>
            <div class="runtime-manager-subtitle">Keep the picker small and deliberate. Pin the runtimes you actually use, browse the full catalog here, and keep Codex separate from the legacy OpenAI API list.</div>
          </div>
          <button class="runtime-manager-close" type="button" data-runtime-manager-action="close" aria-label="Close">×</button>
        </div>
        <div class="runtime-manager-body" id="runtime-manager-body"></div>
      </div>
    `;
    modal.addEventListener('click', handleModalClick);
    modal.addEventListener('change', handleModalChange);
    modal.addEventListener('input', handleModalInput);
    document.body.appendChild(modal);
    return modal;
  }

  function ensureSettingsLauncher() {
    const settingsContent = document.querySelector('#settings-panel .settings-content');
    if (!settingsContent) return;

    let group = document.getElementById('runtime-settings-launcher-group');
    if (!group) {
      group = document.createElement('div');
      group.id = 'runtime-settings-launcher-group';
      group.className = 'setting-group';
      group.innerHTML = `
        <div class="setting-group-title">Runtimes</div>
        <div class="setting-item">
          <button class="btn" type="button" id="runtime-settings-launcher-btn">Open Runtime Manager</button>
          <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); line-height: 1.5;">Use Runtime Manager to curate favorites, pin Codex channels, and browse the full provider catalogs. Provider auth/setup still lives below in Server Setup & Status.</div>
        </div>
      `;
      settingsContent.appendChild(group);
      group.querySelector('#runtime-settings-launcher-btn')?.addEventListener('click', openManager);
    }
  }

  function isOpen() {
    const modal = document.getElementById('runtime-manager-modal');
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  function formatProviderTitle(providerId) {
    const provider = String(providerId || '').trim();
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'openai-codex') return 'OpenAI Codex';
    if (provider === 'openai') return 'OpenAI API';
    if (provider === 'ollama-cloud') return 'Ollama Cloud';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openclaw') return 'Agents';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  function compareProviderOrder(left, right) {
    const order = ['anthropic', 'openai-codex', 'xai', 'ollama-cloud', 'openclaw', 'openai', 'ollama', 'lmstudio'];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }

  function renderFavoritesSection(modelMap) {
    const items = prefs.favorites.map((value) => ({
      value,
      model: modelMap.get(value)
    }));

    if (items.length === 0) {
      return '<div class="runtime-manager-note">No favorites yet. Pin a few channels below and the picker will stay clean.</div>';
    }

    return `
      <div class="runtime-manager-list">
        ${items.map(({ value, model }) => `
          <div class="runtime-manager-row">
            <div>
              <strong>${escapeHtml(model?.label || value)}</strong>
              <span>${escapeHtml(value)}</span>
            </div>
            <div class="runtime-manager-actions">
              <button class="btn" type="button" data-runtime-action="move-up" data-runtime-value="${escapeHtml(value)}">↑</button>
              <button class="btn" type="button" data-runtime-action="move-down" data-runtime-value="${escapeHtml(value)}">↓</button>
              <button class="btn" type="button" data-runtime-action="toggle-favorite" data-runtime-value="${escapeHtml(value)}">Remove</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderDefaultsSection(data) {
    const options = (data?.models || []).map((model) => optionHtml(model, null)).join('');
    return `
      <div class="runtime-manager-select-grid">
        <label>
          <div class="runtime-manager-note" style="margin-bottom: 6px;">Default chat runtime</div>
          <select id="runtime-default-chat">${options}</select>
        </label>
        <label>
          <div class="runtime-manager-note" style="margin-bottom: 6px;">Default query runtime</div>
          <select id="runtime-default-query">${options}</select>
        </label>
        <label>
          <div class="runtime-manager-note" style="margin-bottom: 6px;">Default PGS sweep runtime</div>
          <select id="runtime-default-pgs-sweep">${options}</select>
        </label>
        <label>
          <div class="runtime-manager-note" style="margin-bottom: 6px;">Default PGS synthesis runtime</div>
          <select id="runtime-default-pgs-synth">${options}</select>
        </label>
      </div>
    `;
  }

  function renderRecommendedSection(modelMap) {
    const sections = getRecommendedSections(modelMap);
    if (sections.length === 0) {
      return '<div class="runtime-manager-note">No curated runtime channels are available yet. Configure providers first.</div>';
    }

    return `
      <div class="runtime-manager-grid">
        ${sections.map((section) => `
          <div class="runtime-manager-card">
            <div class="runtime-manager-card-title">${escapeHtml(section.title)}</div>
            <div class="runtime-manager-note">${escapeHtml(section.note)}</div>
            <div class="runtime-manager-chip-row">
              ${section.items.map((model) => {
                const value = String(model.value || model.id || '').trim();
                const favorite = prefs.favorites.includes(value);
                return `<button class="runtime-manager-chip ${favorite ? 'is-favorite' : ''}" type="button" data-runtime-action="toggle-favorite" data-runtime-value="${escapeHtml(value)}">${favorite ? '★ ' : '+ '}${escapeHtml(model.label || model.id)}</button>`;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderCatalogSection(data, modelMap) {
    const query = catalogSearch.trim().toLowerCase();
    const currentGrouped = new Map();
    const legacyGrouped = new Map();

    function isCurrentCatalogModel(model) {
      const id = String(model.id || '').trim();
      const provider = String(model.provider || '').trim();
      const isAlias = Boolean(model.isAlias);

      if (provider === 'openai-codex') {
        return isAlias || /^gpt-5\.4(?:-|$)/i.test(id);
      }

      if (provider === 'openai') {
        return isAlias || /^gpt-5\.4(?:-|$)/i.test(id) || /^gpt-4o(?:-mini)?$/i.test(id) || /^o4/i.test(id);
      }

      if (provider === 'anthropic') {
        return isAlias || /4-6|haiku-4-5/i.test(id);
      }

      if (provider === 'xai') {
        return isAlias || /grok-4-latest|grok-4-fast-reasoning-latest|grok-4\.20-.*latest|grok-code-fast-1/i.test(id);
      }

      if (provider === 'ollama-cloud') {
        return isAlias || /kimi|minimax|nemotron/i.test(id);
      }

      if (provider === 'openclaw') {
        return true;
      }

      return false;
    }

    (data?.models || []).forEach((model) => {
      const value = String(model.value || model.id || '').trim();
      if (!value) return;
      const haystack = `${value} ${model.label || ''} ${model.provider || ''}`.toLowerCase();
      if (query && !haystack.includes(query)) return;

      const bucket = (query || isCurrentCatalogModel(model)) ? currentGrouped : legacyGrouped;
      if (!bucket.has(model.provider)) bucket.set(model.provider, []);
      bucket.get(model.provider).push(model);
    });

    const renderGroups = (grouped) => Array.from(grouped.entries())
      .sort(([left], [right]) => compareProviderOrder(left, right))
      .map(([providerId, models]) => `
        <div class="runtime-manager-card">
          <div class="runtime-manager-card-title">${escapeHtml(formatProviderTitle(providerId))}</div>
          <div class="runtime-manager-list">
            ${models.map((model) => {
              const value = String(model.value || model.id || '').trim();
              const favorite = prefs.favorites.includes(value);
              return `
                <div class="runtime-manager-row">
                  <div>
                    <strong>${escapeHtml(model.label || value)}</strong>
                    <span>${escapeHtml(value)}</span>
                  </div>
                  <div class="runtime-manager-actions">
                    <button class="btn" type="button" data-runtime-action="toggle-favorite" data-runtime-value="${escapeHtml(value)}">${favorite ? 'Unpin' : 'Pin'}</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `).join('');

    const currentHtml = renderGroups(currentGrouped);
    const legacyHtml = renderGroups(legacyGrouped);

    return `
      <div class="runtime-manager-toolbar">
        <input id="runtime-catalog-search" class="runtime-manager-search" type="text" value="${escapeHtml(catalogSearch)}" placeholder="Search all runtimes and channels…">
        <button class="btn" type="button" data-runtime-action="refresh-catalog">Refresh Catalog</button>
        <button class="btn" type="button" data-runtime-action="clear-recents">Clear Recents</button>
        ${legacyHtml && !query ? `<button class="btn" type="button" data-runtime-action="toggle-legacy-catalog">${showLegacyCatalog ? 'Hide Older Models' : 'Show Older Models'}</button>` : ''}
      </div>
      ${currentHtml ? `
        <div class="runtime-manager-note">Current recommended and modern catalog entries by provider.</div>
        <div class="runtime-manager-grid">${currentHtml}</div>
      ` : `<div class="runtime-manager-note">No catalog matches for “${escapeHtml(catalogSearch)}”.</div>`}
      ${legacyHtml && (showLegacyCatalog || query) ? `
        <div class="runtime-manager-section-title">Older Models</div>
        <div class="runtime-manager-note">Legacy or less-recommended catalog entries. Hidden by default so they do not crowd the current working set.</div>
        <div class="runtime-manager-grid">${legacyHtml}</div>
      ` : ''}
    `;
  }

  async function renderManager(force = false) {
    ensureStyles();
    const modal = ensureModal();
    const body = modal.querySelector('#runtime-manager-body');
    if (!body) return;

    body.innerHTML = '<div class="runtime-manager-note">Loading runtime catalog…</div>';

    try {
      const data = await loadCatalog(force);
      if (!data?.models?.length) {
        body.innerHTML = '<div class="runtime-manager-note">No runtime catalog is available yet. Configure providers first.</div>';
        return;
      }

      const modelMap = buildModelMap(data);

      body.innerHTML = `
        <section class="runtime-manager-section">
          <div class="runtime-manager-section-title">Favorites</div>
          <div class="runtime-manager-note">These are the only runtimes shown in the main picker by default, plus your recent selections and agents.</div>
          ${renderFavoritesSection(modelMap)}
        </section>
        <section class="runtime-manager-section">
          <div class="runtime-manager-section-title">Defaults</div>
          ${renderDefaultsSection(data)}
        </section>
        <section class="runtime-manager-section">
          <div class="runtime-manager-section-title">Curated Channels</div>
          ${renderRecommendedSection(modelMap)}
        </section>
        <section class="runtime-manager-section">
          <div class="runtime-manager-section-title">Browse Catalog</div>
          <div class="runtime-manager-note">Use this when you want to pin something outside the curated channels. This is where the full provider catalogs live now — not in the picker.</div>
          ${renderCatalogSection(data, modelMap)}
        </section>
      `;

      const defaultChat = body.querySelector('#runtime-default-chat');
      const defaultQuery = body.querySelector('#runtime-default-query');
      const defaultSweep = body.querySelector('#runtime-default-pgs-sweep');
      const defaultSynth = body.querySelector('#runtime-default-pgs-synth');

      if (defaultChat) defaultChat.value = prefs.defaults.chat;
      if (defaultQuery) defaultQuery.value = prefs.defaults.query;
      if (defaultSweep) defaultSweep.value = prefs.defaults.pgsSweep;
      if (defaultSynth) defaultSynth.value = prefs.defaults.pgsSynth;
    } catch (error) {
      body.innerHTML = `<div class="runtime-manager-note">${escapeHtml(error.message || 'Failed to load runtime catalog.')}</div>`;
    }
  }

  function openManager() {
    ensureStyles();
    const modal = ensureModal();
    showLegacyCatalog = false;
    modal.classList.remove('hidden');
    renderManager(false);
  }

  function closeManager() {
    const modal = document.getElementById('runtime-manager-modal');
    if (!modal) return;
    modal.classList.add('hidden');
  }

  function handleModalClick(event) {
    const actionEl = event.target.closest('[data-runtime-action], [data-runtime-manager-action]');
    if (!actionEl) return;

    if (actionEl.dataset.runtimeManagerAction === 'close') {
      closeManager();
      return;
    }

    const action = actionEl.dataset.runtimeAction;
    const value = actionEl.dataset.runtimeValue;

    if (action === 'toggle-favorite') {
      const normalized = String(value || '').trim();
      const added = !prefs.favorites.includes(normalized);
      if (added) {
        addFavorite(normalized);
      } else {
        removeFavorite(normalized);
      }
      renderManager(false);
      if (added) showToast('Pinned runtime.', 'success');
      return;
    }

    if (action === 'move-up' || action === 'move-down') {
      moveFavorite(value, action === 'move-up' ? 'up' : 'down');
      renderManager(false);
      return;
    }

    if (action === 'clear-recents') {
      clearRecents();
      renderManager(false);
      return;
    }

    if (action === 'refresh-catalog') {
      catalogCache = null;
      renderManager(true);
      return;
    }

    if (action === 'toggle-legacy-catalog') {
      showLegacyCatalog = !showLegacyCatalog;
      renderManager(false);
    }
  }

  function handleModalChange(event) {
    const target = event.target;
    if (!target) return;

    if (target.id === 'runtime-default-chat') {
      setDefault('chat', target.value);
      return;
    }

    if (target.id === 'runtime-default-query') {
      setDefault('query', target.value);
      return;
    }

    if (target.id === 'runtime-default-pgs-sweep') {
      setDefault('pgsSweep', target.value);
      return;
    }

    if (target.id === 'runtime-default-pgs-synth') {
      setDefault('pgsSynth', target.value);
    }
  }

  function handleModalInput(event) {
    const target = event.target;
    if (!target || target.id !== 'runtime-catalog-search') return;
    catalogSearch = String(target.value || '');
    renderManager(false);
  }

  function bindSelectionTracking() {
    document.addEventListener('change', (event) => {
      const id = event.target?.id;
      if (!['ai-model-select', 'qt-model', 'qt-pgs-sweep-model', 'qt-pgs-synth-model'].includes(id)) {
        return;
      }
      recordRecent(event.target.value);
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;

    bindSelectionTracking();

    document.addEventListener('evobrew:settings-opened', ensureSettingsLauncher);
    window.addEventListener('evobrew:model-catalog-updated', (event) => {
      if (event.detail?.models?.length) {
        catalogCache = event.detail;
      }
      if (isOpen()) {
        renderManager(false);
      }
    });
    window.addEventListener('evobrew:runtime-prefs-changed', () => {
      if (isOpen()) {
        renderManager(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) {
        closeManager();
      }
    });
  }

  window.EvobrewRuntimePrefs = {
    init,
    getState,
    getDefaultSelection(context, fallback = '') {
      return prefs.defaults[context] || fallback || '';
    },
    renderSelect,
    recordRecent,
    openManager,
    closeManager,
    reset,
    refreshCatalog(force = false) {
      catalogCache = null;
      return loadCatalog(force).then((data) => {
        if (isOpen()) {
          renderManager(false);
        }
        return data;
      });
    }
  };

  window.openRuntimeManager = openManager;
  window.closeRuntimeManager = closeManager;

  init();
})();
