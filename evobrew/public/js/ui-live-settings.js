(function () {
  let initialized = false;
  let cachedStatus = null;
  let lastLoadedAt = 0;
  let pendingLoad = null;

  const CACHE_TTL_MS = 15_000;

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
    console.log(`[live-settings:${type}]`, message);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function refreshModelSelectors() {
    try {
      if (typeof window.populateModelSelector === 'function') {
        await window.populateModelSelector({ refresh: true, useCached: false, backgroundRefresh: false });
      }
    } catch (error) {
      console.warn('[live-settings] Failed to refresh main model selector:', error);
    }

    try {
      if (typeof window.QueryTab?.populateModels === 'function') {
        await window.QueryTab.populateModels({ refresh: true, useCached: false, backgroundRefresh: false });
      }
    } catch (error) {
      console.warn('[live-settings] Failed to refresh query-tab model selector:', error);
    }

    try {
      if (typeof window.EvobrewRuntimePrefs?.refreshCatalog === 'function') {
        await window.EvobrewRuntimePrefs.refreshCatalog(true);
      }
    } catch (error) {
      console.warn('[live-settings] Failed to refresh runtime catalog:', error);
    }
  }

  function ensureGroup() {
    const settingsContent = document.querySelector('#settings-panel .settings-content');
    if (!settingsContent) return null;

    let group = document.getElementById('live-settings-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'setting-group live-settings-group';
      group.id = 'live-settings-group';
      group.addEventListener('click', handleGroupClick);
      settingsContent.appendChild(group);
    }

    return group;
  }

  function renderLoading() {
    const group = ensureGroup();
    if (!group) return;

    group.innerHTML = `
      <div class="setting-group-title">Server Setup & Status</div>
      <div class="live-settings-note">Loading live configuration…</div>
    `;
  }

  function renderError(message) {
    const group = ensureGroup();
    if (!group) return;

    group.innerHTML = `
      <div class="setting-group-title">Server Setup & Status</div>
      <div class="live-settings-note live-settings-note-error">${escapeHtml(message || 'Failed to load live configuration.')}</div>
      <div class="live-settings-actions">
        <button class="btn" type="button" data-live-settings-action="refresh-status">Refresh Status</button>
      </div>
    `;
  }

  function renderRows(rows) {
    return rows.map(([label, value]) => `
      <div class="live-settings-row">
        <div class="live-settings-key">${escapeHtml(label)}</div>
        <div class="live-settings-value">${escapeHtml(value)}</div>
      </div>
    `).join('');
  }

  function providerInputSection(options) {
    const {
      title,
      inputId,
      placeholder,
      note,
      statusLine,
      actions,
      inputType = 'password',
      inputValue = ''
    } = options;

    const buttons = actions.map((action) => (
      `<button class="btn" type="button" data-live-settings-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`
    )).join('');

    return `
      <div class="live-settings-provider-card">
        <div class="live-settings-provider-title">${escapeHtml(title)}</div>
        ${statusLine ? `<div class="live-settings-provider-status">${escapeHtml(statusLine)}</div>` : ''}
        <div class="setting-item">
          <label class="setting-label" for="${escapeHtml(inputId)}">${escapeHtml(title)}</label>
          <input
            class="setting-input"
            id="${escapeHtml(inputId)}"
            type="${escapeHtml(inputType)}"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(inputValue)}"
            placeholder="${escapeHtml(placeholder)}">
        </div>
        <div class="live-settings-actions">${buttons}</div>
        ${note ? `<div class="live-settings-note">${note}</div>` : ''}
      </div>
    `;
  }

  function providerButtonSection(options) {
    const { title, note, statusLine, actions } = options;
    const buttons = actions.map((action) => (
      `<button class="btn" type="button" data-live-settings-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`
    )).join('');

    return `
      <div class="live-settings-provider-card">
        <div class="live-settings-provider-title">${escapeHtml(title)}</div>
        ${statusLine ? `<div class="live-settings-provider-status">${escapeHtml(statusLine)}</div>` : ''}
        <div class="live-settings-actions">${buttons}</div>
        ${note ? `<div class="live-settings-note">${note}</div>` : ''}
      </div>
    `;
  }

  function readInputValue(id) {
    return String(document.getElementById(id)?.value || '').trim();
  }

  function readCheckboxValue(id) {
    return document.getElementById(id)?.checked === true;
  }

  function clearInput(id) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }

  function renderStatus(data) {
    const group = ensureGroup();
    if (!group) return;

    const status = data?.status || {};
    const app = data?.app || {};
    const details = data?.details || {};
    const setup = data?.setup || {};

    const appRows = [
      ['Config Source', app.config_source || 'unknown'],
      ['Security Profile', app.security_profile || 'unknown'],
      ['HTTP', app.http_port ? `:${app.http_port}` : 'disabled'],
      ['HTTPS', app.https_enabled ? `:${app.https_port}` : 'Not configured'],
      ['Terminal', app.terminal_enabled ? 'Enabled' : 'Disabled'],
      ['UI Refresh', app.ui_refresh_enabled ? 'Enabled' : 'Disabled'],
      ['Brains', details.brains?.enabled ? (details.brains?.semantic_search ? 'Enabled with semantic search' : 'Enabled, keyword only') : 'Disabled']
    ];

    const providerRows = [
      ['Anthropic', status.anthropic?.status || 'Unknown'],
      ['OpenAI API', status.openaiApi?.status || 'Unknown'],
      ['OpenAI Codex', status.openaiCodex?.status || 'Unknown'],
      ['xAI', status.xai?.status || 'Unknown'],
      ['Ollama Cloud', status.ollamaCloud?.status || 'Unknown'],
      ['Ollama', status.ollama?.status || 'Unknown'],
      ['OpenClaw', status.openclaw?.status || 'Unknown'],
      ['Brains', status.brains?.status || 'Unknown']
    ];

    const cards = [
      providerInputSection({
        title: 'OpenAI API Key',
        inputId: 'live-openai-api-key',
        placeholder: details.openai_api?.has_api_key ? 'Configured — enter a new key to replace it' : 'Paste your OpenAI API key',
        statusLine: status.openaiApi?.status || 'Not configured',
        note: 'Uses the standard OpenAI API models. Saved encrypted and applied immediately.',
        actions: [
          { action: 'test-openai', label: 'Test Key' },
          { action: 'save-openai', label: 'Save & Apply' },
          { action: 'disable-openai', label: 'Disable' }
        ]
      }),
      providerInputSection({
        title: 'Anthropic API Key',
        inputId: 'live-anthropic-api-key',
        placeholder: details.anthropic?.auth_mode === 'api_key' ? 'Configured — enter a new key to replace it' : 'Paste an Anthropic API key to switch to API-key mode',
        statusLine: status.anthropic?.status || 'Not configured',
        note: 'Saving here switches Anthropic to API-key mode. For Claude OAuth, use the setup button below.',
        actions: [
          { action: 'test-anthropic', label: 'Test Key' },
          { action: 'save-anthropic', label: 'Save & Apply' },
          { action: 'disable-anthropic', label: 'Disable' }
        ]
      }),
      providerInputSection({
        title: 'xAI API Key',
        inputId: 'live-xai-api-key',
        placeholder: details.xai?.has_api_key ? 'Configured — enter a new key to replace it' : 'Paste your xAI API key',
        statusLine: status.xai?.status || 'Not configured',
        note: 'Applies to Grok models and refreshes the runtime provider registry immediately.',
        actions: [
          { action: 'test-xai', label: 'Test Key' },
          { action: 'save-xai', label: 'Save & Apply' },
          { action: 'disable-xai', label: 'Disable' }
        ]
      }),
      providerInputSection({
        title: 'Ollama Cloud API Key',
        inputId: 'live-ollama-cloud-api-key',
        placeholder: details.ollama_cloud?.has_api_key ? 'Configured — enter a new key to replace it' : 'Paste your Ollama Cloud API key',
        statusLine: status.ollamaCloud?.status || 'Not configured',
        note: 'Saved encrypted to <code>~/.evobrew/config.json</code> and applied to the provider registry without a full server restart.',
        actions: [
          { action: 'test-ollama-cloud', label: 'Test Key' },
          { action: 'save-ollama-cloud', label: 'Save & Apply' },
          { action: 'disable-ollama-cloud', label: 'Disable' }
        ]
      }),
      `
        <div class="live-settings-provider-card">
          <div class="live-settings-provider-title">Local Ollama</div>
          <div class="live-settings-provider-status">${escapeHtml(status.ollama?.status || 'Not configured')}</div>
          <div class="setting-item">
            <label class="setting-label" for="live-ollama-base-url">Ollama Base URL</label>
            <input class="setting-input" id="live-ollama-base-url" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(details.ollama?.base_url || 'http://localhost:11434')}" placeholder="http://localhost:11434">
          </div>
          <div class="setting-item live-settings-checkbox-row">
            <label>
              <input id="live-ollama-auto-detect" type="checkbox" ${details.ollama?.auto_detect !== false ? 'checked' : ''}>
              Auto-detect on startup
            </label>
          </div>
          <div class="live-settings-actions">
            <button class="btn" type="button" data-live-settings-action="test-ollama">Test Connection</button>
            <button class="btn" type="button" data-live-settings-action="save-ollama">Save & Apply</button>
            <button class="btn" type="button" data-live-settings-action="disable-ollama">Disable</button>
          </div>
          <div class="live-settings-note">Configure the local or remote Ollama endpoint used for local-model discovery.</div>
        </div>
      `,
      providerButtonSection({
        title: 'Anthropic OAuth',
        statusLine: details.anthropic?.auth_mode === 'oauth' ? 'OAuth currently active' : 'Use CLI setup to configure Claude OAuth',
        note: 'OAuth still runs through the setup flow because it requires the full browser/token exchange.',
        actions: [
          { action: 'run-setup-anthropic', label: 'Run Anthropic Setup in Terminal' }
        ]
      }),
      providerButtonSection({
        title: 'OpenAI Codex OAuth',
        statusLine: status.openaiCodex?.status || 'Not configured',
        note: 'ChatGPT OAuth for Codex models still uses the setup flow. Launch it directly from the integrated terminal.',
        actions: [
          { action: 'run-setup-openai', label: 'Run OpenAI Setup in Terminal' }
        ]
      })
    ].join('');

    group.innerHTML = `
      <div class="setting-group-title">Server Setup & Status</div>
      <div class="live-settings-section">
        <div class="live-settings-section-title">App</div>
        <div class="live-settings-grid">${renderRows(appRows)}</div>
      </div>
      <div class="live-settings-section">
        <div class="live-settings-section-title">Providers</div>
        <div class="live-settings-grid">${renderRows(providerRows)}</div>
      </div>
      <div class="live-settings-section">
        <div class="live-settings-section-title">Native Provider Setup</div>
        <div class="live-settings-provider-grid">${cards}</div>
      </div>
      <div class="live-settings-actions">
        <button class="btn" type="button" data-live-settings-action="refresh-status">Refresh Status</button>
        <button class="btn" type="button" data-live-settings-action="run-setup-status">Run CLI Status in Terminal</button>
        <button class="btn" type="button" data-live-settings-action="run-setup">Run Full Setup Wizard in Terminal</button>
      </div>
      <div class="live-settings-note">${escapeHtml(setup.restart_note || 'Running setup may temporarily stop and restart the Evobrew server.')}</div>
      <div class="live-settings-note">Commands: <code>${escapeHtml(setup.status_command || 'evobrew setup --status')}</code> and <code>${escapeHtml(setup.command || 'evobrew setup')}</code></div>
    `;
  }

  async function loadStatus(force = false) {
    const now = Date.now();
    if (!force && cachedStatus && (now - lastLoadedAt) < CACHE_TTL_MS) {
      return cachedStatus;
    }

    if (pendingLoad) {
      return pendingLoad;
    }

    pendingLoad = fetch('/api/setup/status')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data?.success === false) {
          throw new Error(data?.error || `Request failed (${response.status})`);
        }
        cachedStatus = data;
        lastLoadedAt = Date.now();
        return data;
      })
      .finally(() => {
        pendingLoad = null;
      });

    return pendingLoad;
  }

  async function render(force = false) {
    renderLoading();
    try {
      const data = await loadStatus(force);
      renderStatus(data);
    } catch (error) {
      renderError(error.message);
    }
  }

  async function runCommandInTerminal(command, requireConfirmation = false) {
    if (requireConfirmation) {
      const ok = window.confirm('Running setup may temporarily stop and restart Evobrew. Continue and run it in a terminal session?');
      if (!ok) return;
    }

    if (!window.evobrewTerminal?.runCommand) {
      showToast('Terminal integration is not available.', 'error');
      return;
    }

    try {
      await window.evobrewTerminal.runCommand(command, {
        newSession: true,
        focus: true,
        submit: true
      });
      showToast(`Started ${command} in terminal.`, 'success');
    } catch (error) {
      showToast(`Failed to start terminal command: ${error.message}`, 'error');
    }
  }

  async function applyApiKeyProvider(providerId, inputId, label) {
    const apiKey = readInputValue(inputId);
    if (!apiKey) {
      showToast(`Enter a ${label} first.`, 'error');
      return;
    }

    const testPath = `/api/setup/providers/${providerId}/test`;
    const savePath = `/api/setup/providers/${providerId}`;

    const testResult = await requestJson(testPath, {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });

    const saveResult = await requestJson(savePath, {
      method: 'PUT',
      body: JSON.stringify({ apiKey })
    });

    clearInput(inputId);
    await refreshModelSelectors();
    await render(true);

    const modelCountText = Number.isFinite(saveResult.modelCount) || Number.isFinite(testResult.modelCount)
      ? ` ${saveResult.modelCount || testResult.modelCount || 0} models detected.`
      : '';
    showToast(`${label} saved and applied.${modelCountText}`, 'success');
  }

  async function testApiKeyProvider(providerId, inputId, label) {
    const apiKey = readInputValue(inputId);
    if (!apiKey) {
      showToast(`Enter a ${label} first.`, 'error');
      return;
    }

    const result = await requestJson(`/api/setup/providers/${providerId}/test`, {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });

    const suffix = Number.isFinite(result.modelCount) ? ` ${result.modelCount} models detected.` : '';
    showToast(`${label} is valid.${suffix}`, 'success');
  }

  async function disableProvider(providerId, label) {
    const ok = window.confirm(`Disable ${label}? This updates Evobrew config and hot-applies the change.`);
    if (!ok) return;

    await requestJson(`/api/setup/providers/${providerId}`, {
      method: 'DELETE'
    });

    await refreshModelSelectors();
    await render(true);
    showToast(`${label} disabled.`, 'success');
  }

  async function testOllama() {
    const baseUrl = readInputValue('live-ollama-base-url') || 'http://localhost:11434';
    const result = await requestJson('/api/setup/providers/ollama/test', {
      method: 'POST',
      body: JSON.stringify({ baseUrl })
    });
    showToast(`Ollama is reachable. ${result.modelCount || 0} models detected.`, 'success');
  }

  async function saveOllama() {
    const baseUrl = readInputValue('live-ollama-base-url') || 'http://localhost:11434';
    const autoDetect = readCheckboxValue('live-ollama-auto-detect');
    const result = await requestJson('/api/setup/providers/ollama', {
      method: 'PUT',
      body: JSON.stringify({ baseUrl, autoDetect })
    });
    await refreshModelSelectors();
    await render(true);
    showToast(`Ollama saved and applied. ${result.modelCount || 0} models detected.`, 'success');
  }

  async function handleAction(action) {
    switch (action) {
      case 'refresh-status':
        await render(true);
        return;
      case 'run-setup-status':
        await runCommandInTerminal('evobrew setup --status');
        return;
      case 'run-setup':
        await runCommandInTerminal('evobrew setup', true);
        return;
      case 'run-setup-anthropic':
        await runCommandInTerminal('evobrew setup --only anthropic', true);
        return;
      case 'run-setup-openai':
        await runCommandInTerminal('evobrew setup --only openai', true);
        return;
      case 'test-openai':
        await testApiKeyProvider('openai', 'live-openai-api-key', 'OpenAI API key');
        return;
      case 'save-openai':
        await applyApiKeyProvider('openai', 'live-openai-api-key', 'OpenAI API key');
        return;
      case 'disable-openai':
        await disableProvider('openai', 'OpenAI');
        return;
      case 'test-anthropic':
        await testApiKeyProvider('anthropic', 'live-anthropic-api-key', 'Anthropic API key');
        return;
      case 'save-anthropic':
        await applyApiKeyProvider('anthropic', 'live-anthropic-api-key', 'Anthropic API key');
        return;
      case 'disable-anthropic':
        await disableProvider('anthropic', 'Anthropic');
        return;
      case 'test-xai':
        await testApiKeyProvider('xai', 'live-xai-api-key', 'xAI API key');
        return;
      case 'save-xai':
        await applyApiKeyProvider('xai', 'live-xai-api-key', 'xAI API key');
        return;
      case 'disable-xai':
        await disableProvider('xai', 'xAI');
        return;
      case 'test-ollama-cloud':
        await testApiKeyProvider('ollama-cloud', 'live-ollama-cloud-api-key', 'Ollama Cloud API key');
        return;
      case 'save-ollama-cloud':
        await applyApiKeyProvider('ollama-cloud', 'live-ollama-cloud-api-key', 'Ollama Cloud API key');
        return;
      case 'disable-ollama-cloud':
        await disableProvider('ollama-cloud', 'Ollama Cloud');
        return;
      case 'test-ollama':
        await testOllama();
        return;
      case 'save-ollama':
        await saveOllama();
        return;
      case 'disable-ollama':
        await disableProvider('ollama', 'Ollama');
        return;
      default:
        break;
    }
  }

  function handleGroupClick(event) {
    const button = event.target.closest('[data-live-settings-action]');
    if (!button) return;

    handleAction(button.dataset.liveSettingsAction).catch((error) => {
      showToast(error.message || 'Provider update failed.', 'error');
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('evobrew:settings-opened', () => {
      render(true);
    });
  }

  window.UIRefreshLiveSettings = {
    init,
    refresh: () => render(true)
  };
})();
