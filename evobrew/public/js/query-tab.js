/**
 * Query Tab — Research Mode for COSMO IDE Standalone
 * Ported from unified dev (cosmos.evobrew.com) app.js + index.html
 * Self-contained: HTML built in initQueryTab(), CSS injected, no external deps
 */

let lastQueryResult = null;
let queryHistory = [];
let _queryTabInitialized = false;

const QUERY_STARTER_PROMPTS = [
  { icon: '📋', label: 'Summary', prompt: 'summarize the main findings from this research', featured: true },
  { icon: '⚡', label: 'Actionable', prompt: "what insights are most actionable - things we can test and build on?", featured: true },
  { icon: '🎯', label: 'Strategic', prompt: 'what are the strategic recommendations from the latest coordinator review?', featured: true },
  { icon: '🔬', label: 'Novel Concepts', prompt: "we are looking for novelty. concepts that aren't out in the mainstream that we can test and build on", featured: true },
  { icon: '🔗', label: 'Synthesis', prompt: 'what did the synthesis agents discover?', featured: false },
  { icon: '🛡️', label: 'Defensible', prompt: 'identify the top 3-5 ideas with the strongest competitive moat or defensibility', featured: false },
  { icon: '💵', label: 'Quick Wins', prompt: 'which findings have immediate monetization potential with existing customers?', featured: false },
  { icon: '💰', label: 'Market Fit', prompt: 'we are looking for valuable opportunities that are within reach and not too novel. find those with TAM, SAM, and typical budget size', featured: false }
];

/* ═══════════════════════════════════════════════════════
   Init — builds HTML, injects CSS, binds events
   ═══════════════════════════════════════════════════════ */

function initQueryTab() {
  const panel = document.getElementById('query-tab-panel');
  if (!panel || _queryTabInitialized) return;
  _queryTabInitialized = true;

  // Inject styles
  if (!document.getElementById('query-tab-styles')) {
    const style = document.createElement('style');
    style.id = 'query-tab-styles';
    style.textContent = getQueryTabStyles();
    document.head.appendChild(style);
  }

  panel.innerHTML = `
    <div class="qt-container">
      <!-- Query Input Section -->
      <div class="qt-input-section">
        <div class="qt-starter-header">
          <div>
            <div class="qt-starter-eyebrow">Research</div>
            <div class="qt-starter-title">Start with one strong question</div>
          </div>
          <button id="qt-more-prompts" class="qt-btn qt-btn-outline qt-btn-sm" type="button" aria-expanded="false">More starters</button>
        </div>
        <textarea id="qt-input" class="qt-textarea" placeholder="Ask a question about this brain's knowledge..."></textarea>

        <div class="qt-starter-prompt-bar">
          <div class="qt-quick-label">Starter prompts</div>
          <div class="qt-quick-grid qt-quick-grid--featured">
            ${renderQuickPromptButtons(true)}
          </div>
          <div class="qt-quick-grid qt-quick-grid--more qt-hidden" id="qt-more-prompts-panel">
            ${renderQuickPromptButtons(false)}
          </div>
        </div>

        <div class="qt-actions-compact">
          <button id="qt-submit" class="qt-btn qt-btn-primary">Execute Query</button>
          <button id="qt-clear" class="qt-btn qt-btn-outline qt-btn-sm">Clear</button>
          <button id="qt-followup" class="qt-btn qt-btn-outline qt-btn-sm" disabled>Follow-up</button>
          <span id="qt-context-indicator" class="qt-context-indicator qt-hidden">
            <span class="qt-context-dot"></span>
            <span>Using context</span>
          </span>
        </div>
      </div>

      <!-- Collapsible Options -->
      <details class="qt-options-section" id="qt-options-section">
        <summary class="qt-options-toggle">
          <span class="qt-toggle-icon">▶</span>
          <span>Advanced</span>
          <span class="qt-options-summary" id="qt-options-summary">Full mode · Loading models...</span>
        </summary>
        <div class="qt-options-content">
          <div class="qt-advanced-intro">
            Tune models, depth, streaming, evidence controls, and PGS when you need more control.
          </div>

          <!-- Options Grid -->
          <div class="qt-options-grid">
            <div class="qt-option-group">
              <label>Model:</label>
              <select id="qt-model" class="qt-select"></select>
            </div>
            <div class="qt-option-group">
              <label>Depth:</label>
              <select id="qt-mode" class="qt-select">
                <option value="quick">Quick (Fast answers)</option>
                <option value="full" selected>Full (Comprehensive)</option>
                <option value="expert">Expert (Maximum depth)</option>
                <option value="dive">🏊 Dive (Exploratory synthesis)</option>
              </select>
            </div>
            <div class="qt-option-group">
              <label class="qt-checkbox-label">
                <input type="checkbox" id="qt-stream" checked>
                <span>Stream response</span>
              </label>
            </div>
          </div>

          <!-- Mode Hint -->
          <div id="qt-mode-hint" class="qt-mode-hint">Comprehensive analysis with full brain access</div>

          <!-- Enhancement Toggles -->
          <div class="qt-enhancements">
            <label class="qt-toggle-label"><input type="checkbox" id="qt-evidence"> Evidence Metrics</label>
            <label class="qt-toggle-label"><input type="checkbox" id="qt-synthesis" checked> Synthesis</label>
            <label class="qt-toggle-label"><input type="checkbox" id="qt-coordinator" checked> Coordinator Insights</label>
          </div>

          <!-- Context Options -->
          <div class="qt-context-options">
            <label class="qt-toggle-label"><input type="checkbox" id="qt-outputs" checked> Include Output Files</label>
            <label class="qt-toggle-label"><input type="checkbox" id="qt-thoughts" checked> Include Thoughts</label>
            <label class="qt-toggle-label" title="Allow query to create files, read full contents, and take actions">
              <input type="checkbox" id="qt-allow-actions"> Allow Actions
            </label>
            <label class="qt-toggle-label qt-pgs-label" title="Partitioned Graph Synthesis: full graph coverage via parallel sweeps (3-6 min)">
              <input type="checkbox" id="qt-pgs"> 🧬 PGS (Full Graph)
            </label>
          </div>

          <div id="qt-pgs-controls" class="qt-pgs-controls qt-hidden">
            <div class="qt-option-group">
              <label>Sweep Depth:</label>
              <div class="qt-pgs-depth-chips">
                <button type="button" class="qt-depth-chip" data-depth="0.10">Skim (10%)</button>
                <button type="button" class="qt-depth-chip qt-depth-active" data-depth="0.25">Sample (25%)</button>
                <button type="button" class="qt-depth-chip" data-depth="0.50">Deep (50%)</button>
                <button type="button" class="qt-depth-chip" data-depth="1.0">Full (100%)</button>
              </div>
              <input type="hidden" id="qt-pgs-depth" value="0.25" />
            </div>
            <div class="qt-pgs-model-row">
              <div class="qt-option-group">
                <label>Sweep Model:</label>
                <select id="qt-pgs-sweep-model" class="qt-select" title="Model for partition sweeps (runs many times, cheaper is better)"></select>
              </div>
              <div class="qt-option-group">
                <label>Synthesis Model:</label>
                <select id="qt-pgs-synth-model" class="qt-select" title="Model for final synthesis (runs once, quality matters)"></select>
              </div>
            </div>
            <div class="qt-option-group">
              <label>Session Mode:</label>
              <select id="qt-pgs-mode" class="qt-select">
                <option value="full" selected>fresh sweep</option>
                <option value="continue">continue (remaining only)</option>
                <option value="targeted">targeted (best remaining)</option>
              </select>
            </div>
            <div class="qt-option-group">
              <label>Session ID:</label>
              <input id="qt-pgs-session" class="qt-input-inline" type="text" placeholder="default" />
            </div>
          </div>
        </div>
      </details>

      <!-- Response Section -->
      <div class="qt-response-section">
        <!-- Loading -->
        <div id="qt-loading" class="qt-loading qt-hidden">
          <div class="qt-spinner"></div>
          <div id="qt-loading-msg">Searching knowledge graph and synthesizing answer...</div>
          <div class="qt-loading-hint" id="qt-loading-hint">This may take 10-30 seconds</div>
        </div>

        <!-- Results — always visible -->
        <div id="qt-result" class="qt-result">
          ${renderQueryPlaceholder(true)}
        </div>

        <!-- History -->
        <details id="qt-history" class="qt-history-section qt-hidden">
          <summary class="qt-history-toggle">
            <span>Query History</span>
            <button class="qt-btn-text" id="qt-clear-history">Clear</button>
          </summary>
          <div id="qt-history-list" class="qt-history-list"></div>
        </details>
      </div>
    </div>
  `;

  // Bind events
  bindQueryTabEvents();
  seedQueryModelSelects();
  refreshQueryOptionsSummary();
  populateModels({ useCached: true, backgroundRefresh: true });

  if (!window.__queryTabModelCatalogBound) {
    window.addEventListener('evobrew:model-catalog-updated', (event) => {
      if (!_queryTabInitialized || !event.detail?.models?.length) return;
      applyQueryModelCatalog(event.detail);
    });
    window.addEventListener('evobrew:runtime-prefs-changed', () => {
      if (!_queryTabInitialized) return;
      populateModels({ useCached: true, backgroundRefresh: false });
    });
    window.__queryTabModelCatalogBound = true;
  }

  loadQueryHistory();
  checkBrainStatus();
  window.addEventListener('cosmo:brainLoaded', checkBrainStatus);
  window.addEventListener('cosmo:brainUnloaded', checkBrainStatus);
}

