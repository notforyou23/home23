/**
 * Home23 Settings — Client JS
 */

const API = '/home23/api/settings';
let modelsData = null;
let skillsSettingsData = null;
let tilesState = null;
let tileConnectionsState = null;
let editingCustomTileId = null;
let editingTileConnectionId = null;
let layoutDragTileId = null;
let settingsAgents = [];
let settingsPrimaryAgent = null;
let settingsCurrentAgent = null;
let selectedSettingsAgent = null;
let activeSettingsTab = 'providers';
const tilesBroadcast = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('home23-dashboard-tiles')
  : null;

const DEFAULT_SETTINGS_SCOPE_REGISTRY = {
  providers: {
    kind: 'global',
    chip: 'Global',
    agentTarget: 'none',
    summaryTemplate: 'Providers is house-wide. Changes here affect every Home23 agent, harness, and shared model surface.',
  },
  agents: {
    kind: 'roster',
    chip: 'Roster',
    agentTarget: 'roster',
    summaryTemplate: 'Agents manages the multi-agent roster. Create agents, choose the home primary, and control each runtime independently.',
  },
  models: {
    kind: 'mixed',
    chip: 'Mixed',
    agentTarget: 'selected',
    summaryTemplate: 'Models is mixed-scope. {{selectedAgent}} gets chat defaults, pulse voice, and cognitive routing. Provider catalogs and aliases stay house-wide.',
  },
  query: {
    kind: 'agent',
    chip: 'Agent',
    agentTarget: 'selected',
    summaryTemplate: 'Query defaults are saved on {{selectedAgent}}. They seed that agent\'s Query tab only.',
  },
  feeder: {
    kind: 'agent',
    chip: 'Agent',
    agentTarget: 'selected',
    summaryTemplate: 'Document Feeder belongs to {{selectedAgent}}. Watch paths, live status, uploads, and restarts target that agent\'s ingestion pipeline.',
  },
  skills: {
    kind: 'global',
    chip: 'Global',
    agentTarget: 'none',
    summaryTemplate: 'Skills is house-wide. Skill configuration and credentials are shared across the Home23 system.',
  },
  vibe: {
    kind: 'global',
    chip: 'Global',
    agentTarget: 'none',
    summaryTemplate: 'Vibe is house-wide. Changes here affect the visual generation layer for the whole Home23 install.',
  },
  tiles: {
    kind: 'global',
    chip: 'Global',
    agentTarget: 'none',
    summaryTemplate: 'Tiles is house-wide. Home tile definitions and layout rules are shared across dashboards.',
  },
  agency: {
    kind: 'mixed',
    chip: 'Mixed',
    agentTarget: 'selected',
    summaryTemplate: 'Agency is mixed-scope. The allow-list is house-wide, while the audit trails below show what {{selectedAgent}} actually attempted.',
  },
  system: {
    kind: 'global',
    chip: 'Global',
    agentTarget: 'none',
    summaryTemplate: 'System is house-wide. Ports, shared services, and install/build actions affect the Home23 host itself.',
  },
};
let settingsScopeRegistry = { ...DEFAULT_SETTINGS_SCOPE_REGISTRY };

function settingsApiUrl(path = '', options = {}) {
  const { agentScoped = false, params = {} } = options;
  const url = new URL(`${API}${path}`, window.location.origin);
  if (agentScoped && selectedSettingsAgent) {
    url.searchParams.set('agent', selectedSettingsAgent);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}`;
}

function getSelectedAgentMeta() {
  return settingsAgents.find(agent => agent.name === selectedSettingsAgent) || null;
}

function selectedAgentLabel(fallback = 'selected agent') {
  const meta = getSelectedAgentMeta();
  return meta?.displayName || meta?.name || fallback;
}

function getScopeMeta(tabKey = activeSettingsTab) {
  return settingsScopeRegistry[tabKey] || DEFAULT_SETTINGS_SCOPE_REGISTRY[tabKey] || DEFAULT_SETTINGS_SCOPE_REGISTRY.providers;
}

function resolveScopeSummary(meta) {
  const currentMeta = settingsAgents.find(agent => agent.name === settingsCurrentAgent) || null;
  const primaryMeta = settingsAgents.find(agent => agent.name === settingsPrimaryAgent) || null;
  const replacements = {
    selectedAgent: selectedAgentLabel('the selected agent'),
    dashboardAgent: currentMeta?.displayName || currentMeta?.name || 'this dashboard agent',
    primaryAgent: primaryMeta?.displayName || primaryMeta?.name || 'the Home23 primary agent',
  };
  return String(meta?.summaryTemplate || '').replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] || '');
}

async function loadScopeRegistry() {
  try {
    const res = await fetch(settingsApiUrl('/scope', {
      agentScoped: !!selectedSettingsAgent,
    }));
    if (!res.ok) return;
    const data = await res.json();
    if (data?.tabs && typeof data.tabs === 'object') {
      settingsScopeRegistry = { ...DEFAULT_SETTINGS_SCOPE_REGISTRY, ...data.tabs };
    }
  } catch {
    settingsScopeRegistry = { ...DEFAULT_SETTINGS_SCOPE_REGISTRY };
  }
}

function renderSettingsScopeChrome() {
  document.querySelectorAll('.h23s-tab').forEach(tab => {
    const tabKey = tab.dataset.stab;
    const label = tab.dataset.tabLabel || tab.textContent.trim();
    const meta = getScopeMeta(tabKey);
    tab.innerHTML = `<span class="h23s-tab-label">${label}</span><span class="h23s-scope-chip scope-${meta.kind}">${meta.chip}</span>`;
  });

  document.querySelectorAll('.h23s-panel').forEach(panel => {
    const tabKey = panel.id.replace('panel-', '');
    const meta = getScopeMeta(tabKey);
    const title = panel.querySelector('.h23s-panel-title');
    if (!title) return;
    if (!title.dataset.baseTitle) title.dataset.baseTitle = title.textContent.trim();

    let row = title.parentElement;
    if (!row || !row.classList.contains('h23s-panel-title-row')) {
      row = document.createElement('div');
      row.className = 'h23s-panel-title-row';
      title.parentNode.insertBefore(row, title);
      row.appendChild(title);
    }

    let badge = row.querySelector('.h23s-scope-chip');
    if (!badge) {
      badge = document.createElement('span');
      row.appendChild(badge);
    }
    badge.className = `h23s-scope-chip scope-${meta.kind}`;
    badge.textContent = meta.chip;
    title.textContent = title.dataset.baseTitle;
  });
}

function refreshSettingsDocumentTitle() {
  const scopeMeta = getScopeMeta();
  const selected = selectedAgentLabel('No Agent');
  document.title = `Home23 Settings — ${scopeMeta.chip} — ${selected}`;
}

function refreshAgentScopeUI() {
  const select = document.getElementById('settings-agent-select');
  const selectField = document.getElementById('settings-agent-select-field');
  const kicker = document.getElementById('settings-scope-kicker');
  const summary = document.getElementById('settings-scope-summary');
  const scopeMeta = getScopeMeta();
  if (selectField) {
    selectField.style.display = scopeMeta.agentTarget === 'selected' ? '' : 'none';
  }
  if (select) {
    select.innerHTML = settingsAgents.map(agent => {
      const badges = [
        agent.name === settingsCurrentAgent ? 'this dashboard' : '',
        agent.isPrimary ? 'primary' : '',
      ].filter(Boolean).join(' · ');
      const label = badges ? `${agent.displayName || agent.name} — ${badges}` : (agent.displayName || agent.name);
      return `<option value="${agent.name}" ${agent.name === selectedSettingsAgent ? 'selected' : ''}>${label}</option>`;
    }).join('');
    select.disabled = settingsAgents.length === 0;
  }
  if (kicker) {
    const scopeLabel = scopeMeta.kind === 'agent'
      ? 'Selected Agent Scope'
      : scopeMeta.kind === 'mixed'
        ? 'Mixed Scope'
        : scopeMeta.kind === 'roster'
          ? 'Multi-Agent Scope'
          : 'House-Wide Scope';
    kicker.textContent = `${scopeLabel} · ${scopeMeta.chip}`;
  }
  if (summary) {
    summary.textContent = settingsAgents.length
      ? resolveScopeSummary(scopeMeta)
      : 'No agents found yet. Create one to unlock agent-scoped settings.';
  }
  document.querySelectorAll('[data-scope-label="models"], [data-scope-label="query"], [data-scope-label="agency"]').forEach(el => {
    el.textContent = selectedAgentLabel('selected agent');
  });
  renderSettingsScopeChrome();
  refreshSettingsDocumentTitle();
}

async function refreshAgentScopedPanels() {
  if (!selectedSettingsAgent && settingsAgents.length > 0) return;
  await loadModels();
  loadAssignments();
  loadPulseVoice();
  loadQuerySettings();
  loadFeeder();
  loadAgencyRecent();
  loadAgencyRequested();
}

async function setSelectedSettingsAgent(name, options = {}) {
  const { reload = true } = options;
  selectedSettingsAgent = name || null;
  refreshAgentScopeUI();
  if (reload) {
    await refreshAgentScopedPanels();
  }
}

// ── Sub-tab switching ──

function setupSubTabs() {
  document.querySelectorAll('.h23s-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.h23s-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.h23s-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      activeSettingsTab = tab.dataset.stab || 'providers';
      const panel = document.getElementById(`panel-${tab.dataset.stab}`);
      if (panel) panel.classList.add('active');
      refreshAgentScopeUI();
    });
  });
}

// ── Providers ──

const PROVIDER_DISPLAY = {
  'ollama-cloud': 'Ollama Cloud',
  'minimax': 'MiniMax',
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'xai': 'xAI',
};
const PROVIDERS_WITH_API_KEYS = ['ollama-cloud', 'minimax', 'anthropic', 'openai', 'xai'];
const SETTINGS_PROVIDER_ORDER = ['ollama-cloud', 'minimax', 'anthropic', 'openai', 'xai'];
const MODEL_PROVIDER_ORDER = ['ollama-cloud', 'minimax', 'anthropic', 'openai', 'openai-codex', 'xai'];

async function loadProviders() {
  try {
    const res = await fetch(`${API}/providers`);
    const data = await res.json();
    renderProviders(data.providers);
  } catch (err) {
    console.error('Failed to load providers:', err);
  }
}

function renderProviders(providers) {
  const list = document.getElementById('provider-list');
  const order = SETTINGS_PROVIDER_ORDER;
  // Count models per provider from modelsData
  const modelCounts = {};
  if (modelsData?.providers) {
    for (const [name, cfg] of Object.entries(modelsData.providers)) {
      modelCounts[name] = cfg.defaultModels?.length || 0;
    }
  }
  list.innerHTML = order.map(name => {
    const p = providers[name] || {};
    const mc = modelCounts[name] || 0;
    const statusClass = p.hasKey ? 'ok' : 'fail';
    const statusText = p.hasKey ? 'Active' : 'Not configured';
    const modelsText = mc > 0 ? `${mc} model${mc > 1 ? 's' : ''} available` : '';
    return `
      <div class="h23s-provider-card" data-provider="${name}">
        <div class="h23s-provider-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="h23s-provider-name">${PROVIDER_DISPLAY[name] || name}</span>
            ${modelsText ? `<span style="font-size:11px;color:var(--text-muted);">${modelsText}</span>` : ''}
          </div>
          <div class="h23s-provider-status" id="prov-status-${name}">
            <span class="h23s-status-dot ${statusClass}"></span>
            <span>${statusText}</span>
          </div>
        </div>
        ${p.hasKey ? `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
            <span style="font-size:12px;color:var(--text-muted);">Current key:</span>
            <code style="font-size:12px;color:var(--text-secondary);background:rgba(255,255,255,0.04);padding:3px 8px;border-radius:4px;">${p.maskedKey}</code>
            <button class="h23s-btn-secondary" onclick="testProvider('${name}')" style="padding:4px 10px;font-size:11px;">Test Connection</button>
          </div>
        ` : ''}
        <div class="h23s-provider-key-row">
          <input type="password" id="prov-key-${name}" placeholder="${p.hasKey ? 'Paste new key to replace...' : 'Paste API key to configure...'}">
          <button class="h23s-btn-icon" onclick="toggleKeyVisibility('${name}')" title="Show/hide">&#128065;</button>
          ${!p.hasKey ? `<button class="h23s-btn-secondary" onclick="testProvider('${name}')" style="padding:6px 12px;font-size:12px;">Test</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function toggleKeyVisibility(name) {
  const input = document.getElementById(`prov-key-${name}`);
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function testProvider(name) {
  const statusEl = document.getElementById(`prov-status-${name}`);
  const keyInput = document.getElementById(`prov-key-${name}`);
  statusEl.innerHTML = '<span class="h23s-status-dot"></span> <span>Testing...</span>';
  try {
    const res = await fetch(`${API}/providers/${name}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: keyInput?.value?.trim?.() || '' }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.innerHTML = '<span class="h23s-status-dot ok"></span> <span>Connected</span>';
    } else {
      statusEl.innerHTML = `<span class="h23s-status-dot fail"></span> <span>Failed: ${data.error || data.status}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="h23s-status-dot fail"></span> <span>Error: ${err.message}</span>`;
  }
}

async function saveProviders() {
  const providers = {};
  for (const name of PROVIDERS_WITH_API_KEYS) {
    const input = document.getElementById(`prov-key-${name}`);
    if (input && input.value.trim()) {
      providers[name] = { apiKey: input.value.trim() };
    }
  }

  const statusEl = document.getElementById('providers-status');
  try {
    const res = await fetch(`${API}/providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = 'Saved';
      statusEl.style.color = 'var(--accent-green)';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
      loadProviders();
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ── Agents ──

async function loadAgents() {
  try {
    const res = await fetch(`${API}/agents`);
    const data = await res.json();
    settingsAgents = data.agents || [];
    settingsPrimaryAgent = data.primaryAgent || null;
    settingsCurrentAgent = data.currentAgent || null;
    const nextSelected = selectedSettingsAgent && settingsAgents.some(agent => agent.name === selectedSettingsAgent)
      ? selectedSettingsAgent
      : settingsCurrentAgent
        || settingsPrimaryAgent
        || settingsAgents[0]?.name
        || null;
    selectedSettingsAgent = nextSelected;
    refreshAgentScopeUI();
    renderAgents(data.agents);
  } catch (err) {
    console.error('Failed to load agents:', err);
  }
}

function renderAgents(agents) {
  const list = document.getElementById('agent-list');
  if (agents.length === 0) {
    list.innerHTML = '<p class="h23s-panel-desc" style="margin:0;">No agents yet. Create one to get started.</p>';
    return;
  }

  list.innerHTML = agents.map(a => {
    const provLabel = PROVIDER_DISPLAY[a.provider] || a.provider || '?';
    const dashUrl = `http://${window.location.hostname}:${a.ports.dashboard || '?'}`;
    return `
    <div class="h23s-agent-card ${a.isPrimary ? 'is-primary' : ''}" data-agent="${a.name}">
      <div class="h23s-agent-summary">
        <div class="h23s-agent-info">
          <span class="h23s-agent-name">${a.displayName || a.name}</span>
          ${a.isPrimary ? '<span class="h23s-agent-badge" style="background:rgba(88,166,255,0.12);color:var(--accent-blue);">PRIMARY</span>' : ''}
          <span class="h23s-agent-badge ${a.status}">${a.status}</span>
        </div>
        <div class="h23s-agent-actions">
          ${a.status === 'running' ? `<a class="h23s-agent-open" href="${dashUrl}/home23" target="_blank" onclick="event.stopPropagation();">Open Dashboard</a>` : ''}
          ${a.status === 'running'
            ? `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); stopAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Stop</button>`
            : `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); startAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Start</button>`
          }
          <button class="h23s-btn-secondary h23s-agent-edit-btn" onclick="event.stopPropagation(); toggleAgentDetail('${a.name}')" id="edit-toggle-${a.name}" type="button">Edit Settings</button>
        </div>
      </div>
      <div class="h23s-agent-meta-grid">
        <span><b>Model</b><strong>${a.model || '?'}</strong></span>
        <span><b>Provider</b><strong>${provLabel}</strong></span>
        <span><b>Owner</b><strong>${a.owner || 'not set'}</strong></span>
        <span><b>Ports</b><strong>${a.ports.engine || '?'} / ${a.ports.dashboard || '?'}</strong></span>
        <span><b>Channels</b><strong>${[a.channels?.telegram?.enabled && 'Telegram', a.channels?.discord?.enabled && 'Discord'].filter(Boolean).join(', ') || 'Direct only'}</strong></span>
      </div>
      <div class="h23s-agent-detail" id="detail-${a.name}">
        <div class="h23s-agent-detail-header">
          <div>
            <h3 class="h23s-section-title">Agent Settings</h3>
            <p class="h23s-panel-desc">Identity, chat default, and channel wiring for this agent. Save writes config; restart applies runtime changes.</p>
          </div>
          <button class="h23s-btn-secondary" onclick="toggleAgentDetail('${a.name}')" type="button">Close</button>
        </div>
        <div class="h23s-field-row">
          <div class="h23s-field">
            <label>Display Name</label>
            <input type="text" id="edit-${a.name}-displayName" value="${a.displayName || ''}">
          </div>
          <div class="h23s-field">
            <label>Owner</label>
            <input type="text" id="edit-${a.name}-owner" value="${a.owner || ''}">
          </div>
        </div>
        <div class="h23s-field-row">
          <div class="h23s-field">
            <label>Default Model</label>
            <input type="text" id="edit-${a.name}-model" value="${a.model || ''}">
          </div>
          <div class="h23s-field">
            <label>Default Provider</label>
            <input type="text" id="edit-${a.name}-provider" value="${a.provider || ''}">
          </div>
        </div>
        <div class="h23s-field-row">
          <div class="h23s-field">
            <label>Timezone</label>
            <input type="text" id="edit-${a.name}-timezone" value="${a.timezone || ''}">
          </div>
          <div class="h23s-field">
            <label>Owner Telegram ID</label>
            <input type="text" id="edit-${a.name}-telegramId" value="${a.telegramId || ''}" placeholder="Numeric user ID (optional)">
          </div>
        </div>
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--glass-border);">
          <h4 style="font-size:12px;color:var(--accent-blue);text-transform:uppercase;letter-spacing:1px;margin:0 0 14px 0;font-weight:600;">Channels</h4>
          <div style="background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:8px;padding:14px 16px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:#fff;margin:0;">
                <input type="checkbox" id="edit-${a.name}-telegram-enabled" ${a.channels?.telegram?.enabled ? 'checked' : ''}
                  style="width:16px;height:16px;accent-color:var(--accent-blue);cursor:pointer;">
                Telegram
              </label>
              <span style="font-size:11px;color:${a.channels?.telegram?.enabled ? 'var(--accent-green)' : 'var(--text-muted)'};">${a.channels?.telegram?.enabled ? 'Connected' : 'Not configured'}</span>
            </div>
            <div class="h23s-field" style="margin-bottom:0;">
              <input type="password" id="edit-${a.name}-telegram-token" placeholder="${a.channels?.telegram?.enabled ? 'Token configured — paste new to replace' : 'Paste bot token from @BotFather'}"
                style="font-size:12px;">
            </div>
          </div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:8px;padding:14px 16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:#fff;margin:0;">
                <input type="checkbox" id="edit-${a.name}-discord-enabled" ${a.channels?.discord?.enabled ? 'checked' : ''}
                  style="width:16px;height:16px;accent-color:var(--accent-blue);cursor:pointer;">
                Discord
              </label>
              <span style="font-size:11px;color:${a.channels?.discord?.enabled ? 'var(--accent-green)' : 'var(--text-muted)'};">${a.channels?.discord?.enabled ? 'Connected' : 'Not configured'}</span>
            </div>
            <div class="h23s-field" style="margin-bottom:10px;">
              <input type="password" id="edit-${a.name}-discord-token" placeholder="${a.channels?.discord?.hasToken ? 'Token configured — paste new to replace' : 'Paste bot token from Discord Developer Portal'}"
                style="font-size:12px;">
            </div>
            <div class="h23s-field" style="margin-bottom:0;">
              <label style="font-size:11px;color:var(--text-muted);">Guild allowlist <span style="opacity:0.7;">— one per line: <code style="background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;">guild_id</code> (all users) or <code style="background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;">guild_id user1,user2</code> (restrict). Empty = DMs only.</span></label>
              <textarea id="edit-${a.name}-discord-guilds" rows="3" placeholder="123456789012345678&#10;987654321098765432 11111,22222"
                style="font-size:12px;font-family:var(--font-mono);width:100%;resize:vertical;">${formatGuildsForTextarea(a.channels?.discord?.guilds)}</textarea>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="h23s-btn-primary" onclick="saveAgent('${a.name}')" style="font-size:13px;padding:7px 16px;">Save</button>
          ${a.isPrimary ? '' : `<button class="h23s-btn-secondary" onclick="makePrimary('${a.name}')" style="font-size:13px;padding:7px 16px;">Make Primary</button>`}
          ${a.isPrimary ? '' : `<button class="h23s-btn-danger" onclick="deleteAgent('${a.name}')">Delete Agent</button>`}
          <span class="h23s-save-status" id="agent-status-${a.name}"></span>
        </div>
      </div>
    </div>
  `;}).join('');
}

