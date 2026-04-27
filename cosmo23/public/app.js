const FORM_FIELD_TYPES = {
  topic: 'string',
  context: 'string',
  runName: 'string',
  explorationMode: 'string',
  analysisDepth: 'string',
  cycles: 'number',
  maxRuntimeMinutes: 'number',
  reviewPeriod: 'number',
  maxConcurrent: 'number',
  primaryModel: 'string',
  fastModel: 'string',
  strategicModel: 'string',
  localLlmBaseUrl: 'string',
  enableWebSearch: 'boolean',
  enableSleep: 'boolean',
  enableCodingAgents: 'boolean',
  enableIntrospection: 'boolean',
  enableAgentRouting: 'boolean',
  enableRecursiveMode: 'boolean',
  enableMemoryGovernance: 'boolean',
  enableFrontier: 'boolean',
  enableIDEFirst: 'boolean',
  enableDirectAction: 'boolean',
  enableStabilization: 'boolean',
  enableConsolidationMode: 'boolean',
  enableExperimental: 'boolean'
};

const FORM_DEFAULTS = {
  topic: '',
  context: '',
  runName: '',
  explorationMode: 'guided',
  analysisDepth: 'normal',
  cycles: 80,
  maxRuntimeMinutes: 0,
  reviewPeriod: 20,
  maxConcurrent: 4,
  primaryModel: '',
  fastModel: '',
  strategicModel: '',
  localLlmBaseUrl: 'http://localhost:11434/v1',
  enableWebSearch: true,
  enableSleep: true,
  enableCodingAgents: true,
  enableIntrospection: true,
  enableAgentRouting: true,
  enableRecursiveMode: true,
  enableMemoryGovernance: true,
  enableFrontier: true,
  enableIDEFirst: true,
  enableDirectAction: false,
  enableStabilization: false,
  enableConsolidationMode: false,
  enableExperimental: false
};