function renderQuickPromptButtons(featuredOnly) {
  return QUERY_STARTER_PROMPTS
    .filter((prompt) => featuredOnly ? prompt.featured : !prompt.featured)
    .map((prompt) => `<button class="qt-quick-btn" data-prompt="${escapeHtml(prompt.prompt)}">${prompt.icon} ${prompt.label}</button>`)
    .join('');
}

function renderQueryPlaceholder(hasBrain) {
  if (!hasBrain) {
    return `
      <div class="qt-result-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 8v4"/>
          <path d="M12 16h.01"/>
        </svg>
        <p>Connect a brain to start research.</p>
        <p class="qt-hint">That unlocks memory-backed answers, citations, and graph-aware retrieval.</p>
        <div class="qt-placeholder-actions">
          <button class="qt-btn qt-btn-primary qt-btn-sm" data-action="toggleBrainPicker()">Connect Brain</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="qt-result-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
        <path d="M12 17h.01"/>
      </svg>
      <p>Ask a question above to query this brain's knowledge</p>
      <p class="qt-hint">Responses will appear here with full context and citations</p>
    </div>
  `;
}

function updateQueryPlaceholder(hasBrain) {
  const resultDiv = document.getElementById('qt-result');
  if (!resultDiv) return;
  resultDiv.innerHTML = renderQueryPlaceholder(hasBrain);
}

/* ═══════════════════════════════════════════════════════
   Event Binding
   ═══════════════════════════════════════════════════════ */

function bindQueryTabEvents() {
  const submitBtn = document.getElementById('qt-submit');
  const clearBtn = document.getElementById('qt-clear');
  const followupBtn = document.getElementById('qt-followup');
  const input = document.getElementById('qt-input');
  const modeSelect = document.getElementById('qt-mode');
  const modelSelect = document.getElementById('qt-model');
  const clearHistoryBtn = document.getElementById('qt-clear-history');
  const morePromptsBtn = document.getElementById('qt-more-prompts');
  const morePromptsPanel = document.getElementById('qt-more-prompts-panel');
  const optionsSection = document.getElementById('qt-options-section');

  submitBtn?.addEventListener('click', () => executeQuery());

  clearBtn?.addEventListener('click', () => clearQuery());

  followupBtn?.addEventListener('click', () => {
    if (!lastQueryResult) return;
    const inp = document.getElementById('qt-input');
    if (inp) {
      inp.value = '';
      inp.placeholder = `Follow-up on: "${(lastQueryResult.query || '').slice(0, 60)}..."`;
      inp.focus();
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      executeQuery();
    }
  });

  morePromptsBtn?.addEventListener('click', () => {
    const willOpen = morePromptsPanel?.classList.contains('qt-hidden');
    morePromptsPanel?.classList.toggle('qt-hidden', !willOpen);
    morePromptsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    morePromptsBtn.textContent = willOpen ? 'Fewer starters' : 'More starters';
  });

  // Update options summary
  modeSelect?.addEventListener('change', refreshQueryOptionsSummary);
  modelSelect?.addEventListener('change', () => {
    const synthSelect = document.getElementById('qt-pgs-synth-model');
    if (synthSelect && !synthSelect.dataset.userChanged) {
      synthSelect.value = modelSelect.value;
    }
    refreshQueryOptionsSummary();
  });
  document.getElementById('qt-pgs-synth-model')?.addEventListener('change', (e) => {
    e.target.dataset.userChanged = '1';
  });
  document.getElementById('qt-pgs-mode')?.addEventListener('change', refreshQueryOptionsSummary);

  const pgsToggle = document.getElementById('qt-pgs');
  pgsToggle?.addEventListener('change', () => {
    const controls = document.getElementById('qt-pgs-controls');
    if (controls) controls.classList.toggle('qt-hidden', !pgsToggle.checked);
    refreshQueryOptionsSummary();
  });

  // PGS depth chip selection
  document.querySelectorAll('.qt-depth-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.qt-depth-chip').forEach(c => c.classList.remove('qt-depth-active'));
      chip.classList.add('qt-depth-active');
      document.getElementById('qt-pgs-depth').value = chip.dataset.depth;
      refreshQueryOptionsSummary();
    });
  });

  // Mode hints
  const modeHints = {
    quick: 'Fast extraction — brief answers',
    full: 'Comprehensive analysis with full brain access',
    expert: 'Maximum depth — thorough multi-pass analysis',
    dive: 'Exploratory synthesis — creative cross-domain connections'
  };
  modeSelect?.addEventListener('change', () => {
    const hint = document.getElementById('qt-mode-hint');
    if (hint) hint.textContent = modeHints[modeSelect.value] || '';
  });

  // Quick prompts
  document.querySelectorAll('.qt-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('qt-input');
      if (inp) { inp.value = btn.dataset.prompt; inp.focus(); }
    });
  });

  // Clear history
  clearHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    queryHistory = [];
    saveQueryHistory();
    updateQueryHistoryUI();
  });

  // Details toggle icon
  document.querySelector('.qt-options-section')?.addEventListener('toggle', function() {
    const icon = this.querySelector('.qt-toggle-icon');
    if (icon) icon.textContent = this.open ? '▼' : '▶';
  });

  optionsSection?.addEventListener('toggle', () => {
    if (optionsSection.open) {
      ensureQueryModelCatalogLoaded();
    }
    const hint = document.getElementById('qt-mode-hint');
    if (hint) {
      hint.style.display = optionsSection.open ? '' : 'none';
    }
  });
}

function compactModelLabel(label) {
  const raw = String(label || '').trim();
  if (!raw) return 'Loading models...';
  if (raw.length <= 28) return raw;
  return `${raw.slice(0, 25)}…`;
}