function toggleAgentDetail(name) {
  const detail = document.getElementById(`detail-${name}`);
  const toggle = document.getElementById(`edit-toggle-${name}`);
  if (detail) {
    detail.classList.toggle('open');
    if (toggle) toggle.textContent = detail.classList.contains('open') ? 'Hide Settings' : 'Edit Settings';
  }
}

function setAgentButtonPending(name, label) {
  const btn = document.querySelector(`button[onclick*="stopAgent('${name}')"], button[onclick*="startAgent('${name}')"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = label;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'wait';
  }
}

async function startAgent(name) {
  setAgentButtonPending(name, 'Starting…');
  try {
    await fetch(`${API}/agents/${name}/start`, { method: 'POST' });
    loadAgents();
  } catch (err) {
    alert('Failed to start: ' + err.message);
    loadAgents();
  }
}

async function stopAgent(name) {
  setAgentButtonPending(name, 'Stopping…');
  try {
    await fetch(`${API}/agents/${name}/stop`, { method: 'POST' });
    loadAgents();
  } catch (err) {
    // Stopping the agent whose dashboard is serving this request kills the
    // connection before the response arrives — that's expected, not a failure.
    loadAgents();
  }
}

function formatGuildsForTextarea(guilds) {
  if (!guilds || typeof guilds !== 'object') return '';
  return Object.entries(guilds).map(([id, cfg]) => {
    const users = Array.isArray(cfg?.users) && cfg.users.length ? ' ' + cfg.users.join(',') : '';
    return `${id}${users}`;
  }).join('\n');
}

function parseGuildsTextarea(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [id, usersStr] = line.split(/\s+/, 2);
    if (!/^\d+$/.test(id)) continue;
    const users = usersStr ? usersStr.split(',').map(u => u.trim()).filter(Boolean) : undefined;
    out[id] = users && users.length ? { requireMention: false, users } : { requireMention: false };
  }
  return out;
}

async function saveAgent(name) {
  const telegramEnabled = document.getElementById(`edit-${name}-telegram-enabled`)?.checked;
  const telegramToken = document.getElementById(`edit-${name}-telegram-token`)?.value?.trim();
  const discordEnabled = document.getElementById(`edit-${name}-discord-enabled`)?.checked;
  const discordToken = document.getElementById(`edit-${name}-discord-token`)?.value?.trim();
  const discordGuildsText = document.getElementById(`edit-${name}-discord-guilds`)?.value ?? '';
  const discordGuilds = parseGuildsTextarea(discordGuildsText);

  const body = {
    displayName: document.getElementById(`edit-${name}-displayName`)?.value,
    ownerName: document.getElementById(`edit-${name}-owner`)?.value,
    model: document.getElementById(`edit-${name}-model`)?.value,
    provider: document.getElementById(`edit-${name}-provider`)?.value,
    timezone: document.getElementById(`edit-${name}-timezone`)?.value,
    ownerTelegramId: document.getElementById(`edit-${name}-telegramId`)?.value,
    telegram: {
      enabled: telegramEnabled,
      ...(telegramToken ? { botToken: telegramToken } : {}),
    },
    discord: {
      enabled: discordEnabled,
      guilds: discordGuilds,
      ...(discordToken ? { token: discordToken } : {}),
    },
  };
  const statusEl = document.getElementById(`agent-status-${name}`);
  try {
    const res = await fetch(`${API}/agents/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.innerHTML = `Saved &mdash; <button onclick="restartAgent('${name}')" style="background:var(--accent-blue);color:#fff;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;">Restart to apply</button>`;
      statusEl.style.color = 'var(--accent-green)';
    } else {
      statusEl.textContent = 'Error: ' + data.error;
      statusEl.style.color = 'var(--accent-red)';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

async function makePrimary(name) {
  if (!confirm(`Make ${name} the primary Home23 agent? Query, models, and shared links will follow it.`)) return;
  try {
    const res = await fetch(`${API}/agents/${name}/primary`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadAgents();
    if (!selectedSettingsAgent) {
      await setSelectedSettingsAgent(name);
    } else {
      refreshAgentScopeUI();
    }
  } catch (err) {
    alert('Failed to set home primary agent: ' + err.message);
  }
}

async function restartAgent(name) {
  const statusEl = document.getElementById(`agent-status-${name}`);
  try {
    const res = await fetch(`${API}/agents/${name}/restart-harness`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (statusEl) {
      statusEl.textContent = 'Harness restarted';
      statusEl.style.color = 'var(--accent-green)';
      setTimeout(() => { statusEl.textContent = ''; loadAgents(); }, 2000);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Restart failed: ' + err.message;
      statusEl.style.color = 'var(--accent-red)';
    } else {
      alert('Restart failed: ' + err.message);
    }
  }
}

async function deleteAgent(name) {
  if (!confirm(`Delete agent "${name}"? This removes the instance directory and all data.`)) return;
  try {
    await fetch(`${API}/agents/${name}`, { method: 'DELETE' });
    await loadAgents();
    await refreshAgentScopedPanels();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

// ── Wizard ──

let wizardStep = 1;

let isCreatingPrimary = false;

async function showWizard() {
  const wizard = document.getElementById('agent-wizard');
  const createButton = document.getElementById('btn-create-agent');
  wizard.style.display = 'block';
  wizard.classList.add('open');
  createButton.disabled = true;
  createButton.textContent = 'Creating Agent';
  wizardStep = 1;
  updateWizardStep();
  document.getElementById('wiz-timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

  // Check if this will be the primary agent
  try {
    const res = await fetch(`${API}/status`);
    const data = await res.json();
    isCreatingPrimary = !data.primaryAgent;
  } catch { isCreatingPrimary = false; }

  const banner = document.getElementById('wiz-primary-banner');
  if (banner) banner.style.display = isCreatingPrimary ? 'block' : 'none';
  wizard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideWizard() {
  const wizard = document.getElementById('agent-wizard');
  const createButton = document.getElementById('btn-create-agent');
  wizard.style.display = 'none';
  wizard.classList.remove('open');
  createButton.disabled = false;
  createButton.textContent = '+ Create Agent';
  for (const id of ['wiz-name', 'wiz-display-name', 'wiz-owner', 'wiz-timezone', 'wiz-bot-token', 'wiz-telegram-id']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  document.getElementById('wiz-display-name').removeAttribute('data-manual');
}

function updateWizardStep() {
  document.querySelectorAll('.h23s-wizard-step').forEach(s => {
    const step = parseInt(s.dataset.step);
    s.classList.remove('active', 'done');
    if (step === wizardStep) s.classList.add('active');
    if (step < wizardStep) s.classList.add('done');
  });
  document.querySelectorAll('.h23s-wizard-page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`wizard-step-${wizardStep}`);
  if (page) page.classList.add('active');
}

function setupWizard() {
  document.getElementById('wiz-cancel').addEventListener('click', hideWizard);
  document.getElementById('wiz-close')?.addEventListener('click', hideWizard);

  document.getElementById('wiz-next-1').addEventListener('click', () => {
    const name = document.getElementById('wiz-name').value.trim();
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      alert('Agent name must be lowercase alphanumeric with hyphens');
      return;
    }
    wizardStep = 2;
    updateWizardStep();
  });

  document.getElementById('wiz-back-2').addEventListener('click', () => { wizardStep = 1; updateWizardStep(); });
  document.getElementById('wiz-next-2').addEventListener('click', () => {
    wizardStep = 3;
    updateWizardStep();
    populateWizardModels();
  });

  document.getElementById('wiz-back-3').addEventListener('click', () => { wizardStep = 2; updateWizardStep(); });
  document.getElementById('wiz-create').addEventListener('click', createAgent);

  document.getElementById('wiz-name').addEventListener('input', (e) => {
    const dn = document.getElementById('wiz-display-name');
    if (!dn.dataset.manual) {
      dn.value = e.target.value ? e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1).replace(/-/g, ' ') : '';
    }
  });
  document.getElementById('wiz-display-name').addEventListener('input', function() { this.dataset.manual = 'true'; });

  document.getElementById('wiz-provider').addEventListener('change', populateWizardModels);
}

function populateWizardModels() {
  const provider = document.getElementById('wiz-provider').value;
  const select = document.getElementById('wiz-model');
  select.innerHTML = '';

  if (modelsData?.providers?.[provider]?.defaultModels) {
    for (const model of modelsData.providers[provider].defaultModels) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      select.appendChild(opt);
    }
  } else {
    const fallback = {
      'ollama-cloud': ['kimi-k2.6', 'minimax-m2.7'],
      'minimax': ['MiniMax-M2.7'],
      'anthropic': ['claude-sonnet-4-6', 'claude-opus-4-7'],
      'openai': ['gpt-5.4'],
      'openai-codex': ['gpt-5.5'],
      'xai': ['grok-4-0709'],
    };
    for (const m of (fallback[provider] || ['default'])) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    }
  }
}

async function createAgent() {
  const body = {
    name: document.getElementById('wiz-name').value.trim(),
    displayName: document.getElementById('wiz-display-name').value.trim(),
    ownerName: document.getElementById('wiz-owner').value.trim(),
    timezone: document.getElementById('wiz-timezone').value.trim(),
    botToken: document.getElementById('wiz-bot-token').value.trim(),
    ownerTelegramId: document.getElementById('wiz-telegram-id').value.trim(),
    provider: document.getElementById('wiz-provider').value,
    model: document.getElementById('wiz-model').value,
  };

  const btn = document.getElementById('wiz-create');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      hideWizard();
      await loadAgents();
      if (data.agent?.name) {
        await setSelectedSettingsAgent(data.agent.name);
      }
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Failed to create agent: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = 'Create Agent';
}

// ── Models ──

async function loadModels() {
  try {
    const res = await fetch(settingsApiUrl('/models', { agentScoped: true }));
    modelsData = await res.json();
    renderModels(modelsData);
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

function renderModels(data) {
  const provSelect = document.getElementById('models-default-provider');
  const modelSelect = document.getElementById('models-default-model');
  provSelect.innerHTML = '';
  for (const name of Object.keys(data.providers || {})) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = PROVIDER_DISPLAY[name] || name;
    if (name === data.chat?.defaultProvider) opt.selected = true;
    provSelect.appendChild(opt);
  }

  function fillModelSelect() {
    const prov = provSelect.value;
    modelSelect.innerHTML = '';
    const models = data.providers?.[prov]?.defaultModels || [];
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === data.chat?.defaultModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  }
  if (!provSelect.dataset.bound) {
    provSelect.addEventListener('change', fillModelSelect);
    provSelect.dataset.bound = 'true';
  }
  fillModelSelect();

  // Per-provider model lists
  const pmList = document.getElementById('provider-models-list');
  const providerOrder = MODEL_PROVIDER_ORDER;
  pmList.innerHTML = providerOrder.map(name => {
    const models = data.providers?.[name]?.defaultModels || [];
    return `
      <div class="h23s-provider-card" style="padding:12px 16px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:600;color:#fff;">${PROVIDER_DISPLAY[name] || name}</span>
          <span style="font-size:11px;color:var(--text-muted);">${models.length} model${models.length !== 1 ? 's' : ''}</span>
        </div>
        <div id="pm-models-${name}">
          ${models.map(m => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;" data-pm-entry="${name}">
              <input type="text" value="${m}" style="flex:1;font-size:13px;" data-pm-model>
              <button class="h23s-btn-danger" onclick="this.parentElement.remove()" style="padding:2px 8px;font-size:11px;">x</button>
            </div>
          `).join('')}
        </div>
        <button class="h23s-btn-secondary" onclick="addProviderModel('${name}')" style="padding:4px 10px;font-size:11px;margin-top:4px;">+ Add Model</button>
      </div>
    `;
  }).join('');

  // Aliases
  const tbody = document.getElementById('aliases-body');
  const aliases = data.aliases || {};
  tbody.innerHTML = Object.entries(aliases).map(([alias, cfg]) => `
    <tr>
      <td><input type="text" value="${alias}" data-alias-name></td>
      <td><input type="text" value="${cfg.provider || ''}" data-alias-provider></td>
      <td><input type="text" value="${cfg.model || ''}" data-alias-model></td>
      <td><button class="h23s-btn-danger" onclick="this.closest('tr').remove()" style="padding:3px 8px;">x</button></td>
    </tr>
  `).join('');

  document.getElementById('btn-add-alias').onclick = () => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="text" value="" placeholder="alias" data-alias-name></td>
      <td><input type="text" value="" placeholder="provider" data-alias-provider></td>
      <td><input type="text" value="" placeholder="model" data-alias-model></td>
      <td><button class="h23s-btn-danger" onclick="this.closest('tr').remove()" style="padding:3px 8px;">x</button></td>
    `;
    tbody.appendChild(row);
  };
}

function addProviderModel(provName) {
  const container = document.getElementById(`pm-models-${provName}`);
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
  div.setAttribute('data-pm-entry', provName);
  div.innerHTML = `
    <input type="text" value="" placeholder="model-name" style="flex:1;font-size:13px;" data-pm-model autofocus>
    <button class="h23s-btn-danger" onclick="this.parentElement.remove()" style="padding:2px 8px;font-size:11px;">x</button>
  `;
  container.appendChild(div);
  div.querySelector('input').focus();
}

function collectProviderModels() {
  const result = {};
  for (const name of MODEL_PROVIDER_ORDER) {
    const entries = document.querySelectorAll(`[data-pm-entry="${name}"] [data-pm-model]`);
    result[name] = Array.from(entries).map(el => el.value.trim()).filter(Boolean);
  }
  return result;
}

async function saveModels() {
  const aliases = {};
  document.querySelectorAll('#aliases-body tr').forEach(row => {
    const name = row.querySelector('[data-alias-name]')?.value?.trim();
    const provider = row.querySelector('[data-alias-provider]')?.value?.trim();
    const model = row.querySelector('[data-alias-model]')?.value?.trim();
    if (name && provider && model) {
      aliases[name] = { provider, model };
    }
  });

  const body = {
    agent: selectedSettingsAgent,
    chat: {
      defaultProvider: document.getElementById('models-default-provider').value,
      defaultModel: document.getElementById('models-default-model').value,
    },
    aliases,
    providerModels: collectProviderModels(),
  };

  const statusEls = Array.from(document.querySelectorAll('[data-models-status]'));
  const setStatus = (text, color) => {
    for (const el of statusEls) {
      el.textContent = text;
      if (color) el.style.color = color;
    }
  };
  try {
    const res = await fetch(`${API}/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setStatus(
      data.ok
        ? `Saved for ${selectedAgentLabel()}.${data.restartedAgent ? ' Engine restarting.' : ''}`
        : ('Error: ' + data.error),
      data.ok ? 'var(--accent-green)' : 'var(--accent-red)'
    );
    setTimeout(() => setStatus('', ''), 3000);
  } catch (err) {
    setStatus('Error: ' + err.message, 'var(--accent-red)');
  }
}

// ── Query ──
//
// Defaults for the Query tab. Persisted to home.yaml under `query:`. The Query
// tab JS reads these at init time to seed the dropdowns; users override
// per-query in the UI.

async function loadQuerySettings() {
  try {
    const [qRes, cosmoModels] = await Promise.all([
      fetch(settingsApiUrl('/query', { agentScoped: true })),
      // Model list comes from cosmo23 (same source the Query tab uses), so
      // the sweep/synth dropdowns show every model the engine can actually route.
      fetch(`http://${window.location.hostname}:43210/api/providers/models`).catch(() => null),
    ]);
    const settings = qRes.ok ? await qRes.json() : {};
    let models = [];
    if (cosmoModels && cosmoModels.ok) {
      const mj = await cosmoModels.json();
      models = Array.isArray(mj) ? mj : (mj.models || []);
    }

    const fill = (id, selected) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      const byProvider = new Map();
      for (const m of models) {
        const p = m.provider || 'other';
        if (!byProvider.has(p)) byProvider.set(p, []);
        byProvider.get(p).push(m);
      }
      for (const [provider, ms] of byProvider) {
        const og = document.createElement('optgroup');
        og.label = provider;
        for (const m of ms) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name || m.id;
          if (m.id === selected) opt.selected = true;
          og.appendChild(opt);
        }
        sel.appendChild(og);
      }
    };

    fill('query-default-model', settings.defaultModel || '');
    fill('query-pgs-sweep-model', settings.pgsSweepModel || '');
    fill('query-pgs-synth-model', settings.pgsSynthModel || settings.defaultModel || '');

    const modeSel = document.getElementById('query-default-mode');
    if (modeSel) modeSel.value = settings.defaultMode || 'full';
    const depthSel = document.getElementById('query-pgs-depth');
    if (depthSel) depthSel.value = String(settings.pgsDepth ?? 0.25);
    const pgsChk = document.getElementById('query-pgs-default');
    if (pgsChk) pgsChk.checked = !!settings.enablePGSByDefault;
  } catch (err) {
    console.error('Failed to load Query settings:', err);
  }
}

async function saveQuerySettings() {
  const body = {
    agent: selectedSettingsAgent,
    defaultModel: document.getElementById('query-default-model')?.value || '',
    defaultMode: document.getElementById('query-default-mode')?.value || 'full',
    enablePGSByDefault: !!document.getElementById('query-pgs-default')?.checked,
    pgsSweepModel: document.getElementById('query-pgs-sweep-model')?.value || '',
    pgsSynthModel: document.getElementById('query-pgs-synth-model')?.value || '',
    pgsDepth: parseFloat(document.getElementById('query-pgs-depth')?.value || '0.25'),
  };
  const statusEl = document.getElementById('query-status');
  try {
    const res = await fetch(`${API}/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    statusEl.textContent = data.ok ? `Saved for ${selectedAgentLabel()}` : ('Error: ' + (data.error || 'unknown'));
    statusEl.style.color = data.ok ? 'var(--accent-green)' : 'var(--accent-red)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ── System ──

async function loadSystem() {
  try {
    const res = await fetch(`${API}/system`);
    const data = await res.json();
    renderSystem(data);
  } catch (err) {
    console.error('Failed to load system:', err);
  }
}

function msToHuman(ms) {
  if (!ms) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hr`;
}

function tokensToHuman(tokens) {
  if (!tokens) return '';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tokens`;
  return `${tokens} tokens`;
}

function renderSystem(data) {
  document.getElementById('sys-evobrew-port').value = data.evobrew?.port || 3415;
  document.getElementById('sys-cosmo-app').value = data.cosmo23?.ports?.app || 43210;
  document.getElementById('sys-cosmo-ws').value = data.cosmo23?.ports?.websocket || 43240;
  document.getElementById('sys-cosmo-dash').value = data.cosmo23?.ports?.dashboard || 43244;
  document.getElementById('sys-max-tokens').value = data.chat?.maxTokens || 4096;
  document.getElementById('sys-temperature').value = data.chat?.temperature || 0.7;
  document.getElementById('sys-history-budget').value = data.chat?.historyBudget || 400000;
  document.getElementById('sys-session-gap').value = data.chat?.sessionGapMs || 1800000;

  // Add human-readable hints
  const hints = {
    'sys-max-tokens': `${tokensToHuman(data.chat?.maxTokens || 4096)} per response`,
    'sys-temperature': data.chat?.temperature <= 0.3 ? 'Focused / deterministic' : data.chat?.temperature >= 0.8 ? 'Creative / varied' : 'Balanced',
    'sys-history-budget': `${tokensToHuman(data.chat?.historyBudget || 400000)} of conversation context`,
    'sys-session-gap': `${msToHuman(data.chat?.sessionGapMs || 1800000)} of silence starts a new session`,
  };
  for (const [id, text] of Object.entries(hints)) {
    const el = document.getElementById(id);
    if (el) {
      let hint = el.parentElement.querySelector('.h23s-hint');
      if (!hint) {
        hint = document.createElement('span');
        hint.className = 'h23s-hint';
        el.parentElement.appendChild(hint);
      }
      hint.textContent = text;
    }
  }

  const embList = document.getElementById('embeddings-list');
  const embProviders = data.embeddings?.providers || [];
  embList.innerHTML = embProviders.map((p, i) => `
    <div class="h23s-provider-card" style="padding:12px 16px;margin-bottom:8px;" data-emb-entry>
      <div style="display:flex;gap:8px;align-items:center;font-size:12px;flex-wrap:wrap;">
        <span style="color:var(--text-muted);min-width:55px;font-weight:600;">${i === 0 ? 'Primary' : 'Fallback ' + i}</span>
        <select data-emb-provider style="font-size:12px;padding:4px 8px;">
          <option value="ollama-local" ${p.provider === 'ollama-local' ? 'selected' : ''}>Ollama Local</option>
          <option value="ollama-cloud" ${p.provider === 'ollama-cloud' ? 'selected' : ''}>Ollama Cloud</option>
          <option value="openai" ${p.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
        </select>
        <input type="text" data-emb-model value="${p.model || ''}" placeholder="model" style="flex:1;min-width:120px;font-size:12px;">
        <input type="text" data-emb-endpoint value="${p.endpoint || ''}" placeholder="endpoint URL (optional)" style="flex:1;min-width:160px;font-size:12px;">
        <input type="number" data-emb-dims value="${p.dimensions || 768}" style="width:70px;font-size:12px;" title="Dimensions">
        <span style="color:var(--text-muted);font-size:11px;">dims</span>
        <button class="h23s-btn-danger" onclick="this.closest('[data-emb-entry]').remove()" style="padding:2px 8px;font-size:11px;">x</button>
      </div>
    </div>
  `).join('') || '<p class="h23s-panel-desc" style="margin:0;">No embedding providers configured.</p>';

  document.getElementById('btn-add-embedding').onclick = () => {
    const div = document.createElement('div');
    div.className = 'h23s-provider-card';
    div.style.cssText = 'padding:12px 16px;margin-bottom:8px;';
    div.setAttribute('data-emb-entry', '');
    div.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;font-size:12px;flex-wrap:wrap;">
        <span style="color:var(--text-muted);min-width:55px;font-weight:600;">New</span>
        <select data-emb-provider style="font-size:12px;padding:4px 8px;">
          <option value="ollama-local">Ollama Local</option>
          <option value="ollama-cloud">Ollama Cloud</option>
          <option value="openai">OpenAI</option>
        </select>
        <input type="text" data-emb-model value="nomic-embed-text" placeholder="model" style="flex:1;min-width:120px;font-size:12px;">
        <input type="text" data-emb-endpoint value="" placeholder="endpoint URL" style="flex:1;min-width:160px;font-size:12px;">
        <input type="number" data-emb-dims value="768" style="width:70px;font-size:12px;">
        <span style="color:var(--text-muted);font-size:11px;">dims</span>
        <button class="h23s-btn-danger" onclick="this.closest('[data-emb-entry]').remove()" style="padding:2px 8px;font-size:11px;">x</button>
      </div>
    `;
    embList.appendChild(div);
  };
}

async function saveSystem() {
  // Collect embeddings from form
  const embEntries = document.querySelectorAll('[data-emb-entry]');
  const embeddingProviders = Array.from(embEntries).map(el => {
    const provider = el.querySelector('[data-emb-provider]')?.value;
    const model = el.querySelector('[data-emb-model]')?.value?.trim();
    const endpoint = el.querySelector('[data-emb-endpoint]')?.value?.trim();
    const dimensions = parseInt(el.querySelector('[data-emb-dims]')?.value) || 768;
    if (!provider || !model) return null;
    const entry = { provider, model, dimensions };
    if (endpoint) entry.endpoint = endpoint;
    return entry;
  }).filter(Boolean);

  const body = {
    evobrew: { port: parseInt(document.getElementById('sys-evobrew-port').value) },
    cosmo23: {
      ports: {
        app: parseInt(document.getElementById('sys-cosmo-app').value),
        websocket: parseInt(document.getElementById('sys-cosmo-ws').value),
        dashboard: parseInt(document.getElementById('sys-cosmo-dash').value),
      },
    },
    chat: {
      maxTokens: parseInt(document.getElementById('sys-max-tokens').value),
      temperature: parseFloat(document.getElementById('sys-temperature').value),
      historyBudget: parseInt(document.getElementById('sys-history-budget').value),
      sessionGapMs: parseInt(document.getElementById('sys-session-gap').value),
    },
    embeddings: { providers: embeddingProviders },
  };

  const statusEl = document.getElementById('system-status');
  try {
    const res = await fetch(`${API}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    statusEl.textContent = data.ok ? 'Saved' : ('Error: ' + data.error);
    statusEl.style.color = data.ok ? 'var(--accent-green)' : 'var(--accent-red)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ── Skills ──

async function loadSkillsSettings() {
  try {
    const res = await fetch(`${API}/skills`);
    const data = await res.json();
    renderSkillsSettings(data);
  } catch (err) {
    console.error('Failed to load skills settings:', err);
  }
}

function renderSkillCard(skill) {
  const audit = skill.audit || {};
  const settings = skill.settings || {};
  const configured = settings.authRequired
    ? (settings.configured ? 'credential configured' : 'credential missing')
    : 'no credential required';
  const configuredColor = settings.authRequired
    ? (settings.configured ? 'var(--accent-green)' : 'var(--accent-orange, #fb923c)')
    : 'var(--text-muted)';

  return `
    <div class="h23s-provider-card" style="padding:14px 16px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="h23s-provider-name">${escapeHtml(skill.name)}</span>
            <span class="h23s-agent-badge">${escapeHtml(skill.category || 'general')}</span>
            <span class="h23s-agent-badge">${skill.operational ? 'exec' : 'docs'}</span>
            ${audit.status ? `<span class="h23s-agent-badge ${audit.status === 'strong' ? 'running' : 'partial'}">${escapeHtml(audit.status)}</span>` : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">${escapeHtml(skill.description || '')}</div>
        </div>
        <div style="font-size:11px;color:${configuredColor};text-align:right;min-width:160px;">
          <div>${escapeHtml(configured)}</div>
          ${audit.undertriggerRisk ? `<div style="margin-top:4px;color:var(--text-muted);">undertrigger: ${escapeHtml(audit.undertriggerRisk)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--text-muted);">
        <span>Runtime: <strong style="color:var(--text-secondary);">${escapeHtml(skill.runtime || 'docs')}</strong></span>
        <span>Actions: <strong style="color:var(--text-secondary);">${escapeHtml((skill.actions || []).join(', ') || 'none')}</strong></span>
        <span>Runs: <strong style="color:var(--text-secondary);">${audit.runCount || 0}</strong></span>
        ${settings.authRequired ? `<span>Auth: <strong style="color:${configuredColor};">${settings.configured ? 'ready' : 'needed'}</strong></span>` : ''}
      </div>
    </div>
  `;
}

function renderSkillsSettings(data) {
  skillsSettingsData = data;
  document.getElementById('skills-config-path').textContent = data.configPath || 'config/home.yaml';
  document.getElementById('skills-secrets-path').textContent = data.secretsPath || 'config/secrets.yaml';

  const catalog = document.getElementById('skills-catalog');
  catalog.innerHTML = (data.skills || []).map(renderSkillCard).join('')
    || '<p class="h23s-panel-desc" style="margin:0;">No shared skills discovered.</p>';

  const xr = data.xResearch || {};
  document.getElementById('xresearch-default-quick').checked = xr.defaults?.quick === true;
  document.getElementById('xresearch-default-markdown').checked = xr.defaults?.saveMarkdown !== false;
  document.getElementById('xresearch-watchlist-count').textContent = String(xr.watchlistCount || 0);
  document.getElementById('xresearch-clear-token').checked = false;
  document.getElementById('xresearch-token').value = '';
  document.getElementById('xresearch-token-current').textContent = xr.configured
    ? `Current token: ${xr.maskedBearerToken || 'configured'}`
    : 'No token configured';
}

async function saveSkillsSettings() {
  const statusEl = document.getElementById('skills-status');
  const bearerToken = document.getElementById('xresearch-token').value.trim();
  const clearBearerToken = document.getElementById('xresearch-clear-token').checked;
  const body = {
    skills: {
      'x-research': {
        defaults: {
          quick: document.getElementById('xresearch-default-quick').checked,
          saveMarkdown: document.getElementById('xresearch-default-markdown').checked,
        },
        ...(bearerToken ? { bearerToken } : {}),
        ...(clearBearerToken ? { clearBearerToken: true } : {}),
      },
    },
  };

  try {
    const res = await fetch(`${API}/skills`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
      return;
    }

    statusEl.textContent = 'Saved · hot-applied';
    statusEl.style.color = 'var(--accent-green)';
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
    loadSkillsSettings();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function setupSkillsHandlers() {
  document.getElementById('btn-save-skills')?.addEventListener('click', saveSkillsSettings);
}

// ── Maintenance actions ──

async function installDeps() {
  const output = document.getElementById('action-output');
  output.style.display = 'block';
  output.textContent = 'Installing dependencies...\n';

  try {
    const res = await fetch(`${API}/system/install`, { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const lines = text.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        try {
          const data = JSON.parse(line.slice(6));
          output.textContent += `${data.step}: ${data.status}${data.error ? ' - ' + data.error : ''}\n`;
          output.scrollTop = output.scrollHeight;
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    output.textContent += 'Error: ' + err.message + '\n';
  }
}

async function buildTS() {
  const output = document.getElementById('action-output');
  output.style.display = 'block';
  output.textContent = 'Building TypeScript...\n';

  try {
    const res = await fetch(`${API}/system/build`, { method: 'POST' });
    const data = await res.json();
    output.textContent += data.ok ? 'Build complete.\n' : `Build failed: ${data.error}\n`;
  } catch (err) {
    output.textContent += 'Error: ' + err.message + '\n';
  }
}

// ── OAuth cards on Providers tab (STEP 18) ──

async function loadOAuthStatus() {
  try {
    const res = await fetch(`${API}/oauth/status`);
    const data = await res.json();
    renderOAuthCard('anthropic', data.anthropic || {});
    renderOAuthCard('codex', data.openaiCodex || {});
  } catch (err) {
    console.warn('oauth status load failed:', err.message);
    renderOAuthCard('anthropic', {});
    renderOAuthCard('codex', {});
  }
}

function renderOAuthCard(kind, status) {
  const statusEl = document.getElementById(`${kind}-oauth-status`);
  const logoutBtn = document.getElementById(`btn-${kind}-oauth-logout`);
  if (!statusEl) return;
  if (status.configured && status.valid) {
    const expiry = status.expiresAt ? ` · expires ${new Date(status.expiresAt).toLocaleDateString()}` : '';
    statusEl.innerHTML = `<span class="h23s-oauth-connected">✓ Connected${expiry}</span>`;
    if (logoutBtn) logoutBtn.hidden = false;
  } else if (status.configured) {
    statusEl.innerHTML = `<span class="h23s-oauth-expired">⚠ Token expired — re-authorize</span>`;
    if (logoutBtn) logoutBtn.hidden = false;
  } else {
    statusEl.innerHTML = `<span class="h23s-oauth-disconnected">Not configured</span>`;
    if (logoutBtn) logoutBtn.hidden = true;
  }
}

function showOAuthMessage(kind, text, isError = false) {
  const el = document.getElementById(`${kind}-oauth-status`);
  if (!el) return;
  const color = isError ? 'var(--accent-red)' : 'var(--accent-blue)';
  el.innerHTML = `<span style="color:${color};">${text}</span>`;
}

async function anthropicOAuthImportCli() {
  showOAuthMessage('anthropic', 'Importing from Claude CLI…');
  try {
    const r = await fetch(`${API}/oauth/anthropic/import-cli`, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('anthropic', `Import failed: ${data.error || 'unknown'}`, true);
    await loadOAuthStatus();
    if (data.warn) console.warn('[oauth]', data.warn);
  } catch (err) {
    showOAuthMessage('anthropic', `Import error: ${err.message}`, true);
  }
}

async function anthropicOAuthStart() {
  try {
    const r = await fetch(`${API}/oauth/anthropic/start`);
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('anthropic', `Start failed: ${data.error || 'unknown'}`, true);
    const link = document.getElementById('anthropic-oauth-link');
    link.href = data.authUrl;
    link.textContent = 'Open Anthropic OAuth page ↗';
    document.getElementById('anthropic-oauth-flow').hidden = false;
    // Auto-open in a new tab
    window.open(data.authUrl, '_blank', 'noopener,noreferrer');
  } catch (err) {
    showOAuthMessage('anthropic', `Start error: ${err.message}`, true);
  }
}

async function anthropicOAuthComplete() {
  const callbackUrl = document.getElementById('anthropic-oauth-callback').value.trim();
  if (!callbackUrl) return;
  showOAuthMessage('anthropic', 'Completing OAuth…');
  try {
    const r = await fetch(`${API}/oauth/anthropic/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackUrl }),
    });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('anthropic', `OAuth failed: ${data.error || 'unknown'}`, true);
    document.getElementById('anthropic-oauth-flow').hidden = true;
    document.getElementById('anthropic-oauth-callback').value = '';
    await loadOAuthStatus();
  } catch (err) {
    showOAuthMessage('anthropic', `OAuth error: ${err.message}`, true);
  }
}

async function anthropicOAuthLogout() {
  if (!confirm('Log out of Anthropic OAuth? The agent will lose access to Anthropic models until re-configured.')) return;
  try {
    const r = await fetch(`${API}/oauth/anthropic/logout`, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('anthropic', `Logout failed: ${data.error || 'unknown'}`, true);
    await loadOAuthStatus();
  } catch (err) {
    showOAuthMessage('anthropic', `Logout error: ${err.message}`, true);
  }
}

async function codexOAuthImportEvobrew() {
  showOAuthMessage('codex', 'Importing from Evobrew…');
  try {
    const r = await fetch(`${API}/oauth/openai-codex/import-evobrew`, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('codex', `Import failed: ${data.error || 'unknown'}`, true);
    await loadOAuthStatus();
  } catch (err) {
    showOAuthMessage('codex', `Import error: ${err.message}`, true);
  }
}

async function codexOAuthStart() {
  showOAuthMessage('codex', 'OAuth flow running (check your browser)…');
  document.getElementById('codex-oauth-note').hidden = false;
  try {
    // This call blocks until cosmo23's local callback server receives the code
    const r = await fetch(`${API}/oauth/openai-codex/start`, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('codex', `OAuth failed: ${data.error || 'unknown'}`, true);
    document.getElementById('codex-oauth-note').hidden = true;
    await loadOAuthStatus();
  } catch (err) {
    showOAuthMessage('codex', `OAuth error: ${err.message}`, true);
  }
}

async function codexOAuthLogout() {
  if (!confirm('Log out of OpenAI Codex OAuth? The agent will lose access to Codex models until re-configured.')) return;
  try {
    const r = await fetch(`${API}/oauth/openai-codex/logout`, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) return showOAuthMessage('codex', `Logout failed: ${data.error || 'unknown'}`, true);
    await loadOAuthStatus();
  } catch (err) {
    showOAuthMessage('codex', `Logout error: ${err.message}`, true);
  }
}

function setupOAuthHandlers() {
  document.getElementById('btn-anthropic-oauth-import')?.addEventListener('click', anthropicOAuthImportCli);
  document.getElementById('btn-anthropic-oauth-start')?.addEventListener('click', anthropicOAuthStart);
  document.getElementById('btn-anthropic-oauth-complete')?.addEventListener('click', anthropicOAuthComplete);
  document.getElementById('btn-anthropic-oauth-logout')?.addEventListener('click', anthropicOAuthLogout);
  document.getElementById('btn-codex-oauth-import')?.addEventListener('click', codexOAuthImportEvobrew);
  document.getElementById('btn-codex-oauth-start')?.addEventListener('click', codexOAuthStart);
  document.getElementById('btn-codex-oauth-logout')?.addEventListener('click', codexOAuthLogout);
}

// ── Feeder tab (STEP 17) ──

let feederPollTimer = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function feederAgentUrl(path) {
  const url = new URL(path, window.location.origin);
  if (selectedSettingsAgent) {
    url.searchParams.set('agent', selectedSettingsAgent);
  }
  return `${url.pathname}${url.search}`;
}

async function loadFeeder() {
  try {
    const res = await fetch(settingsApiUrl('/feeder', { agentScoped: true }));
    const data = await res.json();
    renderFeeder(data);
  } catch (err) {
    console.error('Failed to load feeder config:', err);
  }
  loadFeederLiveStatus();
}

function renderFeeder(data) {
  const f = data.feeder || {};

  // Auto watch paths (read-only)
  const autoHost = document.getElementById('fd-auto-paths');
  if (autoHost) {
    const autoList = (data.autoWatchPaths || [])
      .map((p) => `<div class="h23s-field" style="padding:6px 10px; background:rgba(0,122,255,0.08); border-radius:6px; margin-bottom:4px;">
        <div style="font-size:0.75em; color:var(--accent-blue); text-transform:uppercase;">${escapeHtml(p.label)}</div>
        <div style="font-family:monospace; font-size:0.85em;">${escapeHtml(p.path)}</div>
      </div>`)
      .join('');
    autoHost.innerHTML = autoList || '<em style="opacity:0.6;">No auto-watched paths</em>';
  }

  // Additional watch paths
  const pathsHost = document.getElementById('fd-watch-paths');
  const paths = Array.isArray(f.additionalWatchPaths) ? f.additionalWatchPaths : [];
  pathsHost.innerHTML = paths.length
    ? paths.map((p, i) => renderWatchPathRow(typeof p === 'string' ? { path: p } : p, i)).join('')
    : '<em style="opacity:0.6;">No additional watch paths configured.</em>';

  // Exclude patterns
  document.getElementById('fd-exclude-patterns').value = (f.excludePatterns || []).join('\n');

  // Frequency + batching
  document.getElementById('fd-flush-interval').value = f.flush?.intervalSeconds ?? 30;
  document.getElementById('fd-batch-size').value = f.flush?.batchSize ?? 20;
  document.getElementById('fd-chunk-size').value = f.chunking?.maxChunkSize ?? 3000;
  document.getElementById('fd-chunk-overlap').value = f.chunking?.overlap ?? 300;

  // Compiler
  document.getElementById('fd-compiler-enabled').checked = f.compiler?.enabled !== false;
  const compilerSel = document.getElementById('fd-compiler-model');
  const currentCompilerModel = f.compiler?.model || 'minimax-m2.7';
  compilerSel.innerHTML = '';
  if (modelsData?.providers) {
    for (const [provName, prov] of Object.entries(modelsData.providers)) {
      for (const m of (prov.defaultModels || [])) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = `${m}  (${PROVIDER_DISPLAY[provName] || provName})`;
        if (m === currentCompilerModel) opt.selected = true;
        compilerSel.appendChild(opt);
      }
    }
  }
  // If current model isn't in any provider list, add it so it's still selectable
  if (currentCompilerModel && !compilerSel.querySelector(`option[value="${CSS.escape(currentCompilerModel)}"]`)) {
    const opt = document.createElement('option');
    opt.value = currentCompilerModel;
    opt.textContent = `${currentCompilerModel}  (unknown provider)`;
    opt.selected = true;
    compilerSel.prepend(opt);
  }

  // Converter
  document.getElementById('fd-converter-enabled').checked = f.converter?.enabled !== false;
  const visionSel = document.getElementById('fd-converter-vision');
  const currentVisionModel = f.converter?.visionModel || 'gpt-4o-mini';
  visionSel.innerHTML = '';
  if (modelsData?.providers) {
    for (const [provName, prov] of Object.entries(modelsData.providers)) {
      for (const m of (prov.defaultModels || [])) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = `${m}  (${PROVIDER_DISPLAY[provName] || provName})`;
        if (m === currentVisionModel) opt.selected = true;
        visionSel.appendChild(opt);
      }
    }
  }
  if (currentVisionModel && !visionSel.querySelector(`option[value="${CSS.escape(currentVisionModel)}"]`)) {
    const opt = document.createElement('option');
    opt.value = currentVisionModel;
    opt.textContent = `${currentVisionModel}  (unknown provider)`;
    opt.selected = true;
    visionSel.prepend(opt);
  }
  document.getElementById('fd-converter-python').value = f.converter?.pythonPath || 'python3';
}

function renderWatchPathRow(entry, idx) {
  const p = typeof entry === 'string' ? entry : (entry.path || '');
  const label = typeof entry === 'string' ? '' : (entry.label || '');
  return `<div class="h23s-field-row" data-fd-path-row="${idx}" style="align-items:flex-end; margin-bottom:6px;">
    <div class="h23s-field" style="flex:3;">
      <label>Path</label>
      <input type="text" data-fd-path-input value="${escapeHtml(p)}" placeholder="/absolute/path">
    </div>
    <div class="h23s-field" style="flex:1;">
      <label>Label</label>
      <input type="text" data-fd-path-label value="${escapeHtml(label)}" placeholder="workspace">
    </div>
    <button class="h23s-btn-secondary" data-fd-remove-path="${idx}">Remove</button>
  </div>`;
}

function collectFeederConfig() {
  const pathRows = Array.from(document.querySelectorAll('[data-fd-path-row]'));
  const additionalWatchPaths = pathRows
    .map((row) => {
      const path = row.querySelector('[data-fd-path-input]').value.trim();
      const label = row.querySelector('[data-fd-path-label]').value.trim();
      if (!path) return null;
      return label ? { path, label } : { path };
    })
    .filter(Boolean);

  const excludePatterns = document.getElementById('fd-exclude-patterns').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    additionalWatchPaths,
    excludePatterns,
    flush: {
      intervalSeconds: parseInt(document.getElementById('fd-flush-interval').value, 10) || 30,
      batchSize: parseInt(document.getElementById('fd-batch-size').value, 10) || 20,
    },
    chunking: {
      maxChunkSize: parseInt(document.getElementById('fd-chunk-size').value, 10) || 3000,
      overlap: parseInt(document.getElementById('fd-chunk-overlap').value, 10) || 300,
    },
    compiler: {
      enabled: document.getElementById('fd-compiler-enabled').checked,
      model: document.getElementById('fd-compiler-model').value.trim() || 'minimax-m2.7',
    },
    converter: {
      enabled: document.getElementById('fd-converter-enabled').checked,
      visionModel: document.getElementById('fd-converter-vision').value.trim() || 'gpt-4o-mini',
      pythonPath: document.getElementById('fd-converter-python').value.trim() || 'python3',
    },
  };
}

async function saveFeeder() {
  const statusEl = document.getElementById('feeder-status');
  const feeder = collectFeederConfig();
  try {
    const res = await fetch(settingsApiUrl('/feeder', { agentScoped: true }), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feeder }),
    });
    const data = await res.json();
    if (!data.ok) {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
      return;
    }

    // Hot-apply: for compiler changes and added watch paths, call the live feeder directly
    const applied = data.applied || [];
    const hotCompiler = applied.includes('compiler');
    const addedPaths = applied.filter((a) => a.startsWith('watchPath:+'));

    if (hotCompiler) {
      try {
        await fetch(feederAgentUrl('/home23/feeder/update-compiler'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: feeder.compiler.enabled, model: feeder.compiler.model }),
        });
      } catch { /* non-fatal */ }
    }
    for (const addStr of addedPaths) {
      const p = addStr.slice('watchPath:+'.length);
      const entry = feeder.additionalWatchPaths.find((w) => w.path === p);
      try {
        await fetch(feederAgentUrl('/home23/feeder/add-watch-path'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, label: entry?.label || null }),
        });
      } catch { /* non-fatal */ }
    }

    // Restart banner
    const banner = document.getElementById('feeder-restart-banner');
    const list = document.getElementById('fd-restart-list');
    if ((data.requiresRestart || []).length > 0) {
      banner.style.display = '';
      list.textContent = data.requiresRestart.join(', ');
    } else {
      banner.style.display = 'none';
    }

    statusEl.textContent = `Saved for ${selectedAgentLabel()}` + (applied.length ? ` (${applied.length} hot-applied)` : '');
    statusEl.style.color = 'var(--accent-green)';
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
    loadFeederLiveStatus();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

async function loadFeederLiveStatus() {
  try {
    const [liveRes, summaryRes] = await Promise.all([
      fetch(feederAgentUrl('/home23/feeder/live-status')).catch(() => null),
      fetch(feederAgentUrl('/home23/feeder-status')).catch(() => null),
    ]);

    let started = '—', watchers = '—', converter = '—';
    // The live flush queue is the only honest source for "Pending" — the
    // summary aggregator computes `files_on_disk - manifest.length` which
    // permanently inflates by files the feeder will never ingest (binary
    // archives, managed artifacts, broken-converter PDFs, etc.).
    let livePending = null;
    if (liveRes && liveRes.ok) {
      const live = await liveRes.json();
      if (live.ok && live.status) {
        started = live.status.started ? '✓ running' : '✗ stopped';
        watchers = String(live.status.watching?.length ?? 0);
        const cv = live.status.converter;
        converter = cv?.available ? `✓ ${cv.visionModel || ''}` : '✗ unavailable';
        if (Number.isFinite(live.status.manifest?.pendingCount)) {
          livePending = live.status.manifest.pendingCount;
        }
      }
    } else {
      started = 'engine unreachable';
    }
    document.getElementById('fd-live-started').textContent = started;
    document.getElementById('fd-live-watchers').textContent = watchers;
    document.getElementById('fd-live-converter').textContent = converter;
    document.getElementById('fd-converter-status').textContent = converter;

    if (summaryRes && summaryRes.ok) {
      const summary = await summaryRes.json();
      const first = (summary.feeders || [])[0] || {};
      document.getElementById('fd-live-files').textContent = String(first.processedFiles ?? 0);
      document.getElementById('fd-live-compiled').textContent = String(first.compiledCount ?? 0);
      const qEl = document.getElementById('fd-live-quarantined');
      if (qEl) qEl.textContent = String(first.quarantinedCount ?? 0);
    }

    // Prefer the engine's live flush-queue count; fall back to 0 when unreachable.
    document.getElementById('fd-live-pending').textContent = String(livePending ?? 0);
  } catch (err) {
    console.warn('feeder status load failed:', err.message);
  }
}

async function feederForceFlush() {
  const statusEl = document.getElementById('feeder-action-status');
  statusEl.textContent = 'Flushing…';
  try {
    const res = await fetch(feederAgentUrl('/home23/feeder/flush'), { method: 'POST' });
    const data = await res.json();
    statusEl.textContent = data.ok ? `Flushed ${selectedAgentLabel()}` : ('Error: ' + (data.error || 'unknown'));
    statusEl.style.color = data.ok ? 'var(--accent-green)' : 'var(--accent-red)';
    setTimeout(() => loadFeederLiveStatus(), 500);
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function setupFeederDropzone() {
  const dz = document.getElementById('fd-dropzone');
  const input = document.getElementById('fd-file-input');
  if (!dz || !input) return;

  dz.addEventListener('click', () => input.click());

  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('drag-over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) uploadFiles(files);
  });

  input.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadFiles(files);
    input.value = '';
  });
}

async function uploadFiles(files) {
  const progressHost = document.getElementById('fd-upload-progress');
  const label = (document.getElementById('fd-upload-label').value || 'dropzone').trim();

  const rowId = `upload-${Date.now()}`;
  progressHost.insertAdjacentHTML(
    'afterbegin',
    `<div class="h23s-field" id="${rowId}" style="margin-top:8px;">
      <div style="font-size:0.85em;">Uploading ${files.length} file(s) to "${escapeHtml(label)}"…</div>
    </div>`
  );
  const row = document.getElementById(rowId);

  try {
    const fd = new FormData();
    fd.append('label', label);
    for (const f of files) fd.append('files', f, f.name);

    const res = await fetch(feederAgentUrl('/home23/feeder/upload'), { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.ok) {
      row.innerHTML = `<div style="color:var(--accent-red);">Upload failed: ${escapeHtml(data.error || 'unknown')}</div>`;
      return;
    }
    const fileList = (data.files || []).map((f) => `<div style="font-family:monospace; font-size:0.8em; opacity:0.8;">→ ${escapeHtml(f.name)} (${Math.round(f.size / 1024)}KB)</div>`).join('');
    row.innerHTML = `<div style="color:var(--accent-green);">✓ Uploaded ${data.count} file(s) to ${escapeHtml(data.label)} for ${escapeHtml(selectedAgentLabel('the selected agent'))}. Feeder will pick them up within ~1s.</div>${fileList}`;
    // Poll for ingestion
    setTimeout(() => loadFeederLiveStatus(), 1500);
    setTimeout(() => loadFeederLiveStatus(), 4000);
  } catch (err) {
    row.innerHTML = `<div style="color:var(--accent-red);">Upload error: ${escapeHtml(err.message)}</div>`;
  }
}

async function restartEngine() {
  const statusEl = document.getElementById('feeder-action-status');
  statusEl.textContent = 'Restarting engine…';
  try {
    if (!selectedSettingsAgent) {
      throw new Error('No selected agent');
    }
    const res = await fetch(`${API}/agents/${encodeURIComponent(selectedSettingsAgent)}/restart-engine`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'restart failed');
    }
    statusEl.textContent = `Restarted ${selectedAgentLabel()}'s engine.`;
    statusEl.style.color = 'var(--accent-green)';
    setTimeout(() => loadFeederLiveStatus(), 2000);
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ── Vibe ──

async function loadVibe() {
  try {
    const res = await fetch('/home23/api/settings/vibe');
    const data = await res.json();
    const v = data.vibe || {};
    const imageGeneration = data.imageGeneration || {};
    const imageProviders = data.imageProviders || {};
    const d = v.dreams || {};
    document.getElementById('vibe-autogen').checked = v.autoGenerate !== false;
    document.getElementById('vibe-gen-hours').value = v.generationIntervalHours ?? 12;
    document.getElementById('vibe-rot-seconds').value = v.rotationIntervalSeconds ?? 45;
    document.getElementById('vibe-gallery-limit').value = v.galleryLimit ?? 60;
    document.getElementById('vibe-dreams-enabled').checked = d.enabled !== false;
    document.getElementById('vibe-dreams-lookback').value = d.lookback ?? 3;
    document.getElementById('vibe-dreams-extraction').value = d.extraction === 'llm' ? 'llm' : 'heuristic';
    document.getElementById('vibe-source-paths').value = Array.isArray(v.sourcePaths) ? v.sourcePaths.join('\n') : '';
    renderVibeImageGeneration(imageProviders, imageGeneration);
  } catch (err) {
    console.error('[vibe] load failed', err);
  }
}

function renderVibeImageGeneration(imageProviders, imageGeneration) {
  const providerSel = document.getElementById('vibe-image-provider');
  const modelSel = document.getElementById('vibe-image-model');
  if (!providerSel || !modelSel) return;

  const providerNames = Object.keys(imageProviders || {});
  providerSel.innerHTML = providerNames.map((name) => {
    const cfg = imageProviders[name] || {};
    const selected = name === (imageGeneration.provider || 'openai') ? 'selected' : '';
    return `<option value="${escapeHtml(name)}" ${selected}>${escapeHtml(cfg.displayName || PROVIDER_DISPLAY[name] || name)}</option>`;
  }).join('');

  const fillModels = () => {
    const provider = providerSel.value || imageGeneration.provider || providerNames[0] || 'openai';
    const models = imageProviders?.[provider]?.models || [];
    modelSel.innerHTML = models.map((model) => {
      const selected = model === imageGeneration.model ? 'selected' : '';
      return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
    }).join('');
  };

  if (!providerSel.dataset.boundVibeImage) {
    providerSel.addEventListener('change', () => {
      imageGeneration.model = '';
      fillModels();
    });
    providerSel.dataset.boundVibeImage = 'true';
  }
  fillModels();
}

async function saveVibe() {
  const statusEl = document.getElementById('vibe-save-status');
  statusEl.textContent = 'Saving...';
  const body = {
    vibe: {
      autoGenerate: document.getElementById('vibe-autogen').checked,
      generationIntervalHours: Number(document.getElementById('vibe-gen-hours').value),
      rotationIntervalSeconds: Number(document.getElementById('vibe-rot-seconds').value),
      galleryLimit: Number(document.getElementById('vibe-gallery-limit').value),
      sourcePaths: document.getElementById('vibe-source-paths').value
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
      dreams: {
        enabled: document.getElementById('vibe-dreams-enabled').checked,
        lookback: Number(document.getElementById('vibe-dreams-lookback').value),
        extraction: document.getElementById('vibe-dreams-extraction').value,
      },
    },
    imageGeneration: {
      provider: document.getElementById('vibe-image-provider')?.value || 'openai',
      model: document.getElementById('vibe-image-model')?.value || 'gpt-image-2',
    },
  };
  try {
    const res = await fetch('/home23/api/settings/vibe', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    statusEl.textContent = 'Saved · hot-applied';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// ── Tiles ──

const TILE_MODE_LABELS = {
  'ecowitt-weather': 'Ecowitt Weather',
  'huum-sauna': 'Huum Sauna',
  'generic-http-json': 'Generic HTTP JSON',
};

function broadcastTilesUpdate() {
  try {
    tilesBroadcast?.postMessage({ type: 'tiles-updated', at: Date.now() });
  } catch {
    /* optional */
  }
}

async function loadTilesPanel() {
  try {
    const [tilesRes, connectionsRes] = await Promise.all([
      fetch(`${API}/tiles`),
      fetch(`${API}/tile-connections`),
    ]);
    const tilesData = await tilesRes.json();
    const connectionsData = await connectionsRes.json();

    tilesState = tilesData.tiles;
    tileConnectionsState = connectionsData.connections;
    tileConnectionsState.connections = (tileConnectionsState.connections || []).map((connection) => ({
      ...connection,
      secrets: connection.secrets || {},
    }));

    ensureTileLayoutCoverage();
    renderTilesPanel();
  } catch (err) {
    console.error('Failed to load tile settings:', err);
  }
}

function slugifyDraftId(value, fallbackPrefix) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  return `${fallbackPrefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function maskSecretPreview(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 10) return '••••';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

function prettyJson(value) {
  return JSON.stringify(value || [], null, 2);
}

function parseJsonField(raw, label, fallback = []) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function getTileDefinitionsMap() {
  const map = new Map();
  (tilesState?.coreTiles || []).forEach((tile) => map.set(tile.id, tile));
  (tilesState?.customTiles || []).forEach((tile) => map.set(tile.id, tile));
  return map;
}

function ensureTileLayoutCoverage() {
  if (!tilesState) return;
  const defs = getTileDefinitionsMap();
  const existing = new Set((tilesState.homeLayout || []).map((item) => item.tileId));
  for (const tile of defs.values()) {
    if (existing.has(tile.id)) continue;
    tilesState.homeLayout.push({
      tileId: tile.id,
      enabled: true,
      size: tile.sizeDefault || 'third',
      tile,
    });
  }
}

function getConnectionOptionsForMode(mode) {
  const template = (tilesState?.templateModes || []).find((entry) => entry.mode === mode);
  const requiredType = template?.connectionType;
  return (tileConnectionsState?.connections || []).filter((connection) => connection.type === requiredType);
}

function renderTilesPanel() {
  renderTilesLayoutList();
  renderCustomTilesList();
  renderTileConnectionsList();
  populateTileModeSelect();
  populateConnectionTypeSelect();
  resetCustomTileForm();
  resetTileConnectionForm();
}

function renderTilesLayoutList() {
  const host = document.getElementById('tiles-layout-list');
  if (!host || !tilesState) return;

  const defs = getTileDefinitionsMap();
  const rows = (tilesState.homeLayout || []).map((item) => {
    const tile = defs.get(item.tileId) || item.tile;
    if (!tile) return '';
    return `
      <div class="h23s-layout-row" draggable="true" data-layout-tile-id="${tile.id}">
        <div class="h23s-layout-handle">☰</div>
        <div class="h23s-layout-info">
          <div class="h23s-layout-title">
            <span>${escapeHtml(tile.icon || '🧩')}</span>
            <span>${escapeHtml(tile.title)}</span>
            <span class="h23s-badge ${tile.kind === 'core' ? 'core' : 'custom'}">${tile.kind}</span>
          </div>
          <div class="h23s-layout-subtitle">${escapeHtml(tile.id)} · ${escapeHtml(tile.mode)}</div>
        </div>
        <div class="h23s-layout-controls">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);">
            <input type="checkbox" data-layout-enabled ${item.enabled !== false ? 'checked' : ''}>
            <span>visible</span>
          </label>
          <select data-layout-size>
            ${(tilesState.sizeOptions || ['third', 'half', 'full']).map((size) => `<option value="${size}" ${size === item.size ? 'selected' : ''}>${size}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }).join('');

  host.innerHTML = rows || '<div class="h23s-empty-card">No tiles in layout.</div>';
}

function renderCustomTilesList() {
  const host = document.getElementById('custom-tiles-list');
  if (!host || !tilesState) return;

  const tiles = tilesState.customTiles || [];
  if (!tiles.length) {
    host.innerHTML = '<div class="h23s-empty-card">No custom tiles yet. Create one below.</div>';
    return;
  }

  host.innerHTML = tiles.map((tile) => {
    const connection = (tileConnectionsState?.connections || []).find((entry) => entry.id === tile.connectionId);
    return `
      <div class="h23s-config-card" data-custom-tile-id="${tile.id}">
        <div class="h23s-config-card-main">
          <div class="h23s-config-card-title">
            <span>${escapeHtml(tile.icon || '🧩')}</span>
            <span>${escapeHtml(tile.title)}</span>
            <span class="h23s-badge custom">custom</span>
            <span class="h23s-badge mode">${escapeHtml(TILE_MODE_LABELS[tile.mode] || tile.mode)}</span>
          </div>
          <div class="h23s-config-card-subtitle">
            ${escapeHtml(tile.id)} · ${escapeHtml(connection?.name || 'No connection')} · refresh ${Math.round((tile.refreshMs || 30000) / 1000)}s · default ${escapeHtml(tile.sizeDefault || 'third')}
          </div>
        </div>
        <div class="h23s-config-card-actions">
          <button class="h23s-btn-secondary" data-edit-custom-tile="${tile.id}">Edit</button>
          <button class="h23s-btn-danger" data-delete-custom-tile="${tile.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderTileConnectionsList() {
  const host = document.getElementById('tile-connections-list');
  if (!host || !tileConnectionsState) return;

  const connections = tileConnectionsState.connections || [];
  if (!connections.length) {
    host.innerHTML = '<div class="h23s-empty-card">No reusable connections configured yet.</div>';
    return;
  }

  host.innerHTML = connections.map((connection) => {
    const secretSummary = Object.entries(connection.maskedSecrets || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');
    return `
      <div class="h23s-config-card" data-tile-connection-id="${connection.id}">
        <div class="h23s-config-card-main">
          <div class="h23s-config-card-title">
            <span>${escapeHtml(connection.name)}</span>
            <span class="h23s-badge mode">${escapeHtml(connection.type)}</span>
          </div>
          <div class="h23s-config-card-subtitle">
            ${escapeHtml(connection.id)}
            ${connection.config?.baseUrl ? ` · ${escapeHtml(connection.config.baseUrl)}` : ''}
            ${secretSummary ? ` · ${escapeHtml(secretSummary)}` : ''}
          </div>
        </div>
        <div class="h23s-config-card-actions">
          <button class="h23s-btn-secondary" data-edit-tile-connection="${connection.id}">Edit</button>
          <button class="h23s-btn-danger" data-delete-tile-connection="${connection.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function populateTileModeSelect() {
  const select = document.getElementById('tile-mode');
  if (!select || !tilesState) return;
  const current = select.value || 'ecowitt-weather';
  select.innerHTML = (tilesState.templateModes || []).map((mode) => (
    `<option value="${mode.mode}">${mode.label}</option>`
  )).join('');
  select.value = (tilesState.templateModes || []).some((entry) => entry.mode === current)
    ? current
    : ((tilesState.templateModes || [])[0]?.mode || 'ecowitt-weather');
  populateTileConnectionSelect();
  renderTileModeFields();
}

function populateTileConnectionSelect(selectedConnectionId = '') {
  const select = document.getElementById('tile-connection');
  if (!select) return;
  const mode = document.getElementById('tile-mode')?.value || 'ecowitt-weather';
  const connections = getConnectionOptionsForMode(mode);
  select.innerHTML = connections.length
    ? connections.map((connection) => `<option value="${connection.id}">${escapeHtml(connection.name)}</option>`).join('')
    : '<option value="">No matching connections yet</option>';

  if (selectedConnectionId && connections.some((entry) => entry.id === selectedConnectionId)) {
    select.value = selectedConnectionId;
  }
}

function populateConnectionTypeSelect() {
  const select = document.getElementById('tile-connection-type');
  if (!select || !tileConnectionsState) return;
  const current = select.value || 'ecowitt';
  select.innerHTML = (tileConnectionsState.connectionTypes || []).map((type) => (
    `<option value="${type.type}">${type.label}</option>`
  )).join('');
  select.value = (tileConnectionsState.connectionTypes || []).some((entry) => entry.type === current)
    ? current
    : ((tileConnectionsState.connectionTypes || [])[0]?.type || 'ecowitt');
  renderTileConnectionFields();
}

function renderTileModeFields(config = null) {
  const host = document.getElementById('tile-mode-fields');
  const mode = document.getElementById('tile-mode')?.value;
  if (!host || !mode) return;

  if (mode === 'huum-sauna') {
    const startDefaults = config?.startDefaults || {};
    host.innerHTML = `
      <div class="h23s-field-row">
        <div class="h23s-field">
          <label>Start Target Temperature (F)</label>
          <input type="number" id="tile-huum-start-temp" min="100" max="240" value="${startDefaults.targetTemperature ?? 190}">
        </div>
        <div class="h23s-field">
          <label>Start Duration (minutes)</label>
          <input type="number" id="tile-huum-start-duration" min="15" max="720" value="${startDefaults.duration ?? 180}">
        </div>
      </div>
      <div class="h23s-inline-note">The tile will expose Start and Stop actions. Start uses these defaults until the operator overrides them in the action dialog.</div>
    `;
    return;
  }

  if (mode === 'generic-http-json') {
    const display = config?.display || {};
    const request = config?.request || {};
    host.innerHTML = `
      <div class="h23s-field">
        <label>Request Path</label>
        <input type="text" id="tile-generic-request-path" value="${escapeHtml(request.path || '/')}" placeholder="./status">
        <span class="h23s-hint">Relative to the selected connection base URL. Absolute URLs are rejected.</span>
      </div>
      <div class="h23s-field-row">
        <div class="h23s-field">
          <label>Value Path</label>
          <input type="text" id="tile-generic-value-path" value="${escapeHtml(display.valuePath || '')}" placeholder="data.temperature">
        </div>
        <div class="h23s-field">
          <label>Status Path</label>
          <input type="text" id="tile-generic-status-path" value="${escapeHtml(display.statusPath || '')}" placeholder="status.label">
        </div>
      </div>
      <div class="h23s-field">
        <label>Subtitle Path</label>
        <input type="text" id="tile-generic-subtitle-path" value="${escapeHtml(display.subtitlePath || '')}" placeholder="data.summary">
      </div>
      <div class="h23s-field">
        <label>Metrics JSON</label>
        <textarea id="tile-generic-metrics-json" placeholder='[{"label":"Humidity","path":"data.humidity"}]'>${escapeHtml(prettyJson(display.metrics || []))}</textarea>
        <span class="h23s-hint">Array of <code>{ "label": "...", "path": "..." }</code>.</span>
      </div>
      <div class="h23s-field">
        <label>Actions JSON</label>
        <textarea id="tile-generic-actions-json" placeholder='[{"id":"toggle","label":"Toggle","method":"POST","path":"./toggle","confirmationText":"Send toggle command?","fields":[{"id":"state","label":"State","type":"text","defaultValue":"on","required":true}],"bodyTemplate":{"state":"$state"}}]'>${escapeHtml(prettyJson(config?.actions || []))}</textarea>
        <span class="h23s-hint">Advanced mode. Actions are server-side only and can declare typed inputs for the dashboard action dialog.</span>
      </div>
    `;
    return;
  }

  host.innerHTML = `
    <div class="h23s-inline-note">
      This template uses the selected Ecowitt connection and needs no extra tile-specific fields.
    </div>
  `;
}

function renderTileConnectionFields(connection = null) {
  const host = document.getElementById('tile-connection-fields');
  const type = document.getElementById('tile-connection-type')?.value;
  if (!host || !type) return;

  if (type === 'ecowitt') {
    host.innerHTML = `
      <div class="h23s-field-row">
        <div class="h23s-field">
          <label>Application Key</label>
          <input type="password" id="tile-conn-ecowitt-application-key" placeholder="${escapeHtml(connection?.maskedSecrets?.applicationKey || 'Paste application key')}">
        </div>
        <div class="h23s-field">
          <label>API Key</label>
          <input type="password" id="tile-conn-ecowitt-api-key" placeholder="${escapeHtml(connection?.maskedSecrets?.apiKey || 'Paste API key')}">
        </div>
      </div>
      <div class="h23s-field">
        <label>Device MAC</label>
        <input type="password" id="tile-conn-ecowitt-mac" placeholder="${escapeHtml(connection?.maskedSecrets?.mac || 'Paste device MAC')}">
      </div>
    `;
    return;
  }

  if (type === 'huum') {
    host.innerHTML = `
      <div class="h23s-field">
        <label>Base URL</label>
        <input type="text" id="tile-conn-huum-base-url" value="${escapeHtml(connection?.config?.baseUrl || '')}" placeholder="https://example.com/api">
      </div>
      <div class="h23s-field-row">
        <div class="h23s-field">
          <label>Username</label>
          <input type="password" id="tile-conn-huum-username" placeholder="${escapeHtml(connection?.maskedSecrets?.username || 'Paste username')}">
        </div>
        <div class="h23s-field">
          <label>Password</label>
          <input type="password" id="tile-conn-huum-password" placeholder="${escapeHtml(connection?.maskedSecrets?.password || 'Paste password')}">
        </div>
      </div>
    `;
    return;
  }

  const authType = connection?.config?.authType || 'none';
  host.innerHTML = `
    <div class="h23s-field">
      <label>Base URL</label>
      <input type="text" id="tile-conn-generic-base-url" value="${escapeHtml(connection?.config?.baseUrl || '')}" placeholder="https://api.example.com/v1/">
    </div>
    <div class="h23s-field-row">
      <div class="h23s-field">
        <label>Auth Type</label>
        <select id="tile-conn-generic-auth-type">
          ${(tileConnectionsState?.authTypes || ['none', 'basic', 'bearer', 'header']).map((option) => (
            `<option value="${option}" ${option === authType ? 'selected' : ''}>${option}</option>`
          )).join('')}
        </select>
      </div>
      <div class="h23s-field">
        <label>Header Name (for header auth)</label>
        <input type="text" id="tile-conn-generic-header-name" value="${escapeHtml(connection?.config?.headerName || '')}" placeholder="X-API-Key">
      </div>
    </div>
    <div class="h23s-field">
      <label>Static Headers JSON</label>
      <textarea id="tile-conn-generic-headers-json" placeholder='{"Accept":"application/json"}'>${escapeHtml(prettyJson(connection?.config?.headers || {}))}</textarea>
    </div>
    <div class="h23s-field-row">
      <div class="h23s-field">
        <label>Basic Auth Username</label>
        <input type="password" id="tile-conn-generic-username" placeholder="${escapeHtml(connection?.maskedSecrets?.username || 'Stored username')}">
      </div>
      <div class="h23s-field">
        <label>Basic Auth Password</label>
        <input type="password" id="tile-conn-generic-password" placeholder="${escapeHtml(connection?.maskedSecrets?.password || 'Stored password')}">
      </div>
    </div>
    <div class="h23s-field-row">
      <div class="h23s-field">
        <label>Bearer Token</label>
        <input type="password" id="tile-conn-generic-bearer-token" placeholder="${escapeHtml(connection?.maskedSecrets?.bearerToken || 'Stored bearer token')}">
      </div>
      <div class="h23s-field">
        <label>Header Secret Value</label>
        <input type="password" id="tile-conn-generic-header-value" placeholder="${escapeHtml(connection?.maskedSecrets?.headerValue || 'Stored header value')}">
      </div>
    </div>
  `;
}

function resetCustomTileForm() {
  editingCustomTileId = null;
  document.getElementById('custom-tile-builder-title').textContent = 'Tile Builder';
  document.getElementById('tile-title').value = '';
  const idInput = document.getElementById('tile-id');
  idInput.value = '';
  idInput.disabled = false;
  document.getElementById('tile-icon').value = '🌤';
  document.getElementById('tile-refresh-ms').value = 30000;
  document.getElementById('tile-size-default').value = 'third';
  populateTileModeSelect();
  document.getElementById('custom-tile-form-status').textContent = '';
}

function populateCustomTileForm(tile) {
  editingCustomTileId = tile.id;
  document.getElementById('custom-tile-builder-title').textContent = `Editing ${tile.title}`;
  document.getElementById('tile-title').value = tile.title;
  const idInput = document.getElementById('tile-id');
  idInput.value = tile.id;
  idInput.disabled = true;
  document.getElementById('tile-icon').value = tile.icon || '';
  document.getElementById('tile-refresh-ms').value = tile.refreshMs || 30000;
  document.getElementById('tile-size-default').value = tile.sizeDefault || 'third';
  populateTileModeSelect();
  document.getElementById('tile-mode').value = tile.mode;
  populateTileConnectionSelect(tile.connectionId);
  document.getElementById('tile-connection').value = tile.connectionId || '';
  renderTileModeFields(tile.config || {});
  document.getElementById('custom-tile-form-status').textContent = '';
}

function collectCustomTileForm() {
  const title = document.getElementById('tile-title').value.trim();
  if (!title) throw new Error('Tile title is required');

  const mode = document.getElementById('tile-mode').value;
  const connectionId = document.getElementById('tile-connection').value;
  if (!connectionId) throw new Error('Select a matching connection first');

  const tile = {
    id: editingCustomTileId || slugifyDraftId(document.getElementById('tile-id').value || title, 'tile'),
    title,
    icon: document.getElementById('tile-icon').value.trim() || '🧩',
    mode,
    connectionId,
    refreshMs: Number(document.getElementById('tile-refresh-ms').value || 30000),
    sizeDefault: document.getElementById('tile-size-default').value || 'third',
    config: {},
  };

  if (mode === 'huum-sauna') {
    tile.config = {
      startDefaults: {
        targetTemperature: Number(document.getElementById('tile-huum-start-temp').value || 190),
        duration: Number(document.getElementById('tile-huum-start-duration').value || 180),
      },
    };
  } else if (mode === 'generic-http-json') {
    const metrics = parseJsonField(document.getElementById('tile-generic-metrics-json').value, 'Metrics JSON', []);
    const actions = parseJsonField(document.getElementById('tile-generic-actions-json').value, 'Actions JSON', []);
    if (!Array.isArray(metrics)) throw new Error('Metrics JSON must be an array');
    if (!Array.isArray(actions)) throw new Error('Actions JSON must be an array');
    tile.config = {
      request: {
        path: document.getElementById('tile-generic-request-path').value.trim() || '/',
      },
      display: {
        valuePath: document.getElementById('tile-generic-value-path').value.trim(),
        statusPath: document.getElementById('tile-generic-status-path').value.trim(),
        subtitlePath: document.getElementById('tile-generic-subtitle-path').value.trim(),
        metrics,
      },
      actions,
    };
  }

  return tile;
}

function stageCustomTile() {
  const statusEl = document.getElementById('custom-tile-form-status');
  try {
    const tile = collectCustomTileForm();
    const existingIndex = (tilesState.customTiles || []).findIndex((entry) => entry.id === tile.id);
    if (existingIndex >= 0) {
      tilesState.customTiles.splice(existingIndex, 1, tile);
    } else {
      tilesState.customTiles.push(tile);
      tilesState.homeLayout.push({
        tileId: tile.id,
        enabled: true,
        size: tile.sizeDefault,
        tile,
      });
    }

    ensureTileLayoutCoverage();
    renderTilesLayoutList();
    renderCustomTilesList();
    statusEl.textContent = 'Draft saved';
    statusEl.style.color = 'var(--accent-green)';
    populateTileConnectionSelect(tile.connectionId);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function editCustomTile(tileId) {
  const tile = (tilesState?.customTiles || []).find((entry) => entry.id === tileId);
  if (!tile) return;
  populateCustomTileForm(tile);
}

function deleteCustomTile(tileId) {
  const tile = (tilesState?.customTiles || []).find((entry) => entry.id === tileId);
  if (!tile) return;
  if (!confirm(`Delete tile "${tile.title}"?`)) return;
  tilesState.customTiles = (tilesState.customTiles || []).filter((entry) => entry.id !== tileId);
  tilesState.homeLayout = (tilesState.homeLayout || []).filter((entry) => entry.tileId !== tileId);
  renderTilesLayoutList();
  renderCustomTilesList();
  if (editingCustomTileId === tileId) resetCustomTileForm();
}

function resetTileConnectionForm() {
  editingTileConnectionId = null;
  document.getElementById('tile-connection-builder-title').textContent = 'Connection Builder';
  document.getElementById('tile-connection-name').value = '';
  const idInput = document.getElementById('tile-connection-id');
  idInput.value = '';
  idInput.disabled = false;
  populateConnectionTypeSelect();
  document.getElementById('tile-connection-form-status').textContent = '';
}

function populateTileConnectionForm(connection) {
  editingTileConnectionId = connection.id;
  document.getElementById('tile-connection-builder-title').textContent = `Editing ${connection.name}`;
  document.getElementById('tile-connection-name').value = connection.name;
  const idInput = document.getElementById('tile-connection-id');
  idInput.value = connection.id;
  idInput.disabled = true;
  populateConnectionTypeSelect();
  document.getElementById('tile-connection-type').value = connection.type;
  renderTileConnectionFields(connection);
  document.getElementById('tile-connection-form-status').textContent = '';
}

function collectTileConnectionForm() {
  const name = document.getElementById('tile-connection-name').value.trim();
  if (!name) throw new Error('Connection name is required');

  const type = document.getElementById('tile-connection-type').value;
  const base = {
    id: editingTileConnectionId || slugifyDraftId(document.getElementById('tile-connection-id').value || name, 'connection'),
    name,
    type,
    config: {},
    secrets: {},
  };

  if (type === 'ecowitt') {
    const applicationKey = document.getElementById('tile-conn-ecowitt-application-key').value.trim();
    const apiKey = document.getElementById('tile-conn-ecowitt-api-key').value.trim();
    const mac = document.getElementById('tile-conn-ecowitt-mac').value.trim();
    if (!editingTileConnectionId && (!applicationKey || !apiKey || !mac)) {
      throw new Error('New Ecowitt connections require application key, API key, and MAC');
    }
    if (applicationKey) base.secrets.applicationKey = applicationKey;
    if (apiKey) base.secrets.apiKey = apiKey;
    if (mac) base.secrets.mac = mac;
    return base;
  }

  if (type === 'huum') {
    base.config.baseUrl = document.getElementById('tile-conn-huum-base-url').value.trim();
    const username = document.getElementById('tile-conn-huum-username').value.trim();
    const password = document.getElementById('tile-conn-huum-password').value.trim();
    if (!base.config.baseUrl) throw new Error('Base URL is required');
    if (!editingTileConnectionId && (!username || !password)) {
      throw new Error('New Huum connections require username and password');
    }
    if (username) base.secrets.username = username;
    if (password) base.secrets.password = password;
    return base;
  }

  base.config.baseUrl = document.getElementById('tile-conn-generic-base-url').value.trim();
  base.config.authType = document.getElementById('tile-conn-generic-auth-type').value;
  base.config.headerName = document.getElementById('tile-conn-generic-header-name').value.trim();
  base.config.headers = parseJsonField(document.getElementById('tile-conn-generic-headers-json').value, 'Headers JSON', {});
  if (Array.isArray(base.config.headers) || typeof base.config.headers !== 'object') {
    throw new Error('Headers JSON must be an object');
  }
  if (!base.config.baseUrl) throw new Error('Base URL is required');
  const username = document.getElementById('tile-conn-generic-username').value.trim();
  const password = document.getElementById('tile-conn-generic-password').value.trim();
  const bearerToken = document.getElementById('tile-conn-generic-bearer-token').value.trim();
  const headerValue = document.getElementById('tile-conn-generic-header-value').value.trim();
  if (username) base.secrets.username = username;
  if (password) base.secrets.password = password;
  if (bearerToken) base.secrets.bearerToken = bearerToken;
  if (headerValue) base.secrets.headerValue = headerValue;
  return base;
}

function stageTileConnection() {
  const statusEl = document.getElementById('tile-connection-form-status');
  try {
    const connection = collectTileConnectionForm();
    const existing = (tileConnectionsState.connections || []).find((entry) => entry.id === connection.id);
    const nextConnection = {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      config: connection.config,
      secrets: connection.secrets,
      maskedSecrets: existing?.maskedSecrets ? { ...existing.maskedSecrets } : {},
    };
    Object.entries(connection.secrets || {}).forEach(([key, value]) => {
      if (value) nextConnection.maskedSecrets[key] = maskSecretPreview(value);
    });

    const existingIndex = (tileConnectionsState.connections || []).findIndex((entry) => entry.id === connection.id);
    if (existingIndex >= 0) {
      tileConnectionsState.connections.splice(existingIndex, 1, nextConnection);
    } else {
      tileConnectionsState.connections.push(nextConnection);
    }

    renderTileConnectionsList();
    populateTileConnectionSelect();
    statusEl.textContent = 'Draft saved';
    statusEl.style.color = 'var(--accent-green)';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function editTileConnection(connectionId) {
  const connection = (tileConnectionsState?.connections || []).find((entry) => entry.id === connectionId);
  if (!connection) return;
  populateTileConnectionForm(connection);
}

function deleteTileConnection(connectionId) {
  const usedBy = (tilesState?.customTiles || []).filter((tile) => tile.connectionId === connectionId);
  if (usedBy.length > 0) {
    alert(`Connection is still used by ${usedBy.map((tile) => tile.title).join(', ')}.`);
    return;
  }
  if (!confirm(`Delete connection "${connectionId}"?`)) return;
  tileConnectionsState.connections = (tileConnectionsState.connections || []).filter((entry) => entry.id !== connectionId);
  renderTileConnectionsList();
  populateTileConnectionSelect();
  if (editingTileConnectionId === connectionId) resetTileConnectionForm();
}

function updateLayoutItem(tileId, patch) {
  const item = (tilesState?.homeLayout || []).find((entry) => entry.tileId === tileId);
  if (!item) return;
  Object.assign(item, patch);
}

function moveLayoutTile(dragId, dropId) {
  if (!dragId || !dropId || dragId === dropId) return;
  const layout = tilesState?.homeLayout || [];
  const fromIndex = layout.findIndex((entry) => entry.tileId === dragId);
  const toIndex = layout.findIndex((entry) => entry.tileId === dropId);
  if (fromIndex < 0 || toIndex < 0) return;
  const [entry] = layout.splice(fromIndex, 1);
  layout.splice(toIndex, 0, entry);
  renderTilesLayoutList();
}

async function saveTilesSettings() {
  const statusEl = document.getElementById('tiles-status');
  statusEl.textContent = 'Saving...';
  try {
    const payload = {
      version: 1,
      homeLayout: (tilesState.homeLayout || []).map((item) => ({
        tileId: item.tileId,
        enabled: item.enabled !== false,
        size: item.size,
      })),
      customTiles: tilesState.customTiles || [],
    };

    const res = await fetch(`${API}/tiles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiles: payload }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    statusEl.textContent = 'Saved · hot-applied';
    statusEl.style.color = 'var(--accent-green)';
    await loadTilesPanel();
    broadcastTilesUpdate();
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

async function saveTileConnections() {
  const statusEl = document.getElementById('tile-connections-status');
  statusEl.textContent = 'Saving...';
  try {
    const payload = {
      connections: (tileConnectionsState.connections || []).map((connection) => ({
        id: connection.id,
        name: connection.name,
        type: connection.type,
        config: connection.config,
        secrets: connection.secrets || {},
      })),
    };

    const res = await fetch(`${API}/tile-connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connections: payload }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    statusEl.textContent = 'Saved · hot-applied';
    statusEl.style.color = 'var(--accent-green)';
    await loadTilesPanel();
    broadcastTilesUpdate();
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function setupTilesHandlers() {
  document.getElementById('btn-new-custom-tile')?.addEventListener('click', resetCustomTileForm);
  document.getElementById('btn-stage-custom-tile')?.addEventListener('click', stageCustomTile);
  document.getElementById('btn-reset-custom-tile')?.addEventListener('click', resetCustomTileForm);
  document.getElementById('btn-save-tiles')?.addEventListener('click', saveTilesSettings);

  document.getElementById('btn-new-tile-connection')?.addEventListener('click', resetTileConnectionForm);
  document.getElementById('btn-stage-tile-connection')?.addEventListener('click', stageTileConnection);
  document.getElementById('btn-reset-tile-connection')?.addEventListener('click', resetTileConnectionForm);
  document.getElementById('btn-save-tile-connections')?.addEventListener('click', saveTileConnections);

  document.getElementById('tile-title')?.addEventListener('input', () => {
    if (editingCustomTileId) return;
    const idInput = document.getElementById('tile-id');
    if (!idInput.value.trim()) {
      idInput.value = slugifyDraftId(document.getElementById('tile-title').value, 'tile');
    }
  });

  document.getElementById('tile-connection-name')?.addEventListener('input', () => {
    if (editingTileConnectionId) return;
    const idInput = document.getElementById('tile-connection-id');
    if (!idInput.value.trim()) {
      idInput.value = slugifyDraftId(document.getElementById('tile-connection-name').value, 'connection');
    }
  });

  document.getElementById('tile-mode')?.addEventListener('change', () => {
    populateTileConnectionSelect();
    renderTileModeFields();
  });
  document.getElementById('tile-connection-type')?.addEventListener('change', () => renderTileConnectionFields());

  document.getElementById('custom-tiles-list')?.addEventListener('click', (event) => {
    const editBtn = event.target.closest('[data-edit-custom-tile]');
    if (editBtn) return editCustomTile(editBtn.dataset.editCustomTile);
    const deleteBtn = event.target.closest('[data-delete-custom-tile]');
    if (deleteBtn) return deleteCustomTile(deleteBtn.dataset.deleteCustomTile);
  });

  document.getElementById('tile-connections-list')?.addEventListener('click', (event) => {
    const editBtn = event.target.closest('[data-edit-tile-connection]');
    if (editBtn) return editTileConnection(editBtn.dataset.editTileConnection);
    const deleteBtn = event.target.closest('[data-delete-tile-connection]');
    if (deleteBtn) return deleteTileConnection(deleteBtn.dataset.deleteTileConnection);
  });

  const layoutHost = document.getElementById('tiles-layout-list');
  layoutHost?.addEventListener('change', (event) => {
    const row = event.target.closest('[data-layout-tile-id]');
    if (!row) return;
    const tileId = row.dataset.layoutTileId;
    if (event.target.matches('[data-layout-enabled]')) {
      updateLayoutItem(tileId, { enabled: event.target.checked });
    }
    if (event.target.matches('[data-layout-size]')) {
      updateLayoutItem(tileId, { size: event.target.value });
    }
  });

  layoutHost?.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-layout-tile-id]');
    if (!row) return;
    layoutDragTileId = row.dataset.layoutTileId;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });

  layoutHost?.addEventListener('dragend', () => {
    layoutDragTileId = null;
    document.querySelectorAll('.h23s-layout-row').forEach((row) => row.classList.remove('dragging', 'drop-target'));
  });

  layoutHost?.addEventListener('dragover', (event) => {
    const row = event.target.closest('[data-layout-tile-id]');
    if (!row) return;
    event.preventDefault();
    document.querySelectorAll('.h23s-layout-row').forEach((entry) => entry.classList.remove('drop-target'));
    row.classList.add('drop-target');
  });

  layoutHost?.addEventListener('drop', (event) => {
    const row = event.target.closest('[data-layout-tile-id]');
    if (!row) return;
    event.preventDefault();
    moveLayoutTile(layoutDragTileId, row.dataset.layoutTileId);
  });
}

function setupFeederHandlers() {
  document.getElementById('btn-save-feeder')?.addEventListener('click', saveFeeder);
  document.getElementById('btn-feeder-refresh')?.addEventListener('click', loadFeederLiveStatus);
  document.getElementById('btn-feeder-flush')?.addEventListener('click', feederForceFlush);
  document.getElementById('btn-feeder-restart-engine')?.addEventListener('click', restartEngine);
  document.getElementById('btn-fd-add-path')?.addEventListener('click', () => {
    const host = document.getElementById('fd-watch-paths');
    if (host.querySelector('em')) host.innerHTML = '';
    const idx = host.querySelectorAll('[data-fd-path-row]').length;
    host.insertAdjacentHTML('beforeend', renderWatchPathRow({}, idx));
  });
  document.getElementById('fd-watch-paths')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fd-remove-path]');
    if (!btn) return;
    btn.closest('[data-fd-path-row]')?.remove();
  });
  setupFeederDropzone();
}

// ── Onboarding ──

let onboardingActive = false;
let onboardingStep = 1;
let onboardingProviderPollTimer = null;
let onboardingCreatedAgent = null;

/**
 * Check if this is a first-run scenario:
 *  - No providers configured
 *  - No agents exist
 */
async function checkOnboarding() {
  try {
    const [provRes, agentRes, oauthRes] = await Promise.all([
      fetch(`${API}/providers`),
      fetch(`${API}/agents`),
      fetch(`${API}/oauth/status`).catch(() => null),
    ]);
    const provData = await provRes.json();
    const agentData = await agentRes.json();

    const hasApiKey = Object.values(provData.providers || {}).some(p => p.hasKey || p.configured);
    let hasOAuth = false;
    if (oauthRes && oauthRes.ok) {
      const oauthData = await oauthRes.json();
      hasOAuth = (oauthData.anthropic?.configured && oauthData.anthropic?.valid)
              || (oauthData.openaiCodex?.configured && oauthData.openaiCodex?.valid);
    }
    const hasProvider = hasApiKey || hasOAuth;
    const hasAgent = (agentData.agents || []).length > 0;

    return !hasProvider && !hasAgent;
  } catch (err) {
    console.warn('Onboarding check failed:', err);
    return false;
  }
}

function showOnboarding() {
  onboardingActive = true;
  onboardingStep = 1;

  // Hide normal settings UI
  document.querySelector('.h23s-tabs').style.display = 'none';
  document.querySelectorAll('.h23s-panel').forEach(p => p.classList.remove('active'));

  // Show onboarding overlay
  const overlay = document.getElementById('onboarding-overlay');
  overlay.style.display = 'block';

  // Populate step 1 with OAuth cards (clone them so originals stay intact for tabbed view)
  populateOnboardingProviders();

  updateOnboardingStep();
  startOnboardingProviderPoll();
}

function hideOnboarding() {
  onboardingActive = false;
  stopOnboardingProviderPoll();

  // Restore OAuth cards to original location if they were moved
  restoreOAuthCards();

  // Restore wizard to original location
  restoreWizard();

  // Hide overlay, show normal settings
  document.getElementById('onboarding-overlay').style.display = 'none';
  document.querySelector('.h23s-tabs').style.display = '';

  // Activate the first tab
  document.querySelectorAll('.h23s-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.h23s-panel').forEach(p => p.classList.remove('active'));
  const firstTab = document.querySelector('.h23s-tab[data-stab="providers"]');
  if (firstTab) firstTab.classList.add('active');
  document.getElementById('panel-providers')?.classList.add('active');

  // Reload data for the normal view
  loadProviders();
  loadAgents();
  loadOAuthStatus();
}

function populateOnboardingProviders() {
  const oauthHost = document.getElementById('ob-oauth-host');
  const apikeysHost = document.getElementById('ob-apikeys-host');

  // Move the real OAuth cards into onboarding (they carry their existing IDs + event listeners)
  const anthropicCard = document.getElementById('anthropic-oauth-card');
  const codexCard = document.getElementById('codex-oauth-card');
  if (anthropicCard) oauthHost.appendChild(anthropicCard);
  if (codexCard) oauthHost.appendChild(codexCard);

  // Build API key inputs for onboarding
  const order = SETTINGS_PROVIDER_ORDER;
  apikeysHost.innerHTML = order.map(name => `
    <div class="h23s-provider-card" style="padding:12px 16px;margin-bottom:8px;">
      <div class="h23s-provider-header" style="margin-bottom:8px;">
        <span class="h23s-provider-name">${PROVIDER_DISPLAY[name] || name}</span>
        <div class="h23s-provider-status" id="ob-prov-status-${name}">
          <span class="h23s-status-dot"></span>
          <span>Not configured</span>
        </div>
      </div>
      <div class="h23s-provider-key-row">
        <input type="password" id="ob-prov-key-${name}" placeholder="Paste API key...">
        <button class="h23s-btn-secondary" onclick="obTestProvider('${name}')" style="padding:6px 12px;font-size:12px;">Test</button>
      </div>
    </div>
  `).join('');
}

function restoreOAuthCards() {
  // Move OAuth cards back to the original providers panel oauth section
  const oauthSection = document.getElementById('oauth-section');
  const anthropicCard = document.getElementById('anthropic-oauth-card');
  const codexCard = document.getElementById('codex-oauth-card');
  if (oauthSection) {
    if (anthropicCard) oauthSection.appendChild(anthropicCard);
    if (codexCard) oauthSection.appendChild(codexCard);
  }
}

function restoreWizard() {
  // Restore original wizard event handlers
  const cancelBtn = document.getElementById('wiz-cancel');
  if (cancelBtn && cancelBtn._obHandler) {
    cancelBtn.removeEventListener('click', cancelBtn._obHandler);
    cancelBtn.addEventListener('click', hideWizard);
    delete cancelBtn._obHandler;
  }
  const createBtn = document.getElementById('wiz-create');
  if (createBtn && createBtn._obHandler) {
    createBtn.removeEventListener('click', createBtn._obHandler);
    createBtn.addEventListener('click', createAgent);
    delete createBtn._obHandler;
  }

  // Move wizard back to the agents panel
  const wizard = document.getElementById('agent-wizard');
  const agentsPanel = document.getElementById('panel-agents');
  if (wizard && agentsPanel) {
    agentsPanel.appendChild(wizard);
    wizard.style.display = 'none';
  }
}

function updateOnboardingStep() {
  // Update step indicators
  document.querySelectorAll('.h23s-onboarding-step').forEach(s => {
    const step = parseInt(s.dataset.obStep);
    s.classList.remove('active', 'done');
    if (step === onboardingStep) s.classList.add('active');
    if (step < onboardingStep) s.classList.add('done');
  });

  // Update connector lines
  const lines = document.querySelectorAll('.h23s-onboarding-step-line');
  lines.forEach((line, i) => {
    line.classList.toggle('done', i + 1 < onboardingStep);
  });

  // Show the active page
  document.querySelectorAll('.h23s-onboarding-page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`ob-step-${onboardingStep}`);
  if (page) page.classList.add('active');
}

// Provider poll — detect OAuth completing in another tab
function startOnboardingProviderPoll() {
  stopOnboardingProviderPoll();
  checkOnboardingProviderGate();
  onboardingProviderPollTimer = setInterval(checkOnboardingProviderGate, 3000);
}

function stopOnboardingProviderPoll() {
  if (onboardingProviderPollTimer) {
    clearInterval(onboardingProviderPollTimer);
    onboardingProviderPollTimer = null;
  }
}

async function checkOnboardingProviderGate() {
  try {
    const [provRes, oauthRes] = await Promise.all([
      fetch(`${API}/providers`),
      fetch(`${API}/oauth/status`),
    ]);
    const provData = await provRes.json();
    const oauthData = await oauthRes.json();

    const hasApiKey = Object.values(provData.providers || {}).some(p => p.hasKey);
    const hasOAuth = (oauthData.anthropic?.configured && oauthData.anthropic?.valid)
                  || (oauthData.openaiCodex?.configured && oauthData.openaiCodex?.valid);

    const gate = document.getElementById('ob-provider-gate');
    const nextBtn = document.getElementById('ob-next-1');
    const satisfied = hasApiKey || hasOAuth;

    if (gate) {
      if (satisfied) {
        gate.classList.add('satisfied');
        gate.innerHTML = '<span class="h23s-status-dot ok"></span> <span>Provider configured</span>';
      } else {
        gate.classList.remove('satisfied');
        gate.innerHTML = '<span class="h23s-status-dot"></span> <span>Configure at least one provider to continue</span>';
      }
    }
    if (nextBtn) nextBtn.disabled = !satisfied;

    // Also refresh OAuth card statuses
    renderOAuthCard('anthropic', oauthData.anthropic || {});
    renderOAuthCard('codex', oauthData.openaiCodex || {});
  } catch (err) {
    console.warn('Provider gate check failed:', err);
  }
}

async function obTestProvider(name) {
  const keyInput = document.getElementById(`ob-prov-key-${name}`);
  const statusEl = document.getElementById(`ob-prov-status-${name}`);
  if (!keyInput || !statusEl) return;

  const key = keyInput.value.trim();
  if (!key) {
    statusEl.innerHTML = '<span class="h23s-status-dot fail"></span> <span>Enter a key first</span>';
    return;
  }

  statusEl.innerHTML = '<span class="h23s-status-dot"></span> <span>Testing...</span>';

  try {
    const res = await fetch(`${API}/providers/${name}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.innerHTML = '<span class="h23s-status-dot ok"></span> <span>Connected</span>';
    } else {
      statusEl.innerHTML = `<span class="h23s-status-dot fail"></span> <span>Failed: ${data.error || data.status}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="h23s-status-dot fail"></span> <span>Error: ${err.message}</span>`;
  }
}

async function obSaveKeys() {
  const providers = {};
  for (const name of PROVIDERS_WITH_API_KEYS) {
    const input = document.getElementById(`ob-prov-key-${name}`);
    if (input && input.value.trim()) {
      providers[name] = { apiKey: input.value.trim() };
    }
  }

  if (Object.keys(providers).length === 0) {
    const statusEl = document.getElementById('ob-keys-status');
    statusEl.textContent = 'Enter at least one API key';
    statusEl.style.color = 'var(--accent-red)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    return;
  }

  const statusEl = document.getElementById('ob-keys-status');
  try {
    const res = await fetch(`${API}/providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = 'Saved';
      statusEl.style.color = 'var(--accent-green)';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
      // Re-check the gate immediately
      checkOnboardingProviderGate();
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function goToOnboardingStep(step) {
  onboardingStep = step;
  updateOnboardingStep();

  if (step === 1) {
    startOnboardingProviderPoll();
  } else {
    stopOnboardingProviderPoll();
  }

  if (step === 2) {
    setupOnboardingWizard();
  }

  if (step === 3) {
    populateOnboardingLaunchSummary();
  }
}

function setupOnboardingWizard() {
  // Move the existing wizard into the onboarding host
  const wizard = document.getElementById('agent-wizard');
  const host = document.getElementById('ob-wizard-host');

  if (wizard && host) {
    host.appendChild(wizard);
    wizard.style.display = 'block';

    // Reset to step 1 and show the primary banner
    wizardStep = 1;
    updateWizardStep();
    const banner = document.getElementById('wiz-primary-banner');
    if (banner) banner.style.display = 'block';

    // Pre-fill timezone
    document.getElementById('wiz-timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

    // Override the cancel button to go back to onboarding step 1
    const cancelBtn = document.getElementById('wiz-cancel');
    if (cancelBtn) {
      if (cancelBtn._obHandler) cancelBtn.removeEventListener('click', cancelBtn._obHandler);
      cancelBtn.removeEventListener('click', hideWizard);
      cancelBtn._obHandler = () => goToOnboardingStep(1);
      cancelBtn.addEventListener('click', cancelBtn._obHandler);
    }

    // Override the create button to capture the created agent and advance
    const createBtn = document.getElementById('wiz-create');
    if (createBtn) {
      if (createBtn._obHandler) createBtn.removeEventListener('click', createBtn._obHandler);
      createBtn.removeEventListener('click', createAgent);
      createBtn._obHandler = () => obCreateAgent();
      createBtn.addEventListener('click', createBtn._obHandler);
    }
  }
}

async function obCreateAgent() {
  const body = {
    name: document.getElementById('wiz-name').value.trim(),
    displayName: document.getElementById('wiz-display-name').value.trim(),
    ownerName: document.getElementById('wiz-owner').value.trim(),
    timezone: document.getElementById('wiz-timezone').value.trim(),
    botToken: document.getElementById('wiz-bot-token').value.trim(),
    ownerTelegramId: document.getElementById('wiz-telegram-id').value.trim(),
    provider: document.getElementById('wiz-provider').value,
    model: document.getElementById('wiz-model').value,
  };

  if (!body.name || !/^[a-z0-9][a-z0-9-]*$/.test(body.name)) {
    alert('Agent name must be lowercase alphanumeric with hyphens');
    return;
  }

  const btn = document.getElementById('wiz-create');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      onboardingCreatedAgent = {
        name: body.name,
        displayName: body.displayName || body.name,
        provider: body.provider,
        model: body.model,
      };
      goToOnboardingStep(3);
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Failed to create agent: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = 'Create Agent';
}

function populateOnboardingLaunchSummary() {
  const summary = document.getElementById('ob-summary');
  if (!summary || !onboardingCreatedAgent) return;

  const a = onboardingCreatedAgent;
  const provLabel = PROVIDER_DISPLAY[a.provider] || a.provider || '?';

  summary.innerHTML = `
    <div class="h23s-onboarding-summary-row">
      <span class="h23s-onboarding-summary-label">Agent</span>
      <span class="h23s-onboarding-summary-value">${a.displayName || a.name}</span>
    </div>
    <div class="h23s-onboarding-summary-row">
      <span class="h23s-onboarding-summary-label">Provider</span>
      <span class="h23s-onboarding-summary-value">${provLabel}</span>
    </div>
    <div class="h23s-onboarding-summary-row">
      <span class="h23s-onboarding-summary-label">Model</span>
      <span class="h23s-onboarding-summary-value">${a.model || 'default'}</span>
    </div>
  `;
}

async function obLaunchAgent() {
  if (!onboardingCreatedAgent) return;
  const name = onboardingCreatedAgent.name;
  const btn = document.getElementById('ob-launch');
  const statusEl = document.getElementById('ob-launch-status');

  btn.disabled = true;
  btn.textContent = 'Starting...';
  statusEl.textContent = 'Launching cognitive engine, dashboard, and harness...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    const res = await fetch(`${API}/agents/${name}/start`, { method: 'POST' });
    const data = await res.json();

    if (data.ok || data.status === 'started') {
      statusEl.textContent = 'Agent started. Redirecting to dashboard...';
      statusEl.style.color = 'var(--accent-green)';

      // Get the agent's dashboard port to redirect
      try {
        const agentRes = await fetch(`${API}/agents`);
        const agentData = await agentRes.json();
        const agent = (agentData.agents || []).find(a => a.name === name);
        if (agent?.ports?.dashboard) {
          setTimeout(() => {
            window.location.href = `http://${window.location.hostname}:${agent.ports.dashboard}/home23`;
          }, 1500);
          return;
        }
      } catch { /* fall through to default redirect */ }

      // Fallback: redirect to current host /home23
      setTimeout(() => { window.location.href = '/home23'; }, 1500);
    } else {
      statusEl.textContent = 'Start may have failed: ' + (data.error || 'unknown status');
      statusEl.style.color = 'var(--accent-red)';
      btn.disabled = false;
      btn.textContent = 'Retry Start';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
    btn.disabled = false;
    btn.textContent = 'Retry Start';
  }
}

function setupOnboardingHandlers() {
  document.getElementById('ob-next-1')?.addEventListener('click', () => goToOnboardingStep(2));
  document.getElementById('ob-save-keys')?.addEventListener('click', obSaveKeys);
  document.getElementById('ob-launch')?.addEventListener('click', obLaunchAgent);
}

// ── Cognitive Assignments (per-slot modelAssignments editor) ──

let assignmentsData = null;

// What each slot actually does, and what to optimize for when picking a model.
// Keep descriptions short (1 line) and guidance pragmatic.
const SLOT_META = {
  'default': {
    label: 'Default (catch-all)',
    desc: 'Used by any engine call that does not specify a component/purpose.',
    pick: 'Safe, cheap, fast. Treat as a last-resort fallback — most real calls should route to a specific slot.',
  },
  'quantumReasoner.branches': {
    label: 'Cognitive cycle branches',
    desc: 'The parallel LLM calls inside every cognitive cycle — curiosity, analyst, critic, proposal roles run here (5–10 branches at once).',
    pick: 'High-volume, bursty. Favor FAST + cheap models that handle concurrency without rate-limit errors. This is 60–80% of engine tokens.',
  },
  'quantumReasoner.singleReasoning': {
    label: 'Dreams + single-shot fallback',
    desc: 'Deep-reasoning path used for dreams and when all parallel branches fail. Lower volume, longer outputs.',
    pick: 'Favor QUALITY over speed. A strong reasoning model (Opus, GPT-5.4, MiniMax-M2.7) makes dreams worth reading.',
  },
  'agents.research': {
    label: 'Research agent — primary',
    desc: 'Research sub-agents launched via the research_* tools. Initial investigation pass that produces findings.',
    pick: 'Favor accuracy + grounding. Models with web search or strong knowledge (grok-4, claude-opus, gpt-5.5).',
  },
  'agents.research-synthesis': {
    label: 'Research synthesis',
    desc: 'Final synthesis step that turns raw research findings into a coherent brief.',
    pick: 'Favor long context + writing quality. Claude-opus or GPT-5.4 shine here.',
  },
  'agents.research-fallback': {
    label: 'Research agent — fallback',
    desc: 'Cheaper fallback when the primary research agent errors or rate-limits.',
    pick: 'Cheap and reliable. Does not need to be strong — just reachable.',
  },
  'agents.analytical': {
    label: 'Analytical agent',
    desc: 'Compares, contrasts, and evaluates evidence across brain nodes.',
    pick: 'Balanced reasoning model. MiniMax-M2.7, nemotron-super, claude-sonnet.',
  },
  'agents.discovery': {
    label: 'Discovery agent',
    desc: 'Finds unexpected connections or latent patterns across memory nodes.',
    pick: 'Creative reasoning. Grok, claude-opus, MiniMax-M2.7.',
  },
  'agents.clustering': {
    label: 'Clustering agent',
    desc: 'Groups memory nodes into semantic clusters. Structural work.',
    pick: 'Cheap is fine. Small models work.',
  },
  'agents.synthesis': {
    label: 'Synthesis agent',
    desc: 'Intelligence-tab curated insights + memory consolidation. Writes the long-form summaries you actually read.',
    pick: 'Favor QUALITY. This is the output you see. Claude-opus / GPT-5.4 / MiniMax-M2.7.',
  },
  'agents.quality_assurance': {
    label: 'QA agent',
    desc: 'Verifies agent outputs against source material. Catches hallucinations.',
    pick: 'Cheap + literal. Small fast models are ideal (they just check, not invent).',
  },
  'agents': {
    label: 'Agents — generic',
    desc: 'Catch-all for any agent call without a specific purpose label.',
    pick: 'Match to your most common agent workload.',
  },
  'coordinator': {
    label: 'Coordinator',
    desc: 'Reviews recent cycles every N rounds, provides strategic oversight, decides when the brain should change direction.',
    pick: 'Favor QUALITY. A weak coordinator produces weak strategy. Claude-opus / GPT-5.4.',
  },
  'goalCurator': {
    label: 'Goal curator',
    desc: 'Prunes active goals — keeps, defers, or drops them based on progress and relevance.',
    pick: 'Balanced. Needs judgment but not deep reasoning.',
  },
  'intrinsicGoals': {
    label: 'Intrinsic goal generator',
    desc: 'Proposes new goals the agent should pursue on its own initiative.',
    pick: 'Creative reasoning. A dull model here gives a dull agent.',
  },
};

function assignmentGroup(key) {
  if (key.startsWith('quantumReasoner')) return 'Cognition — Quantum Reasoner';
  if (key.startsWith('agents.')) return 'Agents';
  if (key === 'agents') return 'Agents';
  if (key.startsWith('coordinator')) return 'Coordination';
  if (key === 'goalCurator' || key === 'intrinsicGoals') return 'Goals';
  if (key === 'default') return 'Default';
  return 'Other';
}

function providerModelOptions(providers, selectedProvider, selectedModel) {
  const provOpts = Object.keys(providers || {})
    .map(p => `<option value="${p}" ${p === selectedProvider ? 'selected' : ''}>${PROVIDER_DISPLAY[p] || p}</option>`)
    .join('');
  const models = providers?.[selectedProvider] || [];
  const modelOpts = models
    .map(m => `<option value="${m}" ${m === selectedModel ? 'selected' : ''}>${m}</option>`)
    .join('');
  return { provOpts, modelOpts };
}

function renderFallbackRow(providers, item, rowIdx, fbIdx) {
  const { provOpts, modelOpts } = providerModelOptions(providers, item.provider, item.model);
  return `
    <div class="h23s-assign-fb" data-fb-idx="${fbIdx}" style="display:flex;gap:6px;align-items:center;margin-top:4px;padding-left:20px;">
      <span style="font-size:11px;color:var(--text-muted);min-width:60px;">Fallback ${fbIdx + 1}</span>
      <select data-assign-fb-provider style="flex:0 0 140px;font-size:12px;">${provOpts}</select>
      <select data-assign-fb-model style="flex:1;font-size:12px;">${modelOpts}</select>
      <button class="h23s-btn-danger" data-assign-fb-remove style="padding:3px 8px;font-size:11px;">x</button>
    </div>
  `;
}

function renderAssignmentRow(key, entry, providers, rowIdx) {
  const { provOpts, modelOpts } = providerModelOptions(providers, entry.provider, entry.model);
  const fallbackHtml = (entry.fallback || []).map((f, i) => renderFallbackRow(providers, f, rowIdx, i)).join('');
  const meta = SLOT_META[key] || { label: key, desc: '', pick: '' };
  const infoBody = meta.desc || meta.pick
    ? `
      <div class="h23s-assign-info" data-assign-info style="display:none;font-size:12px;color:var(--text-secondary);line-height:1.45;padding:8px 10px;margin:6px 0;background:rgba(255,255,255,0.03);border-left:2px solid var(--accent-blue);border-radius:0 6px 6px 0;">
        ${meta.desc ? `<div style="margin-bottom:4px;">${escapeSlotText(meta.desc)}</div>` : ''}
        ${meta.pick ? `<div style="color:var(--text-muted);"><strong style="color:var(--text-primary);">Pick:</strong> ${escapeSlotText(meta.pick)}</div>` : ''}
      </div>`
    : '';
  return `
    <div class="h23s-assign-row" data-assign-key="${key}" data-assign-idx="${rowIdx}" style="background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:8px;padding:10px 12px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;color:var(--text-primary);font-weight:600;">${escapeSlotText(meta.label)}</div>
          <code style="font-size:11px;color:var(--text-muted);font-family:'SF Mono','Fira Code',monospace;">${key}</code>
        </div>
        <button type="button" class="h23s-btn-secondary" data-assign-info-toggle style="padding:3px 9px;font-size:11px;" title="What this slot does">?</button>
      </div>
      ${infoBody}
      <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
        <span style="font-size:11px;color:var(--text-muted);min-width:60px;">Primary</span>
        <select data-assign-provider style="flex:0 0 140px;font-size:12px;">${provOpts}</select>
        <select data-assign-model style="flex:1;font-size:12px;">${modelOpts}</select>
      </div>
      <div data-assign-fb-list>${fallbackHtml}</div>
      <button class="h23s-btn-secondary" data-assign-add-fb style="padding:3px 10px;font-size:11px;margin-top:6px;margin-left:68px;">+ Add Fallback</button>
    </div>
  `;
}

function escapeSlotText(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadAssignments() {
  try {
    const res = await fetch(settingsApiUrl('/model-assignments', { agentScoped: true }));
    assignmentsData = await res.json();
    renderAssignments(assignmentsData);
  } catch (err) {
    console.error('Failed to load model assignments:', err);
  }
}

function renderAssignments(data) {
  const list = document.getElementById('model-assignments-list');
  if (!list) return;
  const providers = data.providers || {};
  const effective = data.effective || {};

  // Group keys for readability. pulseVoice has its own dedicated UI
  // (provider + model + prompt editor) so exclude it from the generic
  // assignment grid to avoid confusing duplication.
  const EXCLUDED_FROM_GRID = new Set(['pulseVoice', 'pulseVoice.remark']);
  const groups = {};
  for (const key of Object.keys(effective)) {
    if (EXCLUDED_FROM_GRID.has(key)) continue;
    const g = assignmentGroup(key);
    if (!groups[g]) groups[g] = [];
    groups[g].push(key);
  }
  const groupOrder = ['Cognition — Quantum Reasoner', 'Agents', 'Coordination', 'Goals', 'Default', 'Other'];
  let rowIdx = 0;
  const html = groupOrder
    .filter(g => groups[g])
    .map(g => {
      const rows = groups[g].sort().map(key => {
        const html = renderAssignmentRow(key, effective[key], providers, rowIdx);
        rowIdx++;
        return html;
      }).join('');
      return `
        <div class="h23s-assign-group">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);padding:8px 0 4px;">${g}</div>
          ${rows}
        </div>
      `;
    })
    .join('');
  list.innerHTML = html || '<div style="padding:12px;color:var(--text-muted);font-style:italic;">No assignment slots defined in base-engine.yaml</div>';

  // Wire up per-row interactions
  list.querySelectorAll('.h23s-assign-row').forEach(row => bindAssignmentRow(row, providers));
}

function bindAssignmentRow(row, providers) {
  const provSel = row.querySelector('[data-assign-provider]');
  const modelSel = row.querySelector('[data-assign-model]');

  provSel.addEventListener('change', () => {
    repopulateModelSelect(modelSel, providers, provSel.value, '');
  });

  const infoBtn = row.querySelector('[data-assign-info-toggle]');
  const infoBody = row.querySelector('[data-assign-info]');
  if (infoBtn && infoBody) {
    infoBtn.addEventListener('click', () => {
      const shown = infoBody.style.display !== 'none';
      infoBody.style.display = shown ? 'none' : 'block';
    });
  }

  row.querySelector('[data-assign-add-fb]').addEventListener('click', () => {
    const list = row.querySelector('[data-assign-fb-list]');
    const idx = list.querySelectorAll('.h23s-assign-fb').length;
    const firstProvider = Object.keys(providers)[0] || '';
    const tpl = document.createElement('div');
    tpl.innerHTML = renderFallbackRow(providers, { provider: firstProvider, model: (providers[firstProvider] || [])[0] || '' }, 0, idx);
    const fbRow = tpl.firstElementChild;
    list.appendChild(fbRow);
    bindFallbackRow(fbRow, providers);
  });

  row.querySelectorAll('.h23s-assign-fb').forEach(fb => bindFallbackRow(fb, providers));
}

function bindFallbackRow(fb, providers) {
  const provSel = fb.querySelector('[data-assign-fb-provider]');
  const modelSel = fb.querySelector('[data-assign-fb-model]');
  provSel.addEventListener('change', () => {
    repopulateModelSelect(modelSel, providers, provSel.value, '');
  });
  fb.querySelector('[data-assign-fb-remove]').addEventListener('click', () => {
    fb.remove();
  });
}

function repopulateModelSelect(selectEl, providers, provName, preferModel) {
  const models = providers?.[provName] || [];
  selectEl.innerHTML = models
    .map(m => `<option value="${m}" ${m === preferModel ? 'selected' : ''}>${m}</option>`)
    .join('');
}

function collectAssignments() {
  const rows = document.querySelectorAll('.h23s-assign-row');
  const out = {};
  rows.forEach(row => {
    const key = row.dataset.assignKey;
    const provider = row.querySelector('[data-assign-provider]')?.value;
    const model = row.querySelector('[data-assign-model]')?.value;
    if (!key || !provider || !model) return;
    const fallback = [];
    row.querySelectorAll('.h23s-assign-fb').forEach(fb => {
      const p = fb.querySelector('[data-assign-fb-provider]')?.value;
      const m = fb.querySelector('[data-assign-fb-model]')?.value;
      if (p && m) fallback.push({ provider: p, model: m });
    });
    out[key] = { provider, model, fallback };
  });
  return out;
}

async function saveAssignments() {
  const statusEl = document.getElementById('assignments-status');
  statusEl.textContent = 'Saving…';
  statusEl.style.color = '';
  const assignments = collectAssignments();
  try {
    const res = await fetch(`${API}/model-assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: selectedSettingsAgent, assignments }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = `Saved for ${selectedAgentLabel()} (${data.overrideCount} override${data.overrideCount === 1 ? '' : 's'}). Engine restarting.`;
      statusEl.style.color = 'var(--accent-green)';
      setTimeout(() => loadAssignments(), 1500);
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

async function resetAssignments() {
  if (!confirm(`Reset all cognitive assignments for ${selectedAgentLabel()} to the base-engine.yaml defaults? The engine will restart.`)) return;
  const statusEl = document.getElementById('assignments-status');
  statusEl.textContent = 'Resetting…';
  statusEl.style.color = '';
  try {
    const res = await fetch(`${API}/model-assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: selectedSettingsAgent, assignments: {} }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = `Reset for ${selectedAgentLabel()}. Engine restarting.`;
      statusEl.style.color = 'var(--accent-green)';
      setTimeout(() => loadAssignments(), 1500);
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ── Pulse Voice (remark layer) ──

let pulseVoiceData = null;
let pulseVoiceDefaultPrompt = '';

async function loadPulseVoice() {
  try {
    const res = await fetch(settingsApiUrl('/pulse-voice', { agentScoped: true }));
    pulseVoiceData = await res.json();
    pulseVoiceDefaultPrompt = pulseVoiceData.defaultPrompt || '';
    renderPulseVoice(pulseVoiceData);
  } catch (err) {
    console.error('Failed to load pulse-voice config:', err);
  }
}

function renderPulseVoice(data) {
  const provSel = document.getElementById('pulse-voice-provider');
  const modelSel = document.getElementById('pulse-voice-model');
  const prompt = document.getElementById('pulse-voice-prompt');
  if (!provSel || !modelSel || !prompt) return;

  const providers = data.providers || {};
  provSel.innerHTML = Object.keys(providers).map(p =>
    `<option value="${p}" ${p === data.provider ? 'selected' : ''}>${PROVIDER_DISPLAY[p] || p}</option>`
  ).join('');

  const fillModels = () => {
    const models = providers[provSel.value] || [];
    modelSel.innerHTML = models.map(m =>
      `<option value="${m}" ${m === data.model ? 'selected' : ''}>${m}</option>`
    ).join('');
  };
  fillModels();
  if (!provSel.dataset.bound) {
    provSel.addEventListener('change', () => { data.model = ''; fillModels(); });
    provSel.dataset.bound = 'true';
  }

  prompt.value = data.systemPrompt || '';
}

async function savePulseVoice() {
  const statusEl = document.getElementById('pulse-voice-status');
  statusEl.textContent = 'Saving…';
  statusEl.style.color = '';
  const body = {
    agent: selectedSettingsAgent,
    provider: document.getElementById('pulse-voice-provider')?.value,
    model: document.getElementById('pulse-voice-model')?.value,
    systemPrompt: document.getElementById('pulse-voice-prompt')?.value,
  };
  try {
    const res = await fetch(`${API}/pulse-voice`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = `Saved for ${selectedAgentLabel()}. Engine restarting, next remark uses this.`;
      statusEl.style.color = 'var(--accent-green)';
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function resetPulsePrompt() {
  const prompt = document.getElementById('pulse-voice-prompt');
  if (!prompt || !pulseVoiceDefaultPrompt) return;
  if (!confirm('Reset the remark voice prompt to the default? Your current text will be lost.')) return;
  prompt.value = pulseVoiceDefaultPrompt;
}

// ── Agency (autonomous actions allow-list editor + live audit trail) ──

let agencyData = null;
let agencyPollTimer = null;

async function loadAgency() {
  try {
    const res = await fetch(`${API}/agency/allowlist`);
    agencyData = await res.json();
    renderAgency(agencyData);
  } catch (err) {
    console.error('Failed to load agency allowlist:', err);
  }
}

function renderAgency(data) {
  // Global
  const globalEnabled = document.getElementById('agency-global-enabled');
  const globalRate = document.getElementById('agency-global-rate');
  if (globalEnabled) globalEnabled.checked = data?.global?.enabled !== false;
  if (globalRate) globalRate.value = data?.global?.max_per_hour ?? 500;

  // Integrations (shortcut bridge)
  const bridgeEnabled = document.getElementById('agency-bridge-enabled');
  const bridgeUrl = document.getElementById('agency-bridge-url');
  const bridge = data?.integrations?.shortcut_bridge || {};
  if (bridgeEnabled) bridgeEnabled.checked = bridge.enabled === true;
  if (bridgeUrl) bridgeUrl.value = bridge.url || '';

  // Actions
  const list = document.getElementById('agency-actions-list');
  if (!list) return;
  const actions = data?.actions || {};
  const keys = Object.keys(actions);
  list.innerHTML = keys.map(key => {
    const a = actions[key] || {};
    const targets = Array.isArray(a.allowed_targets) && a.allowed_targets.length
      ? `<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">targets: ${a.allowed_targets.join(', ')}</span>`
      : '';
    return `
      <div class="h23s-agency-row" data-agency-key="${escapeSlotText(key)}" style="background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:8px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
          <code style="font-size:12px;color:var(--accent-blue);font-weight:600;flex:1;">${escapeSlotText(key)}</code>
          ${targets}
        </div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
            <input type="checkbox" data-agency-enabled ${a.enabled !== false ? 'checked' : ''} /> Enabled
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
            <input type="checkbox" data-agency-dryrun ${a.dry_run === true ? 'checked' : ''} /> Dry-run
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;">
            Max/hour:
            <input type="number" data-agency-rate value="${a.max_per_hour ?? 0}" min="0" step="1" style="width:80px;" />
          </label>
        </div>
        ${a.notes ? `<div style="font-size:11px;color:var(--text-muted);line-height:1.4;margin-top:6px;">${escapeSlotText(a.notes)}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function saveAgency() {
  const statusEl = document.getElementById('agency-status');
  statusEl.textContent = 'Saving…';
  statusEl.style.color = '';

  const globalEnabled = document.getElementById('agency-global-enabled')?.checked;
  const globalRate = parseInt(document.getElementById('agency-global-rate')?.value || '500', 10);
  const bridgeEnabled = document.getElementById('agency-bridge-enabled')?.checked;
  const bridgeUrl = document.getElementById('agency-bridge-url')?.value || '';

  const actions = {};
  document.querySelectorAll('.h23s-agency-row').forEach(row => {
    const key = row.dataset.agencyKey;
    actions[key] = {
      enabled: row.querySelector('[data-agency-enabled]')?.checked === true,
      dry_run: row.querySelector('[data-agency-dryrun]')?.checked === true,
      max_per_hour: parseInt(row.querySelector('[data-agency-rate]')?.value || '0', 10),
    };
  });

  try {
    const res = await fetch(`${API}/agency/allowlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global: { enabled: globalEnabled, max_per_hour: globalRate },
        integrations: { shortcut_bridge: { enabled: bridgeEnabled, url: bridgeUrl } },
        actions,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = 'Saved. Hot-applies on next action.';
      statusEl.style.color = 'var(--accent-green)';
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--accent-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--accent-red)';
  }
}

function renderAgencyRecent(actions) {
  const list = document.getElementById('agency-recent-list');
  if (!list) return;
  if (!actions || actions.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-style:italic;font-size:12px;">No actions yet.</div>';
    return;
  }

  // Group intent+outcome pairs so we render one row per action
  const pairs = [];
  const pending = new Map();
  for (const ev of actions) {
    // actions came in reversed (newest first) from server; we want oldest first
    // for pairing, then reverse again for display
  }
  // Server returns reversed (newest first). Walk forward to pair each outcome
  // with its nearest intent. If unpaired, show the intent alone.
  const chronological = [...actions].reverse();
  const rendered = [];
  const openByKey = new Map(); // key = action+role+cycle+target
  for (const ev of chronological) {
    const key = `${ev.action}|${ev.role}|${ev.cycle}|${ev.target || ''}`;
    if (ev.phase === 'intent') {
      openByKey.set(key, ev);
    } else if (ev.phase === 'outcome') {
      const intent = openByKey.get(key);
      openByKey.delete(key);
      rendered.push({ intent, outcome: ev });
    }
  }
  // Any dangling intents (no outcome yet)
  for (const [, intent] of openByKey) rendered.push({ intent, outcome: null });

  // Newest first
  rendered.reverse();

  list.innerHTML = rendered.slice(0, 60).map(({ intent, outcome }) => {
    const statusColor = !outcome
      ? 'var(--text-muted)'
      : outcome.status === 'success' ? 'var(--accent-green)'
      : outcome.status === 'dry_run' ? 'var(--accent-blue)'
      : 'var(--accent-red)';
    const statusLabel = outcome ? outcome.status : 'in_flight';
    const ts = outcome?.ts || intent?.ts;
    const t = ts ? new Date(ts).toLocaleTimeString() : '';
    const action = intent?.action || '?';
    const target = intent?.target ? ` → ${escapeSlotText(intent.target)}` : '';
    const reason = intent?.reason ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeSlotText(intent.reason)}</div>` : '';
    const detail = outcome?.detail ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeSlotText(outcome.detail)}</div>` : '';
    return `
      <div style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:${statusColor};font-weight:600;font-size:11px;text-transform:uppercase;min-width:70px;">${statusLabel}</span>
          <code style="color:var(--accent-blue);font-size:12px;">${escapeSlotText(action)}</code>
          <span style="color:var(--text-secondary);">${target}</span>
          <span style="margin-left:auto;color:var(--text-muted);font-size:11px;">cycle ${intent?.cycle || '?'} · ${intent?.role || '?'} · ${t}</span>
        </div>
        ${reason}
        ${detail}
      </div>
    `;
  }).join('');
}

async function loadAgencyRecent() {
  try {
    const res = await fetch(settingsApiUrl('/agency/recent', { agentScoped: true, params: { limit: 200 } }));
    const data = await res.json();
    renderAgencyRecent(data.actions || []);
  } catch { /* ok */ }
}

async function loadAgencyRequested() {
  const list = document.getElementById('agency-requested-list');
  if (!list) return;
  try {
    const res = await fetch(settingsApiUrl('/agency/requested', { agentScoped: true, params: { limit: 50 } }));
    const data = await res.json();
    const requests = data.requests || [];
    if (requests.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-style:italic;font-size:12px;">No rejected requests.</div>';
      return;
    }
    list.innerHTML = requests.map(r => {
      const t = r.ts ? new Date(r.ts).toLocaleTimeString() : '';
      return `
        <div style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">
          <div style="display:flex;gap:8px;">
            <code style="color:var(--accent-red);">${escapeSlotText(r.action || 'unknown')}</code>
            ${r.target ? `<span style="color:var(--text-secondary);">→ ${escapeSlotText(r.target)}</span>` : ''}
            <span style="margin-left:auto;color:var(--text-muted);font-size:11px;">cycle ${r.cycle || '?'} · ${r.role || '?'} · ${t}</span>
          </div>
          ${r.reason ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeSlotText(r.reason)}</div>` : ''}
          ${r.status ? `<div style="font-size:11px;color:var(--accent-red);margin-top:2px;">${escapeSlotText(r.status)}${r.detail ? ' · ' + escapeSlotText(r.detail) : ''}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch { /* ok */ }
}

function startAgencyPoll() {
  if (agencyPollTimer) return;
  loadAgencyRecent();
  loadAgencyRequested();
  agencyPollTimer = setInterval(() => {
    const panel = document.getElementById('panel-agency');
    if (panel && panel.classList.contains('active')) {
      loadAgencyRecent();
      loadAgencyRequested();
    }
  }, 5000);
}

// ── Init ──

async function init() {
  await loadScopeRegistry();
  renderSettingsScopeChrome();
  setupSubTabs();
  await loadAgents();
  await refreshAgentScopedPanels();
  loadProviders();
  loadSystem();
  loadFeeder();
  loadSkillsSettings();
  loadVibe();
  loadOAuthStatus();
  loadTilesPanel();
  loadQuerySettings();

  document.getElementById('btn-save-providers').addEventListener('click', saveProviders);
  document.getElementById('btn-create-agent').addEventListener('click', showWizard);
  document.getElementById('btn-save-models').addEventListener('click', saveModels);
  document.getElementById('btn-save-model-catalog')?.addEventListener('click', saveModels);
  document.getElementById('btn-save-query')?.addEventListener('click', saveQuerySettings);
  document.getElementById('btn-save-assignments')?.addEventListener('click', saveAssignments);
  document.getElementById('btn-reset-assignments')?.addEventListener('click', resetAssignments);
  document.getElementById('btn-save-agency')?.addEventListener('click', saveAgency);

  // Agency
  loadAgency();
  startAgencyPoll();

  // Pulse Voice
  loadPulseVoice();
  document.getElementById('btn-save-pulse-voice')?.addEventListener('click', savePulseVoice);
  document.getElementById('btn-reset-pulse-prompt')?.addEventListener('click', resetPulsePrompt);
  document.getElementById('btn-save-system').addEventListener('click', saveSystem);
  document.getElementById('btn-install-deps').addEventListener('click', installDeps);
  document.getElementById('btn-build-ts').addEventListener('click', buildTS);
  setupTilesHandlers();
  setupFeederHandlers();
  setupSkillsHandlers();
  document.getElementById('vibe-save')?.addEventListener('click', saveVibe);
  setupOAuthHandlers();
  setupOnboardingHandlers();
  document.getElementById('settings-agent-select')?.addEventListener('change', async (event) => {
    await setSelectedSettingsAgent(event.target.value);
  });

  setupWizard();

  // Check if onboarding is needed
  const needsOnboarding = await checkOnboarding();
  if (needsOnboarding) {
    showOnboarding();
  }
}

document.addEventListener('DOMContentLoaded', init);
