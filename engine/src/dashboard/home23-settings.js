/**
 * Home23 Settings — Client JS
 */

const API = '/home23/api/settings';
let modelsData = null;

// ── Sub-tab switching ──

function setupSubTabs() {
  document.querySelectorAll('.h23s-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.h23s-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.h23s-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`panel-${tab.dataset.stab}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Providers ──

const PROVIDER_DISPLAY = {
  'ollama-cloud': 'Ollama Cloud',
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'xai': 'xAI',
};

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
  const order = ['ollama-cloud', 'anthropic', 'openai', 'xai'];
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
            ${modelsText ? `<span style="font-size:11px;color:var(--h23-text-muted);">${modelsText}</span>` : ''}
          </div>
          <div class="h23s-provider-status" id="prov-status-${name}">
            <span class="h23s-status-dot ${statusClass}"></span>
            <span>${statusText}</span>
          </div>
        </div>
        ${p.hasKey ? `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
            <span style="font-size:12px;color:var(--h23-text-muted);">Current key:</span>
            <code style="font-size:12px;color:var(--h23-text-secondary);background:rgba(255,255,255,0.04);padding:3px 8px;border-radius:4px;">${p.maskedKey}</code>
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
  statusEl.innerHTML = '<span class="h23s-status-dot"></span> <span>Testing...</span>';
  try {
    const res = await fetch(`${API}/providers/${name}/test`, { method: 'POST' });
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
  for (const name of ['ollama-cloud', 'anthropic', 'openai', 'xai']) {
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
      statusEl.style.color = 'var(--h23-green)';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
      loadProviders();
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      statusEl.style.color = 'var(--h23-red)';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--h23-red)';
  }
}

// ── Agents ──

async function loadAgents() {
  try {
    const res = await fetch(`${API}/agents`);
    const data = await res.json();
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
    <div class="h23s-agent-card" data-agent="${a.name}" ${a.isPrimary ? 'style="border-color:var(--h23-accent);"' : ''}>
      <div class="h23s-agent-summary" onclick="toggleAgentDetail('${a.name}')">
        <div class="h23s-agent-info">
          <span class="h23s-agent-name">${a.displayName || a.name}</span>
          ${a.isPrimary ? '<span class="h23s-agent-badge" style="background:rgba(88,166,255,0.12);color:var(--h23-accent);">PRIMARY</span>' : ''}
          <span class="h23s-agent-badge ${a.status}">${a.status}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${a.status === 'running'
            ? `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); stopAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Stop</button>`
            : `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); startAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Start</button>`
          }
          <span style="color:var(--h23-text-muted);font-size:16px;" id="chevron-${a.name}">&#9656;</span>
        </div>
      </div>
      <div style="display:flex;gap:20px;margin-top:8px;font-size:12px;color:var(--h23-text-muted);flex-wrap:wrap;">
        <span>Model: <strong style="color:var(--h23-text-secondary);">${a.model || '?'}</strong></span>
        <span>Provider: <strong style="color:var(--h23-text-secondary);">${provLabel}</strong></span>
        <span>Owner: <strong style="color:var(--h23-text-secondary);">${a.owner || 'not set'}</strong></span>
        <span>Ports: <strong style="color:var(--h23-text-secondary);">${a.ports.engine || '?'} / ${a.ports.dashboard || '?'}</strong></span>
        <span>Channels: <strong style="color:var(--h23-text-secondary);">${[a.channels?.telegram?.enabled && 'Telegram', a.channels?.discord?.enabled && 'Discord'].filter(Boolean).join(', ') || 'Direct only'}</strong></span>
        ${a.status === 'running' ? `<a href="${dashUrl}/home23" target="_blank" style="color:var(--h23-accent);text-decoration:none;" onclick="event.stopPropagation();">Open Dashboard &rarr;</a>` : ''}
      </div>
      <div class="h23s-agent-detail" id="detail-${a.name}">
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
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--h23-border);">
          <h4 style="font-size:12px;color:var(--h23-accent);text-transform:uppercase;letter-spacing:1px;margin:0 0 14px 0;font-weight:600;">Channels</h4>
          <div style="background:rgba(255,255,255,0.02);border:1px solid var(--h23-border);border-radius:8px;padding:14px 16px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:#fff;margin:0;">
                <input type="checkbox" id="edit-${a.name}-telegram-enabled" ${a.channels?.telegram?.enabled ? 'checked' : ''}
                  style="width:16px;height:16px;accent-color:var(--h23-accent);cursor:pointer;">
                Telegram
              </label>
              <span style="font-size:11px;color:${a.channels?.telegram?.enabled ? 'var(--h23-green)' : 'var(--h23-text-muted)'};">${a.channels?.telegram?.enabled ? 'Connected' : 'Not configured'}</span>
            </div>
            <div class="h23s-field" style="margin-bottom:0;">
              <input type="password" id="edit-${a.name}-telegram-token" placeholder="${a.channels?.telegram?.enabled ? 'Token configured — paste new to replace' : 'Paste bot token from @BotFather'}"
                style="font-size:12px;">
            </div>
          </div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid var(--h23-border);border-radius:8px;padding:14px 16px;opacity:0.5;">
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--h23-text-muted);margin:0;">
              <input type="checkbox" disabled style="width:16px;height:16px;">
              Discord <span style="font-size:11px;margin-left:8px;">coming soon</span>
            </label>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="h23s-btn-primary" onclick="saveAgent('${a.name}')" style="font-size:13px;padding:7px 16px;">Save</button>
          ${a.isPrimary ? '' : `<button class="h23s-btn-danger" onclick="deleteAgent('${a.name}')">Delete Agent</button>`}
          <span class="h23s-save-status" id="agent-status-${a.name}"></span>
        </div>
      </div>
    </div>
  `;}).join('');
}