function refreshQueryOptionsSummary() {
  const summary = document.getElementById('qt-options-summary');
  if (!summary) return;

  const mode = document.getElementById('qt-mode')?.value || 'full';
  const modelSelect = document.getElementById('qt-model');
  const model = compactModelLabel(modelSelect?.selectedOptions?.[0]?.textContent || modelSelect?.value || 'Starter model');
  const pgsOn = document.getElementById('qt-pgs')?.checked;
  const pgsDepthVal = parseFloat(document.getElementById('qt-pgs-depth')?.value || '0.25');
  const depthName = {0.1: 'Skim', 0.25: 'Sample', 0.5: 'Deep', 1.0: 'Full'}[pgsDepthVal] || `${Math.round(pgsDepthVal * 100)}%`;
  const pgs = pgsOn ? ` · 🧬 PGS ${depthName} (${Math.round(pgsDepthVal * 100)}%)` : '';

  summary.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)} mode · ${model}${pgs}`;
}

/* ═══════════════════════════════════════════════════════
   Model Population
   ═══════════════════════════════════════════════════════ */

function buildQueryModelOptions(byProvider, selectedValue) {
  const fragment = document.createDocumentFragment();
  for (const [provider, models] of Object.entries(byProvider)) {
    const group = document.createElement('optgroup');
    group.label = provider.charAt(0).toUpperCase() + provider.slice(1);
    models.forEach((model) => {
      const opt = document.createElement('option');
      opt.value = model.value || model.id;
      opt.dataset.provider = model.provider;
      opt.dataset.modelId = model.id;
      opt.textContent = model.label || model.id;
      if ((model.value || model.id) === selectedValue) {
        opt.selected = true;
      }
      group.appendChild(opt);
    });
    fragment.appendChild(group);
  }
  return fragment;
}

function getQueryFallbackModelHtml() {
  return `
    <option value="anthropic/latest-sonnet" data-provider="anthropic">Claude Sonnet 4.6</option>
    <option value="anthropic/latest-opus" data-provider="anthropic">Claude Opus 4.6</option>
    <option value="anthropic/latest-haiku" data-provider="anthropic">Claude Haiku 4.5</option>
    <option value="openai-codex/latest-codex" data-provider="openai-codex">GPT-5.4</option>
    <option value="openai-codex/latest-mini" data-provider="openai-codex">GPT-5.4 Mini</option>
    <option value="openai-codex/latest-nano" data-provider="openai-codex">GPT-5.4 Nano</option>
    <option value="xai/latest-4-20" data-provider="xai">Grok 4.20</option>
    <option value="xai/latest-4-20-moe" data-provider="xai">Grok 4.20 Multi-Agent</option>
    <option value="ollama-cloud/latest-kimi" data-provider="ollama-cloud">Kimi K2.5</option>
    <option value="ollama-cloud/latest-minimax" data-provider="ollama-cloud">MiniMax M2.7</option>
    <option value="ollama-cloud/latest-nemotron" data-provider="ollama-cloud">Nemotron 3 Super</option>
    <option value="openclaw/openclaw:coz" data-provider="openclaw">COZ — Agent with Memory</option>
  `;
}

function seedQueryModelSelects() {
  const select = document.getElementById('qt-model');
  if (!select) return;

  const sweepSelect = document.getElementById('qt-pgs-sweep-model');
  const synthSelect = document.getElementById('qt-pgs-synth-model');
  const fallbackHtml = getQueryFallbackModelHtml();
  const runtimePrefs = window.EvobrewRuntimePrefs;
  const defaultQuery = runtimePrefs?.getDefaultSelection?.('query', 'anthropic/latest-sonnet') || 'anthropic/latest-sonnet';
  const defaultSweep = runtimePrefs?.getDefaultSelection?.('pgsSweep', 'anthropic/latest-sonnet') || 'anthropic/latest-sonnet';
  const defaultSynth = runtimePrefs?.getDefaultSelection?.('pgsSynth', defaultQuery) || defaultQuery;

  select.innerHTML = fallbackHtml;
  select.dataset.catalogLoaded = 'false';
  if ([...select.options].some((option) => option.value === defaultQuery)) {
    select.value = defaultQuery;
  }

  if (sweepSelect) {
    sweepSelect.innerHTML = fallbackHtml;
    sweepSelect.dataset.catalogLoaded = 'false';
    if ([...sweepSelect.options].some((option) => option.value === defaultSweep)) {
      sweepSelect.value = defaultSweep;
    } else if ([...sweepSelect.options].some((option) => option.value === 'anthropic/claude-sonnet-4-6')) {
      sweepSelect.value = 'anthropic/claude-sonnet-4-6';
    } else {
      sweepSelect.value = 'anthropic/latest-sonnet';
    }
  }

  if (synthSelect) {
    synthSelect.innerHTML = fallbackHtml;
    synthSelect.dataset.catalogLoaded = 'false';
    if ([...synthSelect.options].some((option) => option.value === defaultSynth)) {
      synthSelect.value = defaultSynth;
    } else {
      synthSelect.value = select.value || 'openai/latest-stable';
    }
  }
}

function getSharedModelCatalog() {
  return window.EvobrewModelCatalog || null;
}

function applyQueryModelCatalog(data) {
  const select = document.getElementById('qt-model');
  if (!select || !data?.models?.length) return false;

  const sweepSelect = document.getElementById('qt-pgs-sweep-model');
  const synthSelect = document.getElementById('qt-pgs-synth-model');
  const runtimePrefs = window.EvobrewRuntimePrefs;

  const currentValue = select.value || 'openai/latest-stable';
  const currentSweepValue = sweepSelect?.value || 'anthropic/latest-sonnet';
  const currentSynthValue = synthSelect?.value || currentValue;

  const renderedMain = runtimePrefs?.renderSelect
    ? runtimePrefs.renderSelect(select, data, {
        context: 'query',
        currentValue
      })
    : false;

  if (renderedMain) {
    if (sweepSelect) {
      runtimePrefs.renderSelect(sweepSelect, data, {
        context: 'pgsSweep',
        currentValue: currentSweepValue
      });
    }

    if (synthSelect) {
      runtimePrefs.renderSelect(synthSelect, data, {
        context: 'pgsSynth',
        currentValue: currentSynthValue
      });
    }
  } else {
    const byProvider = {};
    data.models.forEach((model) => {
      if (!byProvider[model.provider]) byProvider[model.provider] = [];
      byProvider[model.provider].push(model);
    });

    select.innerHTML = '';
    select.appendChild(buildQueryModelOptions(byProvider, currentValue));
    if (![...select.options].some((option) => option.selected)) {
      const fallback = [...select.options].find((option) => option.value === 'openai/latest-stable') || select.options[0];
      if (fallback) fallback.selected = true;
    }

    if (sweepSelect) {
      sweepSelect.innerHTML = '';
      sweepSelect.appendChild(buildQueryModelOptions(byProvider, currentSweepValue));
      if (![...sweepSelect.options].some((option) => option.selected)) {
        const fallbackSweep = [...sweepSelect.options].find((option) => option.value === 'anthropic/claude-sonnet-4-6')
          || [...sweepSelect.options].find((option) => option.value === 'anthropic/latest-sonnet')
          || sweepSelect.options[0];
        if (fallbackSweep) fallbackSweep.selected = true;
      }
    }

    if (synthSelect) {
      synthSelect.innerHTML = '';
      synthSelect.appendChild(buildQueryModelOptions(byProvider, currentSynthValue));
      if (![...synthSelect.options].some((option) => option.selected)) {
        const fallbackSynth = [...synthSelect.options].find((option) => option.value === select.value) || synthSelect.options[0];
        if (fallbackSynth) fallbackSynth.selected = true;
      }
    }
  }

  select.dataset.catalogLoaded = 'true';
  if (sweepSelect) sweepSelect.dataset.catalogLoaded = 'true';
  if (synthSelect) synthSelect.dataset.catalogLoaded = 'true';

  refreshQueryOptionsSummary();
  return true;
}

async function populateModels(options = {}) {
  const select = document.getElementById('qt-model');
  if (!select) return;

  if (!select.options.length) {
    seedQueryModelSelects();
  }

  const catalog = getSharedModelCatalog();

  if (options.useCached !== false) {
    const cached = catalog?.getCached?.();
    if (cached?.models?.length) {
      applyQueryModelCatalog(cached);
    }
  }

  try {
    const data = catalog?.fetch
      ? await catalog.fetch({ refresh: options.refresh === true })
      : await fetch(options.refresh ? '/api/providers/models?refresh=1' : '/api/providers/models').then((res) => res.json());

    if (!data?.success || !data.models?.length) return;

    applyQueryModelCatalog(data);

    if (options.backgroundRefresh !== false && options.refresh !== true) {
      catalog?.refreshInBackground?.();
    }
  } catch (e) {
    console.warn('[QueryTab] Could not load models:', e);
  }
}

function ensureQueryModelCatalogLoaded() {
  const select = document.getElementById('qt-model');
  if (!select) return;
  const optionCount = select.querySelectorAll('option').length;
  if (select.dataset.catalogLoaded === 'true' && optionCount > 0) return;
  populateModels();
}

/* ═══════════════════════════════════════════════════════
   Brain Status Check
   ═══════════════════════════════════════════════════════ */

async function checkBrainStatus() {
  try {
    const res = await fetch('/api/brain/info');
    const data = await res.json();
    const hasBrain = Boolean(data.hasBrain);
    const input = document.getElementById('qt-input');
    if (input) {
      input.placeholder = hasBrain
        ? "Ask a question about this brain's knowledge..."
        : 'Connect a brain to start research...';
    }

    const resultDiv = document.getElementById('qt-result');
    if (resultDiv?.querySelector('.qt-result-placeholder')) {
      updateQueryPlaceholder(hasBrain);
    }
  } catch {}
}

/* ═══════════════════════════════════════════════════════
   Execute Query — dispatch to streaming or non-streaming
   ═══════════════════════════════════════════════════════ */

async function executeQuery() {
  const input = document.getElementById('qt-input');
  const query = input?.value?.trim();
  if (!query) return;

  const enablePGSEarly = document.getElementById('qt-pgs')?.checked || false;
  const baseModel = document.getElementById('qt-model')?.value || 'openai/latest-stable';
  const model = (enablePGSEarly && document.getElementById('qt-pgs-synth-model')?.value) || baseModel;
  const mode = document.getElementById('qt-mode')?.value || 'full';
  const includeEvidenceMetrics = document.getElementById('qt-evidence')?.checked || false;
  const enableSynthesis = document.getElementById('qt-synthesis')?.checked ?? true;
  const includeCoordinatorInsights = document.getElementById('qt-coordinator')?.checked ?? true;
  const includeOutputs = document.getElementById('qt-outputs')?.checked ?? true;
  const includeThoughts = document.getElementById('qt-thoughts')?.checked ?? true;
  const allowActions = document.getElementById('qt-allow-actions')?.checked || false;
  const enablePGS = enablePGSEarly;
  const pgsMode = document.getElementById('qt-pgs-mode')?.value || 'full';
  const pgsSessionId = (document.getElementById('qt-pgs-session')?.value || '').trim() || 'default';
  const pgsDepth = parseFloat(document.getElementById('qt-pgs-depth')?.value || '0.25');
  const useStreaming = document.getElementById('qt-stream')?.checked ?? true;
  const pgsSweepModel = enablePGS ? (document.getElementById('qt-pgs-sweep-model')?.value || null) : null;

  const submitBtn = document.getElementById('qt-submit');
  const loadingDiv = document.getElementById('qt-loading');
  const resultDiv = document.getElementById('qt-result');

  submitBtn.disabled = true;
  loadingDiv.classList.remove('qt-hidden');

  // Update loading hint for PGS
  const depthLabel = {0.1: 'Skim', 0.25: 'Sample', 0.5: 'Deep', 1.0: 'Full'}[pgsDepth] || `${Math.round(pgsDepth * 100)}%`;
  const hintEl = document.getElementById('qt-loading-hint');
  if (hintEl) {
    hintEl.textContent = enablePGS
      ? `PGS ${depthLabel} (${Math.round(pgsDepth * 100)}% coverage) — ${pgsDepth <= 0.25 ? '1-3 min' : pgsDepth <= 0.5 ? '3-6 min' : '5-10+ min'}`
      : 'This may take 10-30 seconds';
  }

  const options = {
    includeEvidenceMetrics,
    enableSynthesis,
    includeCoordinatorInsights,
    includeOutputs,
    includeThoughts,
    allowActions,
    enablePGS,
    pgsMode,
    pgsSessionId,
    pgsFullSweep: pgsDepth >= 1.0,
    pgsConfig: { sweepFraction: pgsDepth },
    pgsSweepModel
  };

  try {
    if (useStreaming) {
      await executeQueryStreaming(query, model, mode, options, submitBtn, loadingDiv, resultDiv);
      return;
    }

    // Non-streaming path
    resultDiv.style.display = 'none';

    const res = await fetch('/api/brain/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, model, mode, ...options,
        exportFormat: 'markdown',
        priorContext: lastQueryResult ? {
          query: lastQueryResult.query,
          answer: lastQueryResult.answer
        } : null
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.message || data.error);

    lastQueryResult = { query, answer: data.answer, metadata: data.metadata, fullResult: data };
    enableFollowUp();
    displayQueryResult(data);
    saveToHistory({ query, ...data });

  } catch (error) {
    console.error('Query failed:', error);
    resultDiv.innerHTML = `<div class="qt-error">Query failed: ${escapeHtml(error.message)}</div>`;
    resultDiv.style.display = '';
  } finally {
    submitBtn.disabled = false;
    loadingDiv.classList.add('qt-hidden');
  }
}

/* ═══════════════════════════════════════════════════════
   Streaming Query — SSE with PGS progress
   ═══════════════════════════════════════════════════════ */

async function executeQueryStreaming(query, model, mode, options, submitBtn, loadingDiv, resultDiv) {
  const isPGS = options.enablePGS || false;
  let pgsTimerInterval = null;
  const pgsStartTime = Date.now();

  try {
    const response = await fetch('/api/brain/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, model, mode, ...options,
        exportFormat: 'markdown',
        priorContext: lastQueryResult ? {
          query: lastQueryResult.query,
          answer: lastQueryResult.answer
        } : null
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedAnswer = '';
    let finalResult = null;

    // Show result div for streaming
    resultDiv.style.display = '';

    if (isPGS) {
      resultDiv.innerHTML = buildPGSProgressHTML();
      // Start timer
      const timerEl = resultDiv.querySelector('.pgs-timer');
      pgsTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - pgsStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        if (timerEl) timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }, 1000);
    } else {
      resultDiv.innerHTML = `
        <div class="qt-streaming-progress" style="display:none;"></div>
        <div class="qt-streaming-container"></div>
      `;
    }

    loadingDiv.classList.add('qt-hidden');

    const containerDiv = resultDiv.querySelector('.qt-streaming-container');
    const progressDiv = resultDiv.querySelector('.qt-streaming-progress');

    // PGS state
    const pgsPhases = ['partitioning', 'routing', 'sweeping', 'synthesizing'];
    let pgsCurrentPhaseIndex = -1;

    const pgsUpdatePhase = (phase) => {
      if (!resultDiv) return;
      // Mark prior phases done
      for (let i = 0; i <= pgsCurrentPhaseIndex; i++) {
        const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${pgsPhases[i]}"]`);
        if (el) { el.classList.remove('pgs-active'); el.classList.add('pgs-done'); }
      }
      const newIdx = pgsPhases.indexOf(phase);
      if (newIdx >= 0) {
        pgsCurrentPhaseIndex = newIdx;
        const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${phase}"]`);
        if (el) el.classList.add('pgs-active');
      } else if (phase === 'done') {
        for (const p of pgsPhases) {
          const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${p}"]`);
          if (el) { el.classList.remove('pgs-active'); el.classList.add('pgs-done'); }
        }
      }
    };

    const pgsSetStatus = (msg) => {
      const el = resultDiv.querySelector('.pgs-status');
      if (el) el.textContent = msg;
    };

    const pgsAddLog = (msg) => {
      const logEl = resultDiv.querySelector('.pgs-log');
      if (!logEl) return;
      const entry = document.createElement('div');
      const elapsed = Math.floor((Date.now() - pgsStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      entry.textContent = `[${mins}:${secs.toString().padStart(2, '0')}] ${msg}`;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const pgsBuildSweepTracker = (partitions) => {
      const tracker = resultDiv.querySelector('.pgs-sweep-tracker');
      if (!tracker) return;
      tracker.style.display = '';
      tracker.innerHTML = `<div class="pgs-sweep-header">Sweep Progress</div>` +
        partitions.map(p => `
          <div class="pgs-sweep-row" data-partition="${p.id}">
            <span class="pgs-sweep-status">○</span>
            <span class="pgs-sweep-name">${escapeHtml(p.summary)}</span>
            <span class="pgs-sweep-meta">${p.nodeCount} nodes</span>
          </div>
        `).join('');
    };

    const pgsUpdateSweepRow = (partitionId, status) => {
      const row = resultDiv.querySelector(`.pgs-sweep-row[data-partition="${partitionId}"]`);
      if (!row) return;
      const statusEl = row.querySelector('.pgs-sweep-status');
      if (statusEl) {
        if (status === 'active') { statusEl.textContent = '◉'; statusEl.style.color = '#a78bfa'; }
        else if (status === 'done') { statusEl.textContent = '✓'; statusEl.style.color = '#4ade80'; }
        else if (status === 'failed') { statusEl.textContent = '✗'; statusEl.style.color = '#f87171'; }
      }
      if (status === 'active') row.style.color = 'var(--text-primary)';
      else if (status === 'done') row.style.color = 'var(--text-secondary)';
    };

    // Process SSE stream
    // Server sends: event: <type>\ndata: <json>\n\n
    let currentEventType = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            const type = currentEventType || event.type || 'progress';
            currentEventType = null; // Reset after consuming

            handleSSEEvent(type, event, {
              isPGS, containerDiv, progressDiv, resultDiv,
              pgsUpdatePhase, pgsSetStatus, pgsAddLog,
              pgsBuildSweepTracker, pgsUpdateSweepRow,
              pgsStartTime, pgsTimerInterval,
              accumulatedAnswer: () => accumulatedAnswer,
              setAccumulatedAnswer: (v) => { accumulatedAnswer = v; },
              setFinalResult: (v) => { finalResult = v; },
              clearPgsTimer: () => {
                if (pgsTimerInterval) { clearInterval(pgsTimerInterval); pgsTimerInterval = null; }
              }
            });
          } catch (parseErr) {
            console.warn('[QueryTab] SSE parse error:', parseErr);
          }
        }

        // Reset event type on empty lines (event boundary)
        if (line.trim() === '') {
          currentEventType = null;
        }
      }
    }

    // Final result display
    if (finalResult) {
      lastQueryResult = {
        query: finalResult.query || query,
        answer: finalResult.answer,
        metadata: finalResult.metadata,
        fullResult: finalResult
      };
      enableFollowUp();

      // Smooth transition
      resultDiv.style.opacity = '0.5';
      resultDiv.style.transition = 'opacity 0.2s ease-in-out';
      setTimeout(() => {
        displayQueryResult(finalResult);
        resultDiv.style.opacity = '1';
      }, 200);

      saveToHistory({ query: finalResult.query || query, ...finalResult });
    }

  } catch (error) {
    console.error('Streaming query failed:', error);
    resultDiv.innerHTML = `<div class="qt-error">Query failed: ${escapeHtml(error.message)}</div>`;
    resultDiv.style.display = '';
  } finally {
    submitBtn.disabled = false;
    loadingDiv.classList.add('qt-hidden');
    if (pgsTimerInterval) { clearInterval(pgsTimerInterval); pgsTimerInterval = null; }
  }
}