const HOME23_PRIMARY_SOURCE_LABELS = new Set(['Local', 'Jerry', 'Forrest']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function populateBrainSelect(select, brains, selectedId) {
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '';

  // Group by sourceLabel
  const groups = {};
  brains.forEach(b => {
    const label = b.sourceLabel || (b.sourceType === 'local' ? 'Local' : 'Reference');
    if (!groups[label]) groups[label] = [];
    groups[label].push(b);
  });

  for (const [label, items] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${label} (${items.length})`;
    items.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.routeKey;
      const meta = [];
      if (b.isActive) meta.push('Running');
      if (b.topic || b.domain) meta.push(b.topic || b.domain);
      opt.textContent = meta.length > 0
        ? `${b.displayName} (${meta.join(' · ')})`
        : b.displayName;
      optgroup.appendChild(opt);
    });
    select.appendChild(optgroup);
  }

  const target = selectedId && brains.some(b => b.routeKey === selectedId)
    ? selectedId
    : prev && brains.some(b => b.routeKey === prev) ? prev : brains[0]?.routeKey || '';
  if (target) select.value = target;
}

function formatTextBlock(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'Not set';
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

class CosmoStandaloneApp {
  constructor() {
    this.viewTabs = [...document.querySelectorAll('.top-nav-btn[data-view]')];
    this.sideTabs = [...document.querySelectorAll('.side-nav-btn[data-view-target]')];
    this.views = new Map([
      ['launch', document.getElementById('view-launch')],
      ['brains', document.getElementById('view-brains')],
      ['watch', document.getElementById('view-watch')],
      ['query', document.getElementById('view-query')],
      ['map', document.getElementById('view-map')],
      ['intelligence', document.getElementById('view-intelligence')],
      ['hub', document.getElementById('view-hub')],
      ['interactive', document.getElementById('view-interactive')],
      ['ingest', document.getElementById('view-ingest')]
    ]);
    this.toastStack = document.getElementById('toast-stack');
    this.brains = [];
    this.selectedBrainId = null;
    this.selectedBrainDetail = null;
    this.selectedBrainTab = 'overview';
    this.brainFilter = 'all';
    this.brainFilterTouched = false;
    this.brainSearch = '';
    this.brainDetailRequestId = 0;
    this.initialViewResolved = false;
    this.activeView = 'launch';
    this.syncingQueryBrain = false;
    this.launchDefaultsApplied = false;
    this.models = [];
    this.modelCatalog = null;
    this.modelDefaults = {
      queryModel: null,
      pgsSweepModel: null,
      launch: {},
      local: {}
    };
    this.managedByHome23 = false;
    this.home23DashboardPort = '5002';
    this.activeContext = null;
    this.ws = null;
    this.wsUrl = null;
    this.wsRetryTimer = null;
    this.watchLogCursor = 0;
    this.watchLogTimer = null;
    this.watchLogSupported = true;
  }

  async init() {
    this.bindEvents();
    await Promise.all([
      this.loadSetupStatus(),
      this.loadModels(),
      this.loadModelCatalog(),
      this.loadStatus()
    ]);
    await this.loadBrains();
  }

  bindEvents() {
    const onClick = (id, handler) => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('click', handler);
      }
    };

    this.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchView(tab.dataset.view));
    });

    document.querySelectorAll('[data-view-target]').forEach(button => {
      button.addEventListener('click', () => this.switchView(button.dataset.viewTarget));
    });

    document.getElementById('launch-form').addEventListener('submit', event => {
      event.preventDefault();
      this.startResearch();
    });

    document.getElementById('setup-form').addEventListener('submit', event => {
      event.preventDefault();
      this.saveSetup();
    });

    document.getElementById('continue-form').addEventListener('submit', event => {
      event.preventDefault();
      this.continueResearch();
    });

    onClick('refresh-setup-btn', () => this.loadSetupStatus());
    onClick('refresh-app-btn', async () => {
      await Promise.all([
        this.loadSetupStatus(),
        this.loadModels(),
        this.loadStatus(),
        this.loadBrains()
      ]);
      this.showToast('COSMO workspace refreshed');
    });
    onClick('import-oauth-btn', () => this.importOAuthFromCLI());
    onClick('start-oauth-btn', () => this.startOAuth());
    onClick('complete-oauth-btn', () => this.completeOAuth());
    onClick('start-codex-oauth-btn', () => this.startOpenAICodexOAuth());
    onClick('import-codex-oauth-btn', () => this.importOpenAICodexOAuth());
    onClick('refresh-catalog-btn', () => this.loadModelCatalog());

    // Provider section visibility toggles
    document.querySelectorAll('.provider-section').forEach(section => {
      const toggle = section.querySelector('.toggle-chip input[type="checkbox"]');
      if (toggle) {
        toggle.addEventListener('change', () => this.updateProviderSectionVisibility());
      }
    });
    this.updateProviderSectionVisibility();
    onClick('save-catalog-btn', () => this.saveModelCatalog());
    onClick('refresh-brains-btn', () => this.loadBrains());
    onClick('brain-query-btn', () => {
      if (this.selectedBrainId) {
        this.syncSelectedBrainIntoQuery();
        this.switchView('query');
      }
    });
    onClick('refresh-status-btn', () => this.loadStatus());
    onClick('stop-run-btn', () => this.stopResearch());

    document.getElementById('brains-search').addEventListener('input', event => {
      this.brainSearch = event.target.value || '';
      this.renderBrainLibrary();
    });

    const locationFilter = document.getElementById('brains-location-filter');
    if (locationFilter) {
      locationFilter.addEventListener('change', () => {
        this.brainFilter = locationFilter.value;
        this.brainFilterTouched = true;
        this.renderBrainLibrary();
      });
    }

    document.querySelectorAll('.detail-tab[data-brain-tab]').forEach(button => {
      button.addEventListener('click', () => this.switchBrainTab(button.dataset.brainTab));
    });

    // Brain Map toolbar
    onClick('map-btn-fit', () => window.BrainMap?.zoomToFit());
    onClick('map-btn-reset', () => window.BrainMap?.resetCamera());
    onClick('map-btn-refresh', () => window.BrainMap?.refresh());

    const queryBrain = document.getElementById('query-brain');
    if (queryBrain) {
      queryBrain.addEventListener('change', event => this.handleQueryBrainChange(event));
    }

    const mapBrain = document.getElementById('map-brain');
    if (mapBrain) {
      mapBrain.addEventListener('change', event => this.handleMapBrainChange(event));
    }

    // Intelligence tab
    const intelBrain = document.getElementById('intel-brain');
    if (intelBrain) {
      intelBrain.addEventListener('change', event => this.handleIntelBrainChange(event));
    }

    document.querySelectorAll('.intel-tab[data-intel-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (window.IntelligenceTab) window.IntelligenceTab.switchTab(btn.dataset.intelTab);
      });
    });

    onClick('intel-refresh-btn', () => window.IntelligenceTab?.refresh());
  }

  async api(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const body = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(body?.error || body?.message || response.statusText);
    }
    return body;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : ''}`.trim();
    toast.textContent = message;
    this.toastStack.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3800);
  }

  switchView(viewName) {
    this.activeView = viewName;
    this.viewTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === viewName));
    this.sideTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.viewTarget === viewName));
    this.views.forEach((view, key) => view.classList.toggle('active', key === viewName));

    if (viewName === 'watch') {
      this.startWatchLogPolling();
    } else {
      this.stopWatchLogPolling();
    }

    if (viewName === 'map') {
      this.loadMapForSelectedBrain();
    }

    if (viewName === 'intelligence') {
      this.loadIntelForSelectedBrain();
    }

    if (viewName === 'hub') {
      if (window.HubTab) window.HubTab.init();
    }

    if (viewName === 'interactive') {
      if (window.InteractiveTab) {
        window.InteractiveTab.init(this.selectedBrainId);
      }
    }

    if (viewName === 'ingest') {
      if (window.IngestionTab) window.IngestionTab.init();
    } else {
      if (window.IngestionTab) window.IngestionTab.destroy();
    }
  }

  applyInitialView() {
    if (this.initialViewResolved) {
      return;
    }
    this.initialViewResolved = true;
    if (this.managedByHome23) {
      this.switchView('launch');
      return;
    }
    this.switchView(this.brains.length > 0 ? 'brains' : 'launch');
  }

  getFormField(formId, name) {
    return document.querySelector(`#${formId} [name="${name}"]`);
  }

  collectFormSettings(formId) {
    const output = {};
    Object.entries(FORM_FIELD_TYPES).forEach(([field, type]) => {
      const element = this.getFormField(formId, field);
      if (!element) {
        return;
      }

      if (type === 'boolean') {
        output[field] = !!element.checked;
        return;
      }

      if (type === 'number') {
        output[field] = Number.parseInt(element.value || String(FORM_DEFAULTS[field] || 0), 10);
        return;
      }

      output[field] = element.value;
    });

    return output;
  }

  applyFormSettings(formId, settings = {}) {
    Object.keys(FORM_FIELD_TYPES).forEach(field => {
      const element = this.getFormField(formId, field);
      if (!element) {
        return;
      }

      const value = settings[field];
      if (FORM_FIELD_TYPES[field] === 'boolean') {
        element.checked = value ?? FORM_DEFAULTS[field];
      } else if (value !== undefined && value !== null) {
        element.value = value;
      } else if (FORM_DEFAULTS[field] !== undefined) {
        element.value = FORM_DEFAULTS[field];
      }
    });
  }

  setSetupValue(name, value) {
    const field = this.getFormField('setup-form', name);
    if (!field) {
      return;
    }

    if (field.type === 'checkbox') {
      field.checked = !!value;
    } else {
      field.value = value ?? '';
    }
  }

  getSetupValue(name, fallback = '') {
    const field = this.getFormField('setup-form', name);
    if (!field) {
      return fallback;
    }
    if (field.type === 'checkbox') {
      return !!field.checked;
    }
    return field.value;
  }

  async loadSetupStatus() {
    try {
      const setupStatus = await this.api('/api/setup/status');

      // Managed by Home23 — skip per-provider polling, render read-only view
      if (setupStatus.managed_by_home23) {
        this.managedByHome23 = true;
        this.home23DashboardPort = setupStatus.home23_dashboard_port || '5002';
        document.getElementById('hero-setup-status').textContent = 'Home23';
        document.getElementById('hero-setup-status').classList.add('managed');
        this.renderManagedMode(setupStatus);
        return;
      }

      const [providerStatus, oauthStatus, codexOAuthStatus] = await Promise.all([
        this.api('/api/providers/status').catch(() => ({ providers: [] })),
        this.api('/api/oauth/anthropic/status').catch(() => ({ oauth: { configured: false } })),
        this.api('/api/oauth/openai-codex/status').catch(() => ({ oauth: { configured: false } }))
      ]);

      const setup = setupStatus.setup;
      document.getElementById('hero-setup-status').textContent = setup.exists ? 'Setup saved' : 'Setup pending';

      // Render provider status bar
      this.renderProviderStatusBar(setup, providerStatus, oauthStatus, codexOAuthStatus);

      // Render Anthropic OAuth inline status
      this.renderAnthropicOAuthStatus(oauthStatus);

      // Render OpenAI Codex OAuth inline status
      this.renderCodexOAuthStatus(codexOAuthStatus);

      // Populate form toggles
      this.setSetupValue('enableAnthropic', !!setup.providers.anthropic.enabled);
      this.setSetupValue('enableOpenAI', !!setup.providers.openai.enabled);
      this.setSetupValue('enableOpenAICodex', !!setup.providers['openai-codex']?.enabled);
      this.setSetupValue('enableMiniMax', !!setup.providers.minimax?.enabled);
      this.setSetupValue('enableXAI', !!setup.providers.xai.enabled);
      this.setSetupValue('enableOllama', !!setup.providers.ollama.enabled);
      this.setSetupValue('enableOllamaCloud', !!setup.providers['ollama-cloud']?.enabled);
      this.setSetupValue('ollamaBaseUrl', setup.providers.ollama.baseUrl || 'http://localhost:11434');

      // Populate brain directories
      const brainDirsTextarea = document.getElementById('brain-directories');
      if (brainDirsTextarea && setup.brainDirectories?.length) {
        brainDirsTextarea.value = setup.brainDirectories.join('\n');
      }

      this.updateProviderSectionVisibility();
    } catch (error) {
      this.showToast(`Setup status failed: ${error.message}`, 'error');
    }
  }

  renderManagedMode(setupStatus) {
    const setup = setupStatus.setup;
    const providers = setup.providers || {};
    const settingsUrl = `${window.location.protocol}//${window.location.hostname}:${this.home23DashboardPort}/home23/settings`;

    const mastheadEyebrow = document.querySelector('.masthead .eyebrow');
    const mastheadText = document.querySelector('.masthead .masthead-text');
    if (mastheadEyebrow) mastheadEyebrow.textContent = 'Home23 COSMO';
    if (mastheadText) mastheadText.textContent = 'Launch Home23-managed research runs, inspect local run brains, and query completed knowledge from this workspace.';

    if (!this.brainFilterTouched && this.brainFilter === 'all') {
      this.brainFilter = 'loc:Local';
    }

    // Build provider status dots for the summary bar
    const allProviders = [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'minimax', label: 'MiniMax' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'openai-codex', label: 'Codex' },
      { id: 'xai', label: 'xAI' },
      { id: 'ollama', label: 'Ollama' },
      { id: 'ollama-cloud', label: 'Cloud' }
    ];
    const bar = document.getElementById('setup-summary');
    if (bar) {
      bar.innerHTML = '';
      allProviders.forEach(p => {
        const isConfigured = !!providers[p.id]?.configured;
        const state = isConfigured ? 'connected' : 'disabled';
        const dot = document.createElement('span');
        dot.className = 'provider-status-dot';
        dot.dataset.state = state;
        dot.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.label)}</span>`;
        bar.appendChild(dot);
      });
    }

    // Replace the standalone setup panel with Home23 workspace context.
    const setupPanel = document.querySelector('#view-launch .launch-layout > aside.panel');
    if (setupPanel) {
      const connectedCount = allProviders.filter(p => !!providers[p.id]?.configured).length;
      setupPanel.classList.add('launch-insights-panel');
      setupPanel.innerHTML = `
        <section class="insight-card">
          <div class="insight-card-head">
            <span class="insight-icon">◷</span>
            <h2>Research at a glance</h2>
          </div>
          <div class="glance-list">
            <div class="glance-item">
              <span class="glance-icon warm">⌬</span>
              <div><strong>Home23-managed</strong><span>Runs are executed and tracked by Home23.</span></div>
            </div>
            <div class="glance-item">
              <span class="glance-icon cool">▧</span>
              <div><strong>Local knowledge</strong><span>Runs, brains, and results stay in this workspace.</span></div>
            </div>
            <div class="glance-item">
              <span class="glance-icon warm">✎</span>
              <div><strong>Built for depth</strong><span>Guided exploration with configurable depth and review.</span></div>
            </div>
          </div>
          <div class="provider-mini-summary">
            <strong>${connectedCount}/${allProviders.length}</strong>
            <span>providers connected through Home23 Settings</span>
          </div>
        </section>

        <section class="insight-card">
          <div class="insight-card-head compact">
            <h2>Recent Runs</h2>
            <button type="button" class="link-btn" data-view-target="brains">View all runs</button>
          </div>
          <div class="recent-runs-list" id="recent-runs-list"></div>
        </section>
      `;
      setupPanel.querySelectorAll('[data-view-target]').forEach(button => {
        button.addEventListener('click', () => this.switchView(button.dataset.viewTarget));
      });
      this.renderLaunchInsights();
      return;
    }

    // HOME23 manages provider config, model catalog, and imported brain roots.
    // Keep this panel read-only so the bundled COSMO UI does not imply local
    // setup is authoritative.
    const form = document.getElementById('setup-form');
    if (!form) return;
    const modelCatalogDetails = form.querySelector('details.section-disclosure:has(#catalog-openai-models)');
    const brainDirsDetails = form.querySelector('details.section-disclosure:has(#brain-directories)');
    if (modelCatalogDetails) modelCatalogDetails.remove();
    if (brainDirsDetails) brainDirsDetails.remove();

    // Build provider grid for the managed view
    const providerGridHtml = allProviders.map(p => {
      const isConfigured = !!providers[p.id]?.configured;
      const state = isConfigured ? 'connected' : 'disabled';
      const stateLabel = isConfigured ? 'Connected' : 'Not configured';
      return `<div class="managed-provider-row">
        <span class="provider-status-dot" data-state="${state}">
          <span class="dot"></span>
          <span>${escapeHtml(p.label)}</span>
        </span>
        <span class="managed-provider-state ${state}">${stateLabel}</span>
      </div>`;
    }).join('');

    form.innerHTML = `
      <div class="managed-mode-banner">
        <div class="managed-mode-icon">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 1L2 5v5c0 4.42 3.42 8.15 8 9 4.58-.85 8-4.58 8-9V5l-8-4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M7 10l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="managed-mode-text">
          <strong>Managed by Home23</strong>
          <span>Providers are configured in <a href="${escapeHtml(settingsUrl)}" target="_top" class="managed-link">Home23 Settings</a></span>
        </div>
      </div>

      <div class="managed-provider-grid">
        ${providerGridHtml}
      </div>
    `;

  }

  renderProviderStatusBar(setup, providerStatus, oauthStatus, codexOAuthStatus) {
    const bar = document.getElementById('setup-summary');
    bar.innerHTML = '';
    const healthMap = {};
    (providerStatus.providers || []).forEach(p => { healthMap[p.provider] = p.healthy; });

    const providers = [
      { id: 'anthropic', label: 'Anthropic', state: this.getProviderState(setup.providers.anthropic, healthMap.anthropic, oauthStatus.oauth) },
      { id: 'minimax', label: 'MiniMax', state: this.getProviderState(setup.providers.minimax, healthMap.minimax) },
      { id: 'openai', label: 'OpenAI', state: this.getProviderState(setup.providers.openai, healthMap.openai) },
      { id: 'openai-codex', label: 'Codex', state: this.getProviderState(setup.providers['openai-codex'], healthMap['openai-codex'], codexOAuthStatus.oauth) },
      { id: 'xai', label: 'xAI', state: this.getProviderState(setup.providers.xai, healthMap.xai) },
      { id: 'ollama', label: 'Ollama', state: setup.providers.ollama.enabled ? (healthMap.ollama ? 'connected' : 'partial') : 'disabled' },
      { id: 'ollama-cloud', label: 'Cloud', state: this.getProviderState(setup.providers['ollama-cloud'], healthMap['ollama-cloud']) }
    ];

    providers.forEach(p => {
      const dot = document.createElement('span');
      dot.className = 'provider-status-dot';
      dot.dataset.state = p.state;
      dot.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.label)}</span>`;
      bar.appendChild(dot);
    });
  }

  getProviderState(providerSetup, healthy, oauthState) {
    if (!providerSetup?.enabled) return 'disabled';
    const hasCredentials = providerSetup.configured || oauthState?.configured;
    if (!hasCredentials) return 'missing';
    if (healthy === false) return 'partial';
    return 'connected';
  }

  renderAnthropicOAuthStatus(oauthStatus) {
    const container = document.getElementById('anthropic-oauth-status');
    if (!container) return;
    const oauth = oauthStatus.oauth;
    if (!oauth?.configured) {
      container.innerHTML = '';
      return;
    }
    const isExpired = oauth.valid === false;
    const expiry = oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleDateString() : 'unknown';
    container.innerHTML = `
      <div class="oauth-status ${isExpired ? 'expired' : ''}">
        <span class="dot"></span>
        <span class="oauth-info">${isExpired ? 'Expired' : 'Connected'} via ${escapeHtml(oauth.source || 'oauth')} · expires ${escapeHtml(expiry)}</span>
        <button type="button" class="ghost-btn" id="logout-oauth-btn" style="padding:4px 8px;font-size:11px">Logout</button>
      </div>
    `;
    document.getElementById('logout-oauth-btn')?.addEventListener('click', () => this.logoutOAuth());
  }

  renderCodexOAuthStatus(codexOAuthStatus) {
    const container = document.getElementById('codex-oauth-status');
    if (!container) return;
    const oauth = codexOAuthStatus.oauth;
    if (!oauth?.configured) {
      container.innerHTML = '';
      return;
    }
    const isExpired = oauth.valid === false;
    const expiry = oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleDateString() : 'unknown';
    container.innerHTML = `
      <div class="oauth-status ${isExpired ? 'expired' : ''}">
        <span class="dot"></span>
        <span class="oauth-info">${isExpired ? 'Expired' : 'Connected'} · expires ${escapeHtml(expiry)}</span>
        <button type="button" class="ghost-btn" id="logout-codex-oauth-btn" style="padding:4px 8px;font-size:11px">Logout</button>
      </div>
    `;
    document.getElementById('logout-codex-oauth-btn')?.addEventListener('click', () => this.logoutOpenAICodexOAuth());
  }

  updateProviderSectionVisibility() {
    document.querySelectorAll('.provider-section').forEach(section => {
      const toggle = section.querySelector('.toggle-chip input[type="checkbox"]');
      const body = section.querySelector('.provider-section-body');
      if (toggle && body) {
        body.hidden = !toggle.checked;
      }
    });
  }

  async saveSetup() {
    if (this.managedByHome23) return;
    try {
      const payload = {
        enableAnthropic: this.getSetupValue('enableAnthropic', false),
        enableOpenAI: this.getSetupValue('enableOpenAI', false),
        openaiApiKey: this.getSetupValue('openaiApiKey', ''),
        enableOpenAICodex: this.getSetupValue('enableOpenAICodex', false),
        enableXAI: this.getSetupValue('enableXAI', false),
        xaiApiKey: this.getSetupValue('xaiApiKey', ''),
        enableOllama: this.getSetupValue('enableOllama', true),
        ollamaBaseUrl: this.getSetupValue('ollamaBaseUrl', ''),
        enableOllamaCloud: this.getSetupValue('enableOllamaCloud', false),
        ollamaCloudApiKey: this.getSetupValue('ollamaCloudApiKey', ''),
        brainDirectories: (document.getElementById('brain-directories')?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
      };

      await this.api('/api/setup/bootstrap', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.setSetupValue('openaiApiKey', '');
      this.setSetupValue('xaiApiKey', '');
      this.setSetupValue('ollamaCloudApiKey', '');
      this.showToast('Local setup saved');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Setup save failed: ${error.message}`, 'error');
    }
  }

  async importOAuthFromCLI() {
    try {
      await this.api('/api/oauth/anthropic/import-cli', { method: 'POST' });
      this.showToast('Anthropic OAuth imported from Claude CLI');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OAuth import failed: ${error.message}`, 'error');
    }
  }

  async startOAuth() {
    try {
      const result = await this.api('/api/oauth/anthropic/start');
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      this.showToast('Anthropic OAuth opened in a new tab');
    } catch (error) {
      this.showToast(`OAuth start failed: ${error.message}`, 'error');
    }
  }

  async completeOAuth() {
    try {
      const callbackUrl = this.getSetupValue('anthropicCallbackUrl', '').trim();
      if (!callbackUrl) {
        this.showToast('Paste the Anthropic callback URL first', 'error');
        return;
      }

      const encoded = encodeURIComponent(callbackUrl);
      await this.api(`/api/oauth/anthropic/callback?callbackUrl=${encoded}`);
      this.setSetupValue('anthropicCallbackUrl', '');
      this.showToast('Anthropic OAuth saved');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OAuth completion failed: ${error.message}`, 'error');
    }
  }

  async logoutOAuth() {
    try {
      await this.api('/api/oauth/anthropic/logout', { method: 'POST' });
      this.showToast('Anthropic OAuth cleared');
      await Promise.all([this.loadSetupStatus(), this.loadModels()]);
    } catch (error) {
      this.showToast(`OAuth logout failed: ${error.message}`, 'error');
    }
  }

  async startOpenAICodexOAuth() {
    try {
      this.showToast('Starting OpenAI OAuth — check your browser...');
      await this.api('/api/oauth/openai-codex/start', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth connected');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OpenAI OAuth failed: ${error.message}`, 'error');
    }
  }

  async importOpenAICodexOAuth() {
    try {
      await this.api('/api/oauth/openai-codex/import', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth imported from evobrew');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Codex import failed: ${error.message}`, 'error');
    }
  }

  async logoutOpenAICodexOAuth() {
    try {
      await this.api('/api/oauth/openai-codex/logout', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth cleared');
      await Promise.all([this.loadSetupStatus(), this.loadModels()]);
    } catch (error) {
      this.showToast(`Codex logout failed: ${error.message}`, 'error');
    }
  }

  async loadModels() {
    try {
      const result = await this.api('/api/providers/models');
      this.models = result.models || [];
      this.modelDefaults = result.defaults || this.modelDefaults;
      this.renderModelOptions();
    } catch (error) {
      this.showToast(`Model load failed: ${error.message}`, 'error');
    }
  }

  getChatModels() {
    return this.models.filter(model => model.kind !== 'embedding');
  }

  getLocalModels(kind = null) {
    return this.models.filter(model => {
      const isLocal = model.provider === 'ollama';
      return isLocal && (!kind || model.kind === kind);
    });
  }

  populateModelSelect(selectOrId, models, preferredValue = null) {
    const select = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
    if (!select) {
      return;
    }

    const currentValue = preferredValue || select.value;
    select.innerHTML = '';

    const grouped = models.reduce((acc, model) => {
      const key = model.provider;
      if (!acc[key]) {
        acc[key] = {
          label: model.providerLabel || model.provider,
          models: []
        };
      }
      acc[key].models.push(model);
      return acc;
    }, {});

    Object.values(grouped).forEach(groupInfo => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupInfo.label;
      groupInfo.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.dataset.provider = model.provider || '';
        option.textContent = model.label || model.id;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });

    if (currentValue && models.some(model => model.id === currentValue)) {
      select.value = currentValue;
    } else if (currentValue) {
      const customOption = document.createElement('option');
      customOption.value = currentValue;
      customOption.textContent = `${currentValue} (custom)`;
      select.insertBefore(customOption, select.firstChild);
      select.value = currentValue;
    } else if (models[0]) {
      select.value = models[0].id;
    }
  }

  renderModelOptions() {
    const chatModels = this.getChatModels();
    const localChatModels = this.getLocalModels('chat');
    const launchSettings = this.collectFormSettings('launch-form');
    const continueSettings = this.selectedBrainDetail?.effectiveContinueSettings || this.collectFormSettings('continue-form');

    this.populateModelSelect(this.getFormField('launch-form', 'primaryModel'), chatModels, launchSettings.primaryModel || this.modelDefaults.launch?.primary);
    this.populateModelSelect(this.getFormField('launch-form', 'fastModel'), chatModels, launchSettings.fastModel || this.modelDefaults.launch?.fast);
    this.populateModelSelect(this.getFormField('launch-form', 'strategicModel'), chatModels, launchSettings.strategicModel || this.modelDefaults.launch?.strategic);

    this.populateModelSelect(this.getFormField('continue-form', 'primaryModel'), chatModels, continueSettings.primaryModel || this.modelDefaults.launch?.primary);
    this.populateModelSelect(this.getFormField('continue-form', 'fastModel'), chatModels, continueSettings.fastModel || this.modelDefaults.launch?.fast);
    this.populateModelSelect(this.getFormField('continue-form', 'strategicModel'), chatModels, continueSettings.strategicModel || this.modelDefaults.launch?.strategic);

    this.populateModelSelect('catalog-query-model', chatModels, this.modelDefaults.queryModel);
    this.populateModelSelect('catalog-pgs-model', chatModels, this.modelDefaults.pgsSweepModel);
    this.populateModelSelect('catalog-local-primary', localChatModels, this.modelDefaults.local?.primary);
    this.populateModelSelect('catalog-local-fast', localChatModels, this.modelDefaults.local?.fast);

    // Query tab model selects — single source of truth, no separate fetch
    this.populateModelSelect('qt-model', chatModels, this.modelDefaults.queryModel || 'gpt-5.2');
    this.populateModelSelect('qt-pgs-sweep-model', chatModels, this.modelDefaults.pgsSweepModel || this.modelDefaults.queryModel || 'gpt-5.2');
    this.populateModelSelect('qt-pgs-synth-model', chatModels, this.modelDefaults.queryModel || 'gpt-5.2');

    // Interactive tab model select
    this.populateModelSelect('interactive-model', chatModels);

    if (!this.launchDefaultsApplied) {
      this.applyFormSettings('launch-form', {
        ...FORM_DEFAULTS,
        primaryModel: this.modelDefaults.launch?.primary || '',
        fastModel: this.modelDefaults.launch?.fast || '',
        strategicModel: this.modelDefaults.launch?.strategic || ''
      });
      this.launchDefaultsApplied = true;
    }

    if (this.modelCatalog) {
      this.applyCatalogFormValues();
    }

    if (this.selectedBrainDetail) {
      this.applyFormSettings('continue-form', this.selectedBrainDetail.effectiveContinueSettings);
    }
  }

  applyCatalogFormValues() {
    if (!this.modelCatalog) {
      return;
    }

    const setLines = (id, providerId) => {
      const element = document.getElementById(id);
      if (!element) {
        return;
      }
      const models = this.modelCatalog.providers?.[providerId]?.models || [];
      element.value = models.map(model => model.id || model.name || '').filter(Boolean).join('\n');
    };

    setLines('catalog-openai-models', 'openai');
    setLines('catalog-anthropic-models', 'anthropic');
    setLines('catalog-xai-models', 'xai');

    // Populate read-only Codex section from live model list
    const codexContainer = document.getElementById('catalog-codex-models');
    if (codexContainer) {
      const codexModels = this.models.filter(m => m.provider === 'openai-codex');
      codexContainer.innerHTML = '';
      if (codexModels.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'catalog-codex-empty field-note';
        empty.textContent = 'No Codex models available — connect OpenAI Codex (OAuth) in the providers panel above.';
        codexContainer.appendChild(empty);
      } else {
        codexModels.forEach(model => {
          const chip = document.createElement('span');
          chip.className = 'catalog-codex-chip';
          chip.textContent = model.id;
          chip.title = model.label || model.id;
          codexContainer.appendChild(chip);
        });
      }
    }

    const defaults = this.modelCatalog.defaults || {};
    const setValue = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.value = value || '';
    };
    setValue('catalog-query-model', defaults.queryModel);
    setValue('catalog-pgs-model', defaults.pgsSweepModel);
    setValue('catalog-local-primary', defaults.local?.primary);
    setValue('catalog-local-fast', defaults.local?.fast);
  }

  async loadModelCatalog() {
    try {
      const result = await this.api('/api/models/catalog');
      this.modelCatalog = result.catalog || null;
      if (result.defaults) {
        this.modelDefaults = result.defaults;
      }
      this.applyCatalogFormValues();
      this.renderModelOptions();
    } catch (error) {
      this.showToast(`Model catalog load failed: ${error.message}`, 'error');
    }
  }

  parseCatalogLines(id) {
    return (document.getElementById(id)?.value || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  async saveModelCatalog() {
    try {
      const existingCatalog = this.modelCatalog || {};
      const payload = {
        catalog: {
          ...existingCatalog,
          providers: {
            ...(existingCatalog.providers || {}),
            openai: { ...(existingCatalog.providers?.openai || {}), models: this.parseCatalogLines('catalog-openai-models') },
            anthropic: { ...(existingCatalog.providers?.anthropic || {}), models: this.parseCatalogLines('catalog-anthropic-models') },
            xai: { ...(existingCatalog.providers?.xai || {}), models: this.parseCatalogLines('catalog-xai-models') }
          },
          defaults: {
            ...(existingCatalog.defaults || {}),
            queryModel: document.getElementById('catalog-query-model').value,
            pgsSweepModel: document.getElementById('catalog-pgs-model').value,
            local: {
              ...(existingCatalog.defaults?.local || {}),
              primary: document.getElementById('catalog-local-primary').value,
              fast: document.getElementById('catalog-local-fast').value
            }
          }
        }
      };

      await this.api('/api/models/catalog', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.showToast('Model catalog saved');
      await Promise.all([this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Model catalog save failed: ${error.message}`, 'error');
    }
  }

  async loadBrains(options = {}) {
    try {
      const result = await this.api('/api/brains');
      this.brains = this.orderBrainsForDisplay(result.brains || []);
      this.renderLocationFilters();
      this.renderBrainLibrary();
      this.renderQueryBrains();
      this.renderMapBrains();
      this.renderIntelBrains();
      this.renderLaunchInsights();

      if (this.brains.length === 0) {
        this.selectedBrainId = null;
        this.selectedBrainDetail = null;
        this.renderBrainDetail();
        this.applyInitialView();
        return;
      }

      const preferredId = this.choosePreferredBrainId(options);

      await this.selectBrain(preferredId, { syncQuery: true, silent: true });
      this.applyInitialView();
    } catch (error) {
      this.showToast(`Brain scan failed: ${error.message}`, 'error');
    }
  }

  orderBrainsForDisplay(brains) {
    if (!this.managedByHome23) {
      return brains;
    }

    const rank = brain => {
      if (brain.sourceType === 'local') return 0;
      if (brain.sourceLabel === 'Jerry') return 1;
      if (brain.sourceLabel === 'Forrest') return 2;
      return 3;
    };

    return [...brains].sort((left, right) => {
      const rankDiff = rank(left) - rank(right);
      if (rankDiff !== 0) return rankDiff;
      return (right.modified || 0) - (left.modified || 0);
    });
  }

  choosePreferredBrainId(options = {}) {
    const activePreferredId = this.getActiveBrainId();
    if (options.preferredId && this.brains.some(brain => brain.routeKey === options.preferredId)) {
      return options.preferredId;
    }
    if (activePreferredId) {
      return activePreferredId;
    }
    if (this.selectedBrainId && this.brains.some(brain => brain.routeKey === this.selectedBrainId)) {
      return this.selectedBrainId;
    }
    if (this.managedByHome23) {
      const localBrain = this.brains.find(brain => brain.sourceType === 'local');
      if (localBrain) return localBrain.routeKey;
    }
    return this.brains[0].routeKey;
  }

  renderLocationFilters() {
    const select = document.getElementById('brains-location-filter');
    if (!select) return;

    const locations = {};
    this.brains.forEach(b => {
      const label = b.sourceLabel || (b.sourceType === 'local' ? 'Local' : 'Reference');
      locations[label] = (locations[label] || 0) + 1;
    });

    select.innerHTML = `<option value="all">All locations (${this.brains.length})</option>`;
    const sortedLocations = Object.entries(locations).sort((a, b) => {
      if (this.managedByHome23) {
        const aPrimary = HOME23_PRIMARY_SOURCE_LABELS.has(a[0]) ? 0 : 1;
        const bPrimary = HOME23_PRIMARY_SOURCE_LABELS.has(b[0]) ? 0 : 1;
        if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      }
      return b[1] - a[1];
    });
    for (const [label, count] of sortedLocations) {
      const opt = document.createElement('option');
      opt.value = `loc:${label}`;
      opt.textContent = `${label} (${count})`;
      select.appendChild(opt);
    }

    if (this.brainFilter) select.value = this.brainFilter;
  }

  getFilteredBrains() {
    const search = this.brainSearch.trim().toLowerCase();
    return this.brains.filter(brain => {
      if (this.brainFilter === 'local' && brain.sourceType !== 'local') {
        return false;
      }
      if (this.brainFilter === 'reference' && brain.sourceType !== 'reference') {
        return false;
      }
      if (this.brainFilter === 'active' && !brain.isActive) {
        return false;
      }
      // Location-specific filter (matches sourceLabel)
      if (this.brainFilter.startsWith('loc:') && brain.sourceLabel !== this.brainFilter.slice(4)) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = [
        brain.displayName,
        brain.topic,
        brain.domain,
        brain.sourceLabel,
        brain.mode,
        brain.sourceType
      ].join(' ').toLowerCase();

      return haystack.includes(search);
    });
  }

  renderBrainLibrary() {
    const container = document.getElementById('brain-library-list');
    container.innerHTML = '';

    const filteredBrains = this.getFilteredBrains();
    document.getElementById('brains-library-count').textContent = `${filteredBrains.length} of ${this.brains.length} runs`;

    if (filteredBrains.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'brain-card';
      empty.innerHTML = `
        <h3 class="brain-card-title">No matching brains</h3>
        <div class="brain-card-copy">Adjust the search or filter to reveal more runs.</div>
      `;
      container.appendChild(empty);
      return;
    }

    filteredBrains.forEach(brain => {
      const card = document.createElement('article');
      card.className = `brain-card ${brain.routeKey === this.selectedBrainId ? 'active' : ''}`.trim();
      card.addEventListener('click', () => this.selectBrain(brain.routeKey, { syncQuery: true }));
      const topicText = brain.topic || brain.domain || '';
      const nodeLabel = Number.isFinite(brain.nodes) ? `${brain.nodes} nodes` : 'Open for stats';
      const cycleLabel = Number.isFinite(brain.cycles) ? `${brain.cycles} cy` : 'Saved run';
      const sourceLabel = brain.sourceType === 'local' ? 'Local' : brain.sourceLabel;
      card.innerHTML = `
        <div class="brain-card-head">
          <h3 class="brain-card-title">${escapeHtml(brain.displayName)}${topicText ? `<span class="brain-card-topic"> — ${escapeHtml(topicText)}</span>` : ''}</h3>
          <span class="source-badge">${escapeHtml(sourceLabel)}</span>
        </div>
        <div class="brain-card-info">
          <span>${escapeHtml(nodeLabel)}</span>
          <span>${escapeHtml(cycleLabel)}</span>
          ${brain.isActive ? '<span class="brain-active-dot">running</span>' : ''}
        </div>
      `;
      container.appendChild(card);
    });
  }

  renderLaunchInsights() {
    const container = document.getElementById('recent-runs-list');
    if (!container) return;

    const localRuns = this.brains
      .filter(brain => brain.sourceType === 'local')
      .slice(0, 3);

    if (localRuns.length === 0) {
      container.innerHTML = '<div class="recent-empty">No local COSMO runs yet.</div>';
      return;
    }

    container.innerHTML = localRuns.map(brain => {
      const status = brain.isActive ? 'In Progress' : 'Completed';
      const statusClass = brain.isActive ? 'active' : 'complete';
      const cycles = Number.isFinite(brain.cycles) ? `${brain.cycles} cycles` : 'Saved run';
      const date = brain.modifiedDate ? this.formatDate(brain.modifiedDate) : 'Recent';
      return `
        <button type="button" class="recent-run-row" data-brain-id="${escapeHtml(brain.routeKey)}">
          <span>
            <strong>${escapeHtml(brain.displayName)}</strong>
            <small>${escapeHtml(date)} · ${escapeHtml(cycles)}</small>
          </span>
          <em class="${statusClass}">${escapeHtml(status)}</em>
          <b>›</b>
        </button>
      `;
    }).join('');

    container.querySelectorAll('[data-brain-id]').forEach(row => {
      row.addEventListener('click', async () => {
        await this.selectBrain(row.dataset.brainId, { syncQuery: true });
        this.switchView('brains');
      });
    });
  }

  async selectBrain(brainId, options = {}) {
    if (!brainId) {
      return;
    }

    this.selectedBrainId = brainId;
    this.renderBrainLibrary();

    const requestId = ++this.brainDetailRequestId;
    try {
      const detail = await this.api(`/api/brains/${encodeURIComponent(brainId)}`);
      if (requestId !== this.brainDetailRequestId) {
        return;
      }

      this.selectedBrainDetail = detail;
      this.renderBrainDetail();
      if (options.syncQuery !== false) {
        this.syncSelectedBrainIntoQuery();
        this.syncSelectedBrainIntoMap();
        this.syncSelectedBrainIntoIntel();
      }
    } catch (error) {
      if (!options.silent) {
        this.showToast(`Brain detail failed: ${error.message}`, 'error');
      }
    }
  }

  renderBrainDetail() {
    const emptyState = document.getElementById('brain-empty-state');
    const shell = document.getElementById('brain-detail-shell');
    const detail = this.selectedBrainDetail;

    if (!detail || !detail.brain) {
      emptyState.classList.remove('hidden');
      shell.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    shell.classList.remove('hidden');

    const brain = detail.brain;
    document.getElementById('selected-brain-name').textContent = brain.displayName;
    document.getElementById('selected-brain-meta').textContent = `${brain.topic || brain.domain || 'Untitled topic'} · ${this.formatDate(brain.modifiedDate)} · ${brain.mode || 'guided'}`;
    document.getElementById('selected-brain-badge').textContent = brain.sourceType === 'local' ? 'Local' : `Reference · ${brain.sourceLabel}`;

    const stats = document.getElementById('selected-brain-stats');
    stats.innerHTML = [
      { label: 'Cycles', value: brain.cycles },
      { label: 'Nodes', value: brain.nodes },
      { label: 'Edges', value: brain.edges },
      { label: 'Snapshots', value: brain.snapshotCount || 0 }
    ].map(item => `
      <div class="summary-card">
        <span class="summary-label">${escapeHtml(item.label)}</span>
        <span class="summary-value">${escapeHtml(String(item.value))}</span>
      </div>
    `).join('');

    document.getElementById('brain-overview-panel').innerHTML = this.buildOverviewMarkup(detail);
    this.applyFormSettings('continue-form', detail.effectiveContinueSettings || FORM_DEFAULTS);

    const latestSnapshot = detail.latestSnapshot;
    const continueBaseNote = latestSnapshot?.createdAt
      ? `Using the latest saved continuation snapshot from ${this.formatDate(latestSnapshot.createdAt)}.`
      : 'Using the original launch settings as the continuation base.';
    document.getElementById('continue-base-note').textContent = continueBaseNote;
    document.getElementById('continue-source-note').textContent = brain.sourceType === 'local' ? 'Local continuation' : 'Import + Continue';
    document.getElementById('continue-run-btn').textContent = brain.sourceType === 'local' ? 'Continue Run' : 'Import + Continue';

    this.switchBrainTab(this.selectedBrainTab, { suppressRender: true });
  }

  buildOverviewMarkup(detail) {
    const brain = detail.brain;
    const initialSettings = detail.initialSettings || {};
    const effectiveSettings = detail.effectiveContinueSettings || {};
    const latestSnapshot = detail.latestSnapshot;
    const snapshotMarkup = detail.snapshots.length > 0
      ? detail.snapshots.map(snapshot => `
          <li class="snapshot-item">
            <div class="snapshot-item-head">
              <strong>${escapeHtml(this.formatDate(snapshot.createdAt))}</strong>
              <span class="mini-chip">${escapeHtml(`${snapshot.changedCount} field${snapshot.changedCount === 1 ? '' : 's'} changed`)}</span>
            </div>
            <div class="snapshot-item-copy">${escapeHtml(snapshot.changedFields.join(', ') || 'No explicit field changes captured.')}</div>
          </li>
        `).join('')
      : '<li class="snapshot-item"><div class="snapshot-item-copy">No continuation snapshots yet. The first successful continuation will create one.</div></li>';

    const latestSnapshotCopy = latestSnapshot
      ? `${this.formatDate(latestSnapshot.createdAt)} · ${latestSnapshot.changedFields.join(', ') || 'No field changes'}`
      : 'No saved continuation snapshot yet';

    return `
      <div class="overview-section">
        <div class="overview-grid">
          <div class="overview-card">
            <span class="overview-card-label">Run Identity</span>
            <div class="overview-card-value">${escapeHtml(brain.displayName)}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Source</span>
            <div class="overview-card-value">${escapeHtml(brain.sourceType === 'local' ? 'Local run' : `Reference brain from ${brain.sourceLabel}`)}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Topic</span>
            <div class="overview-card-value">${formatTextBlock(brain.topic || brain.domain || 'Not set')}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Mode</span>
            <div class="overview-card-value">${escapeHtml(`${effectiveSettings.explorationMode || 'guided'} · ${effectiveSettings.analysisDepth || 'normal'} depth`)}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Model Stack</span>
            <div class="overview-card-value">${formatTextBlock([
              `${initialSettings.primaryProvider || 'provider'} / ${initialSettings.primaryModel || 'Primary model not set'}`,
              `${initialSettings.fastProvider || 'provider'} / ${initialSettings.fastModel || 'Fast model not set'}`,
              `${initialSettings.strategicProvider || 'provider'} / ${initialSettings.strategicModel || 'Strategic model not set'}`
            ].join('\n'))}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Latest Snapshot</span>
            <div class="overview-card-value">${formatTextBlock(latestSnapshotCopy)}</div>
          </div>
        </div>

        <div class="overview-grid">
          <div class="overview-card">
            <span class="overview-card-label">Original Launch Context</span>
            <div class="overview-card-value">${formatTextBlock(initialSettings.context || 'No original context saved')}</div>
          </div>
          <div class="overview-card">
            <span class="overview-card-label">Current Continue Base</span>
            <div class="overview-card-value">${formatTextBlock(effectiveSettings.context || 'No continuation context set')}</div>
          </div>
        </div>

        <div class="overview-card">
          <span class="overview-card-label">Snapshot History</span>
          <ul class="snapshot-list">${snapshotMarkup}</ul>
        </div>
      </div>
    `;
  }

  switchBrainTab(tabName, options = {}) {
    this.selectedBrainTab = tabName;
    document.querySelectorAll('.detail-tab[data-brain-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.brainTab === tabName);
    });
    document.querySelectorAll('.detail-tab-panel[data-brain-panel]').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.brainPanel === tabName);
    });

    if (!options.suppressRender && this.selectedBrainDetail) {
      this.renderBrainDetail();
    }
  }

  renderQueryBrains() {
    populateBrainSelect(document.getElementById('query-brain'), this.brains, this.selectedBrainId);
    this.updateQueryBrainNote();
  }

  syncSelectedBrainIntoQuery() {
    const select = document.getElementById('query-brain');
    if (!select || !this.selectedBrainId || !this.brains.some(brain => brain.routeKey === this.selectedBrainId)) {
      return;
    }

    this.syncingQueryBrain = true;
    select.value = this.selectedBrainId;
    this.updateQueryBrainNote();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    this.syncingQueryBrain = false;
  }

  async handleQueryBrainChange(event) {
    const brainId = event.target.value;
    this.updateQueryBrainNote();
    if (this.syncingQueryBrain || !brainId || brainId === this.selectedBrainId) {
      return;
    }
    await this.selectBrain(brainId, { syncQuery: false, silent: true });
  }

  async updateQueryBrainNote() {
    const select = document.getElementById('query-brain');
    const note = document.getElementById('query-brain-note');
    const brain = this.brains.find(entry => entry.routeKey === select.value);
    if (!brain) {
      note.textContent = 'Use the EVOBREW-style Research surface with PGS, follow-up context, exports, and deeper query controls.';
      return;
    }

    // For the active run, re-fetch live counts (brain list may be stale)
    let nodes = brain.nodes;
    let edges = brain.edges;
    const selectedDetailBrain = this.selectedBrainDetail?.brain;
    if (selectedDetailBrain?.routeKey === brain.routeKey) {
      nodes = selectedDetailBrain.nodes ?? nodes;
      edges = selectedDetailBrain.edges ?? edges;
    }
    const isActiveRun = this.activeContext && (
      brain.name === this.activeContext.runName ||
      brain.routeKey === this.activeContext.brainId
    );

    if (isActiveRun) {
      try {
        const detail = await this.api(`/api/brains/${encodeURIComponent(brain.routeKey)}`);
        nodes = detail?.brain?.nodes ?? brain.nodes;
        edges = detail?.brain?.edges ?? brain.edges;
      } catch { /* use cached values */ }
    }

    const source = brain.sourceType === 'local' ? 'Local' : `Reference · ${brain.sourceLabel}`;
    const liveTag = isActiveRun ? ' · Running' : '';
    const nodeLabel = Number.isFinite(nodes) ? `${nodes} nodes` : 'stats on open';
    const edgeLabel = Number.isFinite(edges) ? `${edges} edges` : 'edges on open';
    note.textContent = `${brain.displayName} · ${source}${liveTag} · ${nodeLabel} · ${edgeLabel}`;
  }

  renderMapBrains() {
    populateBrainSelect(document.getElementById('map-brain'), this.brains, this.selectedBrainId);
  }

  syncSelectedBrainIntoMap() {
    const select = document.getElementById('map-brain');
    if (!select || !this.selectedBrainId) return;
    select.value = this.selectedBrainId;
    if (this.activeView === 'map') this.loadMapForSelectedBrain();
  }

  handleMapBrainChange(event) {
    const routeKey = event.target.value;
    if (!routeKey) return;
    this._lastMapBrainKey = null; // Force reload
    if (window.BrainMap) window.BrainMap.load(routeKey);
  }

  loadMapForSelectedBrain() {
    const select = document.getElementById('map-brain');
    const routeKey = select?.value;
    if (!routeKey || !window.BrainMap) return;
    if (window.BrainMap.isLoaded() && this._lastMapBrainKey === routeKey) return;
    this._lastMapBrainKey = routeKey;
    window.BrainMap.load(routeKey);
  }

  renderIntelBrains() {
    populateBrainSelect(document.getElementById('intel-brain'), this.brains, this.selectedBrainId);
  }

  syncSelectedBrainIntoIntel() {
    const select = document.getElementById('intel-brain');
    if (!select || !this.selectedBrainId) return;
    select.value = this.selectedBrainId;
    if (this.activeView === 'intelligence') this.loadIntelForSelectedBrain();
  }

  handleIntelBrainChange(event) {
    const routeKey = event.target.value;
    if (!routeKey || !window.IntelligenceTab) return;
    window.IntelligenceTab.init(routeKey);
  }

  loadIntelForSelectedBrain() {
    const select = document.getElementById('intel-brain');
    const routeKey = select?.value;
    if (!routeKey || !window.IntelligenceTab) return;
    window.IntelligenceTab.init(routeKey);
  }

  getSelectedProvider(formId, fieldName) {
    const select = this.getFormField(formId, fieldName);
    if (!select) return '';
    const selected = select.options[select.selectedIndex];
    return selected?.dataset?.provider || '';
  }

  gatherLaunchSettings() {
    return {
      ...FORM_DEFAULTS,
      ...this.collectFormSettings('launch-form'),
      primaryProvider: this.getSelectedProvider('launch-form', 'primaryModel'),
      fastProvider: this.getSelectedProvider('launch-form', 'fastModel'),
      strategicProvider: this.getSelectedProvider('launch-form', 'strategicModel'),
      executionMode: this.getFormField('launch-form', 'explorationMode').value === 'guided' ? 'guided-exclusive' : 'autonomous'
    };
  }

  gatherContinueSettings() {
    return {
      ...this.collectFormSettings('continue-form'),
      primaryProvider: this.getSelectedProvider('continue-form', 'primaryModel'),
      fastProvider: this.getSelectedProvider('continue-form', 'fastModel'),
      strategicProvider: this.getSelectedProvider('continue-form', 'strategicModel')
    };
  }

  async startResearch() {
    try {
      const payload = this.gatherLaunchSettings();
      const result = await this.api('/api/launch', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.activeContext = {
        runName: result.runName,
        brainId: result.brainId,
        topic: payload.topic || result.runName,
        startedAt: new Date().toISOString(),
        wsUrl: result.wsUrl
      };

      this.resetWatchFeeds();
      this.showToast(result.isContinuation ? `Continuing ${result.runName}` : `Started ${result.runName}`);
      this.switchView('watch');
      await Promise.all([this.loadStatus(), this.loadBrains({ preferredId: result.brainId })]);
    } catch (error) {
      this.showToast(`Launch failed: ${error.message}`, 'error');
    }
  }

  async continueResearch() {
    if (!this.selectedBrainId) {
      this.showToast('Select a brain first', 'error');
      return;
    }

    try {
      const payload = this.gatherContinueSettings();
      const result = await this.api(`/api/continue/${encodeURIComponent(this.selectedBrainId)}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.activeContext = {
        runName: result.runName,
        brainId: result.brainId,
        topic: payload.topic || result.runName,
        startedAt: new Date().toISOString(),
        wsUrl: result.wsUrl
      };

      this.resetWatchFeeds();
      this.showToast(`Running ${result.runName}`);
      this.switchView('watch');
      await Promise.all([this.loadStatus(), this.loadBrains({ preferredId: result.brainId })]);
    } catch (error) {
      this.showToast(`Continue failed: ${error.message}`, 'error');
    }
  }

  async stopResearch() {
    try {
      const result = await this.api('/api/stop', { method: 'POST', body: JSON.stringify({}) });
      this.disconnectWebSocket();
      this.activeContext = null;
      this.showToast(result.message || 'Run stopped');
      await this.loadStatus();
      await this.loadBrains();
    } catch (error) {
      this.showToast(`Stop failed: ${error.message}`, 'error');
    }
  }

  async loadStatus() {
    try {
      const status = await this.api('/api/status');
      const running = !!status.running;
      this.activeContext = status.activeContext || null;

      // Gate Ingest tab to active runs
      const ingestBtn = document.querySelector('.top-nav-btn[data-view="ingest"]');
      if (ingestBtn) {
        const hasRun = !!this.activeContext;
        ingestBtn.disabled = !hasRun;
        ingestBtn.classList.toggle('tab-disabled', !hasRun);
      }

      const dashboardLink = document.getElementById('watch-dashboard-link');
      const dashboardUrl = status.dashboardUrl
        || (status.ports?.dashboard ? `${window.location.protocol}//${window.location.hostname}:${status.ports.dashboard}` : null);

      document.getElementById('hero-run-status').textContent = running ? `Running · ${status.activeContext.runName}` : 'Idle';
      document.getElementById('watch-run-name').textContent = status.activeContext?.runName || 'Idle';
      document.getElementById('watch-topic').textContent = status.activeContext?.topic || 'None';
      document.getElementById('watch-started-at').textContent = status.activeContext?.startedAt
        ? this.formatDate(status.activeContext.startedAt)
        : '-';
      dashboardLink.href = dashboardUrl || '#';
      dashboardLink.setAttribute('aria-disabled', dashboardUrl ? 'false' : 'true');
      dashboardLink.style.pointerEvents = dashboardUrl ? 'auto' : 'none';
      dashboardLink.style.opacity = dashboardUrl ? '1' : '0.5';

      if (running && status.wsUrl) {
        this.connectWebSocket(status.wsUrl);
      } else {
        this.disconnectWebSocket();
      }

      const activeBrainId = this.getActiveBrainId();
      if (
        activeBrainId &&
        this.brains.length > 0 &&
        activeBrainId !== this.selectedBrainId &&
        !this.selectedBrainDetail
      ) {
        this.selectBrain(activeBrainId, { syncQuery: true, silent: true });
      }

      if (this.views.get('watch')?.classList.contains('active')) {
        if (running || this.watchLogCursor === 0) {
          this.startWatchLogPolling();
        }
      }
    } catch (error) {
      this.showToast(`Status load failed: ${error.message}`, 'error');
    }
  }

  getActiveBrainId() {
    if (!this.activeContext || this.brains.length === 0) {
      return null;
    }

    const byId = this.activeContext.brainId
      && this.brains.find(brain => brain.routeKey === this.activeContext.brainId);
    if (byId) {
      return byId.routeKey;
    }

    const byName = this.activeContext.runName
      && this.brains.find(brain => brain.name === this.activeContext.runName);
    return byName?.routeKey || null;
  }

  connectWebSocket(wsUrl) {
    this.wsUrl = wsUrl;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      if (this.wsRetryTimer) {
        window.clearTimeout(this.wsRetryTimer);
        this.wsRetryTimer = null;
      }
      document.getElementById('watch-socket-status').textContent = 'Connected';
    };
    this.ws.onerror = () => {
      document.getElementById('watch-socket-status').textContent = 'Retrying';
    };
    this.ws.onclose = () => {
      document.getElementById('watch-socket-status').textContent = this.activeContext ? 'Retrying' : 'Disconnected';
      this.ws = null;
      if (this.activeContext && this.wsUrl && this.views.get('watch')?.classList.contains('active') && !this.wsRetryTimer) {
        this.wsRetryTimer = window.setTimeout(() => {
          this.wsRetryTimer = null;
          if (this.activeContext && this.wsUrl) {
            this.connectWebSocket(this.wsUrl);
          }
        }, 2000);
      }
    };
    this.ws.onmessage = event => {
      try {
        const payload = JSON.parse(event.data);
        this.appendEvent(payload);
      } catch {
        // Ignore malformed event payloads.
      }
    };
  }

  disconnectWebSocket() {
    document.getElementById('watch-socket-status').textContent = 'Disconnected';
    if (this.wsRetryTimer) {
      window.clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    this.wsUrl = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  resetWatchFeeds() {
    this.watchLogCursor = 0;
    this.watchLogSupported = true;
    document.getElementById('activity-feed').innerHTML = '';
    document.getElementById('console-feed').innerHTML = '';
  }

  startWatchLogPolling() {
    if (!this.watchLogSupported) {
      return;
    }

    if (!this.watchLogTimer) {
      this.loadWatchLogs();
      this.watchLogTimer = window.setInterval(() => this.loadWatchLogs(), 1500);
    }
  }

  stopWatchLogPolling() {
    if (this.watchLogTimer) {
      window.clearInterval(this.watchLogTimer);
      this.watchLogTimer = null;
    }
  }

  async loadWatchLogs() {
    try {
      const query = this.watchLogCursor > 0
        ? `/api/watch/logs?after=${this.watchLogCursor}&limit=250`
        : '/api/watch/logs?limit=250';
      const result = await this.api(query);
      const logs = result.logs || [];

      logs.forEach(log => this.appendConsoleLog(log));
      if (typeof result.cursor === 'number') {
        this.watchLogCursor = result.cursor;
      }
    } catch (error) {
      if (/404|Not Found/i.test(error.message || '')) {
        this.watchLogSupported = false;
        this.stopWatchLogPolling();
        this.appendConsoleLog({
          timestamp: new Date().toISOString(),
          source: 'Watch',
          level: 'info',
          message: 'Inline console feed is not available from the currently running backend yet. Using websocket event feed for this run.'
        });
        return;
      }

      if (this.views.get('watch')?.classList.contains('active')) {
        this.showToast(`Watch log load failed: ${error.message}`, 'error');
      }
      this.stopWatchLogPolling();
    }
  }

  appendConsoleLog(entry) {
    const feed = document.getElementById('console-feed');
    const duplicate = Array.from(feed.children).some(node =>
      node.dataset.source === String(entry.source || '')
      && node.dataset.level === String(entry.level || '')
      && node.dataset.message === String(entry.message || '')
    );
    if (duplicate) {
      return;
    }

    const item = document.createElement('div');
    item.className = `console-line ${entry.level === 'error' ? 'error' : ''}`.trim();
    item.dataset.source = entry.source || '';
    item.dataset.level = entry.level || '';
    item.dataset.message = entry.message || '';
    const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
    item.innerHTML = `
      <div class="console-line-head">
        <span>${escapeHtml(time)}</span>
        <span>${escapeHtml(entry.source || 'Process')}</span>
        <span>${escapeHtml(entry.level || 'info')}</span>
      </div>
      <div>${escapeHtml(entry.message || '')}</div>
    `;
    feed.appendChild(item);

    while (feed.children.length > 400) {
      feed.removeChild(feed.firstChild);
    }

    feed.scrollTop = feed.scrollHeight;
  }

  appendEvent(event) {
    const feed = document.getElementById('activity-feed');
    const item = document.createElement('div');
    item.className = 'feed-item';
    const time = new Date(event.timestamp || Date.now()).toLocaleTimeString();
    item.innerHTML = `
      <div class="feed-time">${escapeHtml(time)}</div>
      <div class="feed-body">${escapeHtml(this.formatEvent(event))}</div>
    `;
    feed.prepend(item);

    while (feed.children.length > 250) {
      feed.removeChild(feed.lastChild);
    }
  }

  formatEvent(event) {
    const parts = [event.type || 'event'];
    if (event.cycle !== undefined) {
      parts.push(`cycle ${event.cycle}`);
    }
    if (event.agentType) {
      parts.push(event.agentType);
    }
    if (event.mode) {
      parts.push(event.mode);
    }
    if (event.message) {
      parts.push(event.message);
    } else if (event.summary) {
      parts.push(event.summary);
    } else if (event.goal) {
      parts.push(event.goal);
    }
    return parts.join(' · ');
  }

  formatDate(value, short = false) {
    if (!value) {
      return '-';
    }
    const date = new Date(value);
    return short ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : date.toLocaleString();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new CosmoStandaloneApp();
  window.cosmoStandaloneApp = app;
  if (typeof window.initQueryTab === 'function') {
    window.initQueryTab();
  }
  app.init().catch(error => {
    console.error(error);
  });
});