function toggleAgentDetail(name) {
  const detail = document.getElementById(`detail-${name}`);
  const chevron = document.getElementById(`chevron-${name}`);
  if (detail) {
    detail.classList.toggle('open');
    if (chevron) chevron.innerHTML = detail.classList.contains('open') ? '&#9662;' : '&#9656;';
  }
}

async function startAgent(name) {
  try {
    await fetch(`${API}/agents/${name}/start`, { method: 'POST' });
    loadAgents();
  } catch (err) {
    alert('Failed to start: ' + err.message);
  }
}

async function stopAgent(name) {
  try {
    await fetch(`${API}/agents/${name}/stop`, { method: 'POST' });
    loadAgents();
  } catch (err) {
    alert('Failed to stop: ' + err.message);
  }
}

async function saveAgent(name) {
  const telegramEnabled = document.getElementById(`edit-${name}-telegram-enabled`)?.checked;
  const telegramToken = document.getElementById(`edit-${name}-telegram-token`)?.value?.trim();

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
      statusEl.innerHTML = `Saved &mdash; <button onclick="restartAgent('${name}')" style="background:var(--h23-accent);color:#fff;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;">Restart to apply</button>`;
      statusEl.style.color = 'var(--h23-green)';
    } else {
      statusEl.textContent = 'Error: ' + data.error;
      statusEl.style.color = 'var(--h23-red)';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--h23-red)';
  }
}

async function restartAgent(name) {
  try {
    await fetch(`${API}/agents/${name}/stop`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 1000));
    await fetch(`${API}/agents/${name}/start`, { method: 'POST' });
    const statusEl = document.getElementById(`agent-status-${name}`);
    if (statusEl) {
      statusEl.textContent = 'Restarted';
      statusEl.style.color = 'var(--h23-green)';
      setTimeout(() => { statusEl.textContent = ''; loadAgents(); }, 2000);
    }
  } catch (err) {
    alert('Restart failed: ' + err.message);
  }
}

async function deleteAgent(name) {
  if (!confirm(`Delete agent "${name}"? This removes the instance directory and all data.`)) return;
  try {
    await fetch(`${API}/agents/${name}`, { method: 'DELETE' });
    loadAgents();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

// ── Wizard ──

let wizardStep = 1;

let isCreatingPrimary = false;

async function showWizard() {
  document.getElementById('agent-wizard').style.display = 'block';
  document.getElementById('btn-create-agent').disabled = true;
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
}

function hideWizard() {
  document.getElementById('agent-wizard').style.display = 'none';
  document.getElementById('btn-create-agent').disabled = false;
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
    const fallback = { 'ollama-cloud': ['kimi-k2.5', 'minimax-m2.7'], 'anthropic': ['claude-sonnet-4-6'], 'openai': ['gpt-5.4'], 'xai': ['grok-4-0709'] };
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
      loadAgents();
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
    const res = await fetch(`${API}/models`);
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
  provSelect.addEventListener('change', fillModelSelect);
  fillModelSelect();

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
    chat: {
      defaultProvider: document.getElementById('models-default-provider').value,
      defaultModel: document.getElementById('models-default-model').value,
    },
    aliases,
  };

  const statusEl = document.getElementById('models-status');
  try {
    const res = await fetch(`${API}/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    statusEl.textContent = data.ok ? 'Saved' : ('Error: ' + data.error);
    statusEl.style.color = data.ok ? 'var(--h23-green)' : 'var(--h23-red)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--h23-red)';
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
  const providers = data.embeddings?.providers || [];
  embList.innerHTML = providers.map((p, i) => `
    <div class="h23s-provider-card" style="padding:12px 16px;margin-bottom:8px;">
      <div style="display:flex;gap:12px;align-items:center;font-size:13px;">
        <span style="color:var(--h23-text-muted);min-width:20px;">${i === 0 ? 'Primary' : 'Fallback ' + i}.</span>
        <span style="color:#fff;font-weight:500;">${PROVIDER_DISPLAY[p.provider] || p.provider}</span>
        <span style="color:var(--h23-text-secondary);">${p.model}</span>
        <span style="color:var(--h23-text-muted);">${p.dimensions} dimensions</span>
      </div>
    </div>
  `).join('') || '<p class="h23s-panel-desc" style="margin:0;">No embedding providers configured.</p>';
}

async function saveSystem() {
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
    statusEl.style.color = data.ok ? 'var(--h23-green)' : 'var(--h23-red)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = 'var(--h23-red)';
  }
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

// ── Init ──

async function init() {
  setupSubTabs();
  // Load models first so provider cards can show model counts
  await loadModels();
  loadProviders();
  loadAgents();
  loadSystem();

  document.getElementById('btn-save-providers').addEventListener('click', saveProviders);
  document.getElementById('btn-create-agent').addEventListener('click', showWizard);
  document.getElementById('btn-save-models').addEventListener('click', saveModels);
  document.getElementById('btn-save-system').addEventListener('click', saveSystem);
  document.getElementById('btn-install-deps').addEventListener('click', installDeps);
  document.getElementById('btn-build-ts').addEventListener('click', buildTS);

  setupWizard();
}

document.addEventListener('DOMContentLoaded', init);