/* ═══════════════════════════════════════════════════════
   SSE Event Handler
   ═══════════════════════════════════════════════════════ */

function handleSSEEvent(type, event, ctx) {
  const { isPGS, containerDiv, progressDiv, resultDiv } = ctx;

  switch (type) {
    case 'error':
      throw new Error(event.error || event.message || 'Unknown error');

    case 'thinking':
    case 'progress':
      if (isPGS) {
        ctx.pgsSetStatus(event.message);
        ctx.pgsAddLog(event.message);
      } else if (progressDiv) {
        progressDiv.textContent = `💭 ${event.message}`;
        progressDiv.style.display = '';
      }
      break;

    case 'response_chunk':
    case 'chunk': {
      const text = event.chunk || event.text || '';
      const newAnswer = ctx.accumulatedAnswer() + text;
      ctx.setAccumulatedAnswer(newAnswer);
      if (containerDiv && containerDiv.textContent !== newAnswer) {
        containerDiv.textContent = newAnswer;
        if (!isPGS && progressDiv) progressDiv.style.display = 'none';
        // Auto-scroll if near bottom
        if (resultDiv) {
          const nearBottom = resultDiv.scrollHeight - resultDiv.scrollTop - resultDiv.clientHeight < 200;
          if (nearBottom) resultDiv.scrollTop = resultDiv.scrollHeight;
        }
      }
      break;
    }

    case 'pgs_init':
      if (isPGS) {
        ctx.pgsSetStatus(`Brain: ${event.totalNodes?.toLocaleString()} nodes, ${event.totalEdges?.toLocaleString()} edges`);
        ctx.pgsAddLog(`Brain loaded: ${event.totalNodes?.toLocaleString()} nodes, ${event.totalEdges?.toLocaleString()} edges`);
      }
      break;

    case 'pgs_phase':
      if (isPGS) {
        ctx.pgsUpdatePhase(event.phase);
        ctx.pgsSetStatus(event.message);
        ctx.pgsAddLog(event.message);
      } else if (progressDiv) {
        const icons = { loading: '📂', partitioning: '🧩', routing: '🔀', sweeping: '🔬', synthesizing: '🧬' };
        progressDiv.textContent = `${icons[event.phase] || '⚡'} PGS: ${event.message}`;
        progressDiv.style.display = '';
      }
      break;

    case 'pgs_session':
      if (isPGS) {
        ctx.pgsAddLog(`Session ${event.sessionId || 'default'} · searched ${event.searched}/${event.total} · remaining ${event.remaining}`);
      }
      break;

    case 'pgs_session_updated':
      if (isPGS) {
        ctx.pgsAddLog(`Session updated · searched ${event.searched}/${event.total} · remaining ${event.remaining}`);
      }
      break;

    case 'pgs_routed':
      if (isPGS && event.partitions) {
        ctx.pgsBuildSweepTracker(event.partitions);
        ctx.pgsAddLog(`Routed to ${event.partitions.length}/${event.totalPartitions} partitions`);
      }
      break;

    case 'pgs_sweep_progress':
      if (isPGS) {
        if (event.status === 'started') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'active');
          ctx.pgsSetStatus(`Sweeping: ${event.summary} (${event.nodeCount} nodes)`);
        } else if (event.status === 'complete') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'done');
          ctx.pgsSetStatus(`Sweep ${event.completed}/${event.total} complete`);
        } else if (event.status === 'failed') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'failed');
          ctx.pgsSetStatus(`Sweep failed: ${event.summary}`);
        }
        ctx.pgsAddLog(event.message);
      } else if (progressDiv) {
        progressDiv.textContent = `🔬 ${event.message}`;
        progressDiv.style.display = '';
      }
      break;

    case 'tool_call':
      if (isPGS) ctx.pgsAddLog(`Tool: ${event.tool || 'unknown'}`);
      else if (progressDiv) { progressDiv.textContent = `🔧 Executing: ${event.tool || 'tool'}...`; progressDiv.style.display = ''; }
      break;

    case 'tool_result':
      if (isPGS) ctx.pgsAddLog(`Tool complete: ${event.tool || 'unknown'}`);
      else if (progressDiv) { progressDiv.textContent = `✅ Completed: ${event.tool || 'tool'}`; progressDiv.style.display = ''; }
      break;

    case 'result':
    case 'complete':
      ctx.setFinalResult(event);
      ctx.clearPgsTimer();
      if (isPGS) {
        ctx.pgsUpdatePhase('done');
        const elapsed = Math.floor((Date.now() - ctx.pgsStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        ctx.pgsSetStatus(`Complete in ${mins}:${secs.toString().padStart(2, '0')}`);
        const statusEl = resultDiv?.querySelector('.pgs-status');
        if (statusEl) statusEl.style.animation = 'none';
      } else if (progressDiv) {
        progressDiv.style.display = 'none';
      }
      break;
  }
}

/* ═══════════════════════════════════════════════════════
   Display Query Result (final formatted view)
   ═══════════════════════════════════════════════════════ */

function displayQueryResult(result) {
  const resultDiv = document.getElementById('qt-result');
  if (!resultDiv) return;

  const sourceCount = result.metadata?.sources?.memoryNodes || 0;
  const thoughtCount = result.metadata?.sources?.thoughts || 0;
  const liveNodes = result.metadata?.sources?.liveJournalNodes || 0;

  const answerHtml = renderMarkdownSafe(result.answer || '');

  let html = `
    <div class="qt-answer-card">
      <div class="qt-answer-header">📝 ${escapeHtml(result.query || '')}</div>
      <div class="qt-answer-content">${answerHtml}</div>
  `;

  // Action results
  if (result.actionSuggestion) {
    html += `<div class="qt-action-suggestion">
      <div class="qt-action-title">💡 Action Detected</div>
      <div>${escapeHtml(result.actionSuggestion.message)}</div>
      <div class="qt-action-hint">Enable "Allow Actions" checkbox to execute.</div>
    </div>`;
  }

  if (result.actionExecuted && result.actionResult?.success) {
    const files = result.actionResult.filesCreated || [];
    if (files.length > 0) {
      html += `<div class="qt-action-success">
        <div class="qt-action-title">✅ Files Created</div>
        <div>${escapeHtml(result.actionResult.message || 'Files created successfully')}</div>
        <div class="qt-files-list">${files.map(f =>
          `<div class="qt-file-item">📄 ${escapeHtml(f.path)} <span class="qt-file-size">${(f.size / 1024).toFixed(1)} KB</span></div>`
        ).join('')}</div>
      </div>`;
    }
  }

  if (result.actionError) {
    html += `<div class="qt-action-error">
      <div class="qt-action-title">❌ Action Failed</div>
      <div>${escapeHtml(result.actionError)}</div>
    </div>`;
  }

  // PGS metadata
  const pgs = result.metadata?.pgs;
  if (pgs) {
    html += `<div class="qt-metadata qt-pgs-meta">
      <span>🧬 PGS</span>
      <span>🔬 ${pgs.sweptPartitions}/${pgs.totalPartitions} partitions swept</span>
      <span>📊 ${pgs.totalNodes?.toLocaleString()} nodes (100% coverage)</span>
      <span>🔬 Sweep: ${escapeHtml(pgs.sweepModel || '?')}</span>
      <span>🧬 Synthesis: ${escapeHtml(pgs.synthesisModel || '?')}</span>
      <span>⏱️ ${pgs.elapsed || '?'}</span>
    </div>`;
  }

  // Standard metadata
  html += `<div class="qt-metadata">
    <span>📊 ${sourceCount} memory nodes</span>
    <span>💭 ${thoughtCount} thoughts</span>
    ${liveNodes > 0 ? `<span>🔴 ${liveNodes} live</span>` : ''}
    <span>⚡ ${escapeHtml(result.metadata?.model || 'unknown')}</span>
    <span>🎯 ${escapeHtml(result.metadata?.mode || 'normal')}</span>
    <span>🕐 ${result.metadata?.timestamp ? new Date(result.metadata.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}</span>
  </div>`;

  // Evidence quality
  if (result.metadata?.evidenceQuality) {
    const eq = result.metadata.evidenceQuality;
    html += `<div class="qt-panel">
      <div class="qt-panel-title">📊 Evidence Quality</div>
      <div>Summary: ${escapeHtml(eq.summary || eq.quality || 'N/A')}</div>
      <div>Coverage: ${eq.coverage?.rating || 'N/A'} (${Math.round((eq.coverage?.percentage || eq.confidence || 0) * 100)}%)</div>
      ${eq.confidence?.rating ? `<div>Confidence: ${eq.confidence.rating} (${Math.round((eq.confidence.score || 0) * 100)}%)</div>` : ''}
    </div>`;
  }

  // Synthesis
  if (result.metadata?.synthesis) {
    html += `<div class="qt-panel">
      <div class="qt-panel-title">🔬 Synthesis</div>
      <div>${escapeHtml(result.metadata.synthesis.summary || 'Included in response')}</div>
    </div>`;
  }

  // Auto-save confirmation + export controls
  const exportedTo = result.exportedTo || (result.metadata && result.metadata.exportedTo);
  html += `<div class="qt-export-actions">`;
  if (exportedTo) {
    html += `<span class="qt-auto-saved">✅ Auto-saved to <code>${escapeHtml(exportedTo.split('/').slice(-3).join('/'))}</code></span>`;
  }
  html += `
    <button class="qt-btn qt-btn-primary qt-btn-sm" onclick="exportToBrain()">💾 Save to Brain</button>
    <select id="qt-export-format" class="qt-select-sm">
      <option value="markdown">Markdown</option>
      <option value="json">JSON</option>
    </select>
    <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="downloadQueryResult()">⬇ Download</button>
    <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="copyQueryResult()">📋 Copy</button>
  </div>`;

  html += `</div>`; // close answer card

  resultDiv.innerHTML = html;
  resultDiv.style.display = '';
  resultDiv.scrollTop = 0;
}

/* ═══════════════════════════════════════════════════════
   PGS Progress Panel HTML
   ═══════════════════════════════════════════════════════ */

function buildPGSProgressHTML() {
  return `
    <div class="pgs-progress-panel">
      <div class="pgs-status-row">
        <span class="pgs-title">🧬 Partitioned Graph Synthesis</span>
        <span class="pgs-timer">0:00</span>
      </div>
      <div class="pgs-status">Initializing...</div>
      <div class="pgs-phases">
        ${['partitioning', 'routing', 'sweeping', 'synthesizing'].map((p, i, arr) => `
          <div class="pgs-phase-step" data-phase="${p}">
            <span class="pgs-step-dot"></span>
            <span>${p.charAt(0).toUpperCase() + p.slice(1).replace('ing', '')}</span>
          </div>
          ${i < arr.length - 1 ? '<div class="pgs-phase-connector"></div>' : ''}
        `).join('')}
      </div>
      <div class="pgs-sweep-tracker" style="display:none;"></div>
      <div class="pgs-log-section">
        <div class="pgs-log"></div>
      </div>
    </div>
    <div class="qt-streaming-container"></div>
  `;
}

/* ═══════════════════════════════════════════════════════
   Export / Copy
   ═══════════════════════════════════════════════════════ */

function copyQueryResult() {
  if (!lastQueryResult?.answer) { showQueryToast('No result to copy'); return; }
  navigator.clipboard.writeText(lastQueryResult.answer)
    .then(() => showQueryToast('✅ Copied to clipboard'))
    .catch(() => showQueryToast('❌ Copy failed'));
}

async function exportToBrain() {
  if (!lastQueryResult) { showQueryToast('No result to export'); return; }
  const fmt = document.getElementById('qt-export-format')?.value || 'markdown';
  try {
    const res = await fetch('/api/brain/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: lastQueryResult.query,
        answer: lastQueryResult.answer,
        format: fmt,
        metadata: lastQueryResult.metadata || {}
      })
    });
    const data = await res.json();
    if (data.exportedTo) {
      showQueryToast(`✅ Saved: ${data.exportedTo.split('/').slice(-2).join('/')}`);
    } else {
      showQueryToast(`❌ ${data.error || 'Export failed'}`);
    }
  } catch (err) {
    showQueryToast(`❌ ${err.message}`);
  }
}

function downloadQueryResult() {
  if (!lastQueryResult) { showQueryToast('No result to export'); return; }
  const fmt = document.getElementById('qt-export-format')?.value || 'markdown';
  const ts = Date.now();

  if (fmt === 'json') {
    const data = lastQueryResult.fullResult || lastQueryResult;
    downloadFile(`query-${ts}.json`, JSON.stringify(data, null, 2), 'application/json');
  } else {
    const meta = lastQueryResult.metadata || {};
    let md = `# ${lastQueryResult.query}\n\n`;
    md += `> ⚡ ${meta.model || '?'} · 🎯 ${meta.mode || '?'} · ${new Date().toLocaleString()}\n\n`;
    md += lastQueryResult.answer || '';
    downloadFile(`query-${ts}.md`, md, 'text/markdown');
  }
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════════════════════
   Follow-Up & Context
   ═══════════════════════════════════════════════════════ */

function enableFollowUp() {
  const btn = document.getElementById('qt-followup');
  if (btn) btn.disabled = false;
  const indicator = document.getElementById('qt-context-indicator');
  if (indicator) indicator.classList.remove('qt-hidden');
}

/* ═══════════════════════════════════════════════════════
   History
   ═══════════════════════════════════════════════════════ */

function getHistoryKey() {
  const brainPath = window.currentBrainInfo?.brainPath || 'global';
  return `cosmo.queryHistory.${brainPath}`;
}

function saveToHistory(item) {
  queryHistory.unshift(item);
  queryHistory = queryHistory.slice(0, 50);
  saveQueryHistory();
  updateQueryHistoryUI();
}

function saveQueryHistory() {
  try { localStorage.setItem(getHistoryKey(), JSON.stringify(queryHistory.slice(0, 50))); } catch {}
}

function loadQueryHistory() {
  try {
    const saved = localStorage.getItem(getHistoryKey());
    if (saved) { queryHistory = JSON.parse(saved); updateQueryHistoryUI(); }
  } catch { queryHistory = []; }
}

function updateQueryHistoryUI() {
  const section = document.getElementById('qt-history');
  const list = document.getElementById('qt-history-list');
  if (!section || !list) return;

  if (queryHistory.length === 0) {
    section.classList.add('qt-hidden');
    return;
  }

  section.classList.remove('qt-hidden');
  list.innerHTML = queryHistory.slice(0, 20).map((item, i) => `
    <div class="qt-history-item" onclick="loadHistoryItem(${i})">
      <div class="qt-history-query">${escapeHtml(item.query || '')}</div>
      <div class="qt-history-meta">${item.metadata?.mode || '?'} · ${item.metadata?.timestamp ? new Date(item.metadata.timestamp).toLocaleString() : ''}</div>
    </div>
  `).join('');
}

function loadHistoryItem(index) {
  const item = queryHistory[index];
  if (!item) return;
  document.getElementById('qt-input').value = item.query || '';
  lastQueryResult = { query: item.query, answer: item.answer, metadata: item.metadata, fullResult: item };
  enableFollowUp();
  displayQueryResult(item);
}

/* ═══════════════════════════════════════════════════════
   Clear
   ═══════════════════════════════════════════════════════ */

function clearQuery() {
  const input = document.getElementById('qt-input');
  if (input) {
    input.value = '';
    input.placeholder = window.currentBrainInfo?.brainPath
      ? "Ask a question about this brain's knowledge..."
      : 'Connect a brain to start research...';
  }

  const resultDiv = document.getElementById('qt-result');
  if (resultDiv) {
    resultDiv.innerHTML = renderQueryPlaceholder(Boolean(window.currentBrainInfo?.brainPath));
  }

  lastQueryResult = null;
  const btn = document.getElementById('qt-followup');
  if (btn) btn.disabled = true;
  const indicator = document.getElementById('qt-context-indicator');
  if (indicator) indicator.classList.add('qt-hidden');
}

/* ═══════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════ */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizeRenderedHtml(html) {
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }
  return escapeHtml(String(html || ''));
}

function renderMarkdownSafe(markdown) {
  if (typeof marked !== 'undefined' && marked.parse) {
    return sanitizeRenderedHtml(marked.parse(markdown || ''));
  }
  return `<pre style="white-space:pre-wrap;">${escapeHtml(markdown || '(no answer)')}</pre>`;
}

function showQueryToast(msg, duration = 3000) {
  if (typeof showToast === 'function') { showToast(msg, 'info'); return; }
  let t = document.getElementById('qt-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'qt-toast';
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;background:#333;color:#eee;font-size:13px;z-index:10000;opacity:0;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, duration);
}

/* ═══════════════════════════════════════════════════════
   CSS — Self-Contained
   ═══════════════════════════════════════════════════════ */

function getQueryTabStyles() {
  return `
  /* ── Container ── */
  .qt-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 20px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    background: var(--bg-primary);
    gap: 14px;
  }

  .qt-hidden { display: none !important; }

  /* ── Input Section ── */
  .qt-input-section {
    flex-shrink: 0;
  }

  .qt-textarea {
    width: 100%;
    min-height: 80px;
    max-height: 200px;
    padding: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 16px;
    resize: vertical;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .qt-textarea:focus { outline: none; border-color: var(--accent-primary); }

  .qt-actions-compact {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .qt-starter-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .qt-starter-eyebrow {
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-secondary);
    font-weight: 700;
  }
  .qt-starter-title {
    margin-top: 4px;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .qt-starter-prompt-bar {
    padding: 12px 14px;
    margin-top: 12px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, var(--accent-primary) 6%);
    border: 1px solid var(--border-color);
    border-radius: 10px;
  }

  /* ── Buttons ── */
  .qt-btn {
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    min-height: 44px;
    padding: 10px 20px;
    transition: all 0.15s;
  }
  .qt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .qt-btn-primary { background: var(--accent-primary); color: white; }
  .qt-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .qt-btn-outline {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }
  .qt-btn-outline:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
  .qt-btn-sm { padding: 6px 14px; font-size: 12px; min-height: 36px; }
  .qt-btn-text {
    background: none; border: none; color: var(--text-muted, var(--text-secondary));
    font-size: 12px; cursor: pointer; padding: 4px 8px;
  }
  .qt-btn-text:hover { color: var(--text-primary); }

  /* ── Context Indicator ── */
  .qt-context-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent-primary);
    margin-left: auto;
  }
  .qt-context-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent-primary);
    animation: qt-pulse 2s ease-in-out infinite;
  }

  /* ── Collapsible Options ── */
  .qt-options-section {
    flex-shrink: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .qt-options-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    min-height: 44px;
    user-select: none;
    list-style: none;
  }
  .qt-options-section[open] .qt-options-toggle {
    border-bottom: 1px solid var(--border-color);
    color: var(--text-primary);
  }
  .qt-options-toggle::-webkit-details-marker { display: none; }
  .qt-toggle-icon { font-size: 10px; opacity: 0.6; transition: transform 0.2s; }
  .qt-options-summary { margin-left: auto; font-size: 12px; opacity: 0.7; }

  .qt-options-content {
    padding: 0 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .qt-advanced-intro {
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-secondary);
    padding-top: 2px;
  }

  /* ── Quick Prompts ── */
  .qt-quick-prompts { }
  .qt-quick-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; margin-bottom: 8px; }
  .qt-quick-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .qt-quick-grid--featured {
    margin-bottom: 0;
  }
  .qt-quick-grid--more {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed color-mix(in srgb, var(--border-color) 80%, transparent);
  }
  .qt-quick-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary, rgba(255,255,255,0.05));
    border: 1px solid var(--border-color);
    border-radius: 16px;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    min-height: 32px;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .qt-quick-btn:hover { border-color: var(--accent-primary); color: var(--text-primary); }

  /* ── Options Grid ── */
  .qt-options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 14px;
    align-items: end;
  }
  .qt-option-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qt-option-group label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }

  .qt-select, .qt-select-sm {
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    min-height: 36px;
  }
  .qt-select-sm { padding: 6px 10px; font-size: 12px; min-height: 30px; }

  .qt-checkbox-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; cursor: pointer; min-height: 44px;
  }

  /* ── Mode Hint ── */
  .qt-mode-hint {
    font-size: 12px;
    color: var(--text-muted, var(--text-secondary));
    font-style: italic;
  }

  /* ── Enhancement & Context Toggles ── */
  .qt-enhancements, .qt-context-options {
    display: flex; gap: 16px; flex-wrap: wrap;
  }
  .qt-toggle-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-primary);
    cursor: pointer; min-height: 44px;
  }
  .qt-pgs-label { color: #a78bfa; font-weight: 600; }
  .qt-pgs-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
  }
  .qt-pgs-model-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    grid-column: span 2;
  }
  .qt-pgs-model-row .qt-select {
    width: 100%;
  }
  .qt-pgs-depth-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .qt-depth-chip {
    padding: 5px 12px;
    border: 1px solid var(--border-color);
    border-radius: 16px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .qt-depth-chip:hover {
    border-color: var(--accent-color, #d4a843);
    color: var(--text-primary);
  }
  .qt-depth-chip.qt-depth-active {
    background: rgba(212, 168, 67, 0.2);
    border-color: var(--accent-color, #d4a843);
    color: var(--accent-color, #d4a843);
  }
  .qt-input-inline {
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    min-height: 36px;
  }

  /* ── Response Section ── */
  .qt-response-section {
    flex: 1;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Loading ── */
  .qt-loading {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 40px;
    text-align: center;
    color: var(--text-secondary);
  }
  .qt-spinner {
    width: 36px; height: 36px;
    border: 3px solid var(--border-color);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: qt-spin 1s linear infinite;
    margin: 0 auto 16px;
  }
  .qt-loading-hint { font-size: 12px; opacity: 0.7; margin-top: 8px; }
  @keyframes qt-spin { to { transform: rotate(360deg); } }
  @keyframes qt-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* ── Result Area ── */
  .qt-result {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 20px;
    min-height: 120px;
    overflow-y: auto;
  }

  .qt-result-placeholder {
    text-align: center;
    color: var(--text-secondary);
    padding: 40px 20px;
  }
  .qt-result-placeholder svg { opacity: 0.3; margin-bottom: 12px; }
  .qt-result-placeholder p { margin: 4px 0; }
  .qt-hint { font-size: 12px; opacity: 0.6; }
  .qt-placeholder-actions {
    display: flex;
    justify-content: center;
    margin-top: 14px;
  }

  /* ── Streaming ── */
  .qt-streaming-progress {
    color: var(--text-muted, var(--text-secondary));
    font-style: italic;
    padding: 12px;
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
    border-radius: 6px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .qt-streaming-container {
    white-space: pre-wrap;
    font-family: inherit;
    line-height: 1.6;
    font-size: 14px;
    color: var(--text-primary);
  }

  /* ── Answer Card ── */
  .qt-answer-card { }
  .qt-answer-header {
    font-weight: 600; font-size: 14px;
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-primary);
  }
  .qt-answer-content {
    font-size: 14px; line-height: 1.7;
    color: var(--text-primary); overflow-x: auto;
  }
  .qt-answer-content h1, .qt-answer-content h2, .qt-answer-content h3 { margin-top: 16px; margin-bottom: 8px; }
  .qt-answer-content pre {
    background: var(--bg-tertiary, #1a1a1a);
    padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px;
  }
  .qt-answer-content code { font-size: 12px; }
  .qt-answer-content ul, .qt-answer-content ol { padding-left: 20px; }
  .qt-answer-content blockquote {
    border-left: 3px solid var(--accent-primary);
    margin: 8px 0; padding: 4px 12px;
    color: var(--text-secondary);
  }

  /* ── Metadata ── */
  .qt-metadata {
    display: flex; gap: 14px; flex-wrap: wrap;
    padding-top: 12px; margin-top: 12px;
    border-top: 1px solid var(--border-color);
    font-size: 12px; color: var(--text-secondary);
  }
  .qt-pgs-meta {
    background: rgba(167, 139, 250, 0.08);
    border: 1px solid rgba(167, 139, 250, 0.2);
    border-radius: 6px;
    padding: 10px 14px;
    margin-top: 12px;
  }

  /* ── Panels ── */
  .qt-panel {
    margin-top: 12px; padding: 10px 14px;
    border-radius: 6px; font-size: 12px;
    color: var(--text-secondary);
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
    border: 1px solid var(--border-color);
  }
  .qt-panel-title { font-weight: 600; margin-bottom: 4px; }

  /* ── Actions (suggestion/success/error) ── */
  .qt-action-suggestion, .qt-action-success, .qt-action-error {
    margin-top: 12px; padding: 10px 14px; border-radius: 6px; font-size: 13px;
  }
  .qt-action-suggestion { background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.2); }
  .qt-action-success { background: rgba(40,167,69,0.08); border: 1px solid rgba(40,167,69,0.2); }
  .qt-action-error { background: rgba(220,53,69,0.08); border: 1px solid rgba(220,53,69,0.2); }
  .qt-action-title { font-weight: 600; margin-bottom: 4px; }
  .qt-action-hint { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
  .qt-files-list { margin-top: 6px; }
  .qt-file-item { padding: 2px 0; font-size: 12px; }
  .qt-file-size { opacity: 0.6; font-size: 11px; }

  /* ── Export inside card ── */
  .qt-export-actions {
    margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border-color);
    display: flex; gap: 8px; align-items: center;
  }
  .qt-export-label { font-size: 12px; color: var(--text-muted, var(--text-secondary)); margin-right: 4px; }
  .qt-auto-saved { font-size: 11px; color: #4caf50; margin-right: 8px; width: 100%; margin-bottom: 6px; }
  .qt-auto-saved code { font-size: 10px; background: rgba(76,175,80,0.1); padding: 1px 4px; border-radius: 3px; }
  .qt-btn-primary { background: var(--accent, #4a9eff); color: #fff; border: none; font-weight: 600; }
  .qt-btn-primary:hover { opacity: 0.9; }

  /* ── Error ── */
  .qt-error {
    padding: 16px; color: #ff6b6b; text-align: center;
  }

  /* ── PGS Progress Panel ── */
  .pgs-progress-panel {
    margin-bottom: 16px;
    padding: 16px;
    background: rgba(167, 139, 250, 0.05);
    border: 1px solid rgba(167, 139, 250, 0.15);
    border-radius: 8px;
  }
  .pgs-status-row {
    display: flex; justify-content: space-between; align-items: center;
  }
  .pgs-title { font-weight: 600; color: #a78bfa; }
  .pgs-timer { font-variant-numeric: tabular-nums; opacity: 0.6; font-size: 12px; }
  .pgs-status {
    font-size: 13px; color: var(--text-muted, var(--text-secondary));
    margin: 8px 0; animation: qt-pulse 2s ease-in-out infinite;
  }
  .pgs-phases {
    display: flex; gap: 4px; align-items: center; margin: 12px 0; flex-wrap: wrap;
  }
  .pgs-phase-step {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 12px; font-size: 11px;
    background: var(--bg-tertiary, rgba(255,255,255,0.05));
    color: var(--text-muted, var(--text-secondary));
    transition: all 0.3s;
  }
  .pgs-step-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-muted, var(--text-secondary));
    transition: background 0.3s;
  }
  .pgs-phase-step.pgs-active {
    background: rgba(167, 139, 250, 0.2); color: #a78bfa;
  }
  .pgs-phase-step.pgs-active .pgs-step-dot { background: #a78bfa; }
  .pgs-phase-step.pgs-done {
    background: rgba(74, 222, 128, 0.15); color: #4ade80;
  }
  .pgs-phase-step.pgs-done .pgs-step-dot { background: #4ade80; }
  .pgs-phase-connector {
    width: 16px; height: 1px; background: var(--border-color);
  }

  /* ── Sweep Tracker ── */
  .pgs-sweep-header { font-weight: 600; margin-bottom: 6px; }
  .pgs-sweep-row {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 0; font-size: 12px;
    color: var(--text-muted, var(--text-secondary));
    transition: color 0.2s;
  }
  .pgs-sweep-status { width: 14px; text-align: center; }
  .pgs-sweep-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pgs-sweep-meta { font-size: 11px; opacity: 0.6; }

  /* ── PGS Log ── */
  .pgs-log-section {
    margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 8px;
  }
  .pgs-log {
    max-height: 120px; overflow-y: auto;
    font-size: 11px; font-family: monospace;
    color: var(--text-muted, var(--text-secondary));
  }

  /* ── History ── */
  .qt-history-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .qt-history-toggle {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    cursor: pointer; font-size: 13px;
    color: var(--text-secondary);
    min-height: 44px;
    list-style: none;
  }
  .qt-history-toggle::-webkit-details-marker { display: none; }
  .qt-history-list { padding: 0 12px 12px; }
  .qt-history-item {
    padding: 10px 12px; margin-bottom: 4px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer; transition: border-color 0.15s;
    min-height: 44px;
    display: flex; flex-direction: column; justify-content: center;
  }
  .qt-history-item:hover { border-color: var(--accent-primary); }
  .qt-history-query {
    font-size: 13px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    color: var(--text-primary);
  }
  .qt-history-meta { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

  /* ── Mobile ── */
  @media (max-width: 900px) {
    .qt-container { padding: 12px; gap: 10px; }
    .qt-starter-title { font-size: 15px; }
    .qt-starter-prompt-bar { padding: 10px 12px; }
    .qt-options-grid { grid-template-columns: 1fr; }
    .qt-quick-grid { gap: 4px; }
    .qt-quick-btn { font-size: 11px; padding: 5px 10px; }
    .qt-enhancements, .qt-context-options { gap: 8px; }
    .qt-metadata { flex-direction: column; gap: 4px; }
    .qt-export-actions { flex-wrap: wrap; }
    .pgs-phases { flex-wrap: wrap; }
  }
  `;
}

window.QueryTab = {
  populateModels
};
