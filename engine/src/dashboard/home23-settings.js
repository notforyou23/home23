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
    <div class="h23s-agent-card" data-agent="${a.name}" ${a.isPrimary ? 'style="border-color:var(--accent-blue);"' : ''}>
      <div class="h23s-agent-summary" onclick="toggleAgentDetail('${a.name}')">
        <div class="h23s-agent-info">
          <span class="h23s-agent-name">${a.displayName || a.name}</span>
          ${a.isPrimary ? '<span class="h23s-agent-badge" style="background:rgba(88,166,255,0.12);color:var(--accent-blue);">PRIMARY</span>' : ''}
          <span class="h23s-agent-badge ${a.status}">${a.status}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${a.status === 'running'
            ? `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); stopAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Stop</button>`
            : `<button class="h23s-btn-secondary" onclick="event.stopPropagation(); startAgent('${a.name}')" style="font-size:12px;padding:5px 12px;">Start</button>`
          }
          <span style="color:var(--text-muted);font-size:16px;" id="chevron-${a.name}">&#9656;</span>
        </div>
      </div>
      <div style="display:flex;gap:20px;margin-top:8px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;">
        <span>Model: <strong style="color:var(--text-secondary);">${a.model || '?'}</strong></span>
        <span>Provider: <strong style="color:var(--text-secondary);">${provLabel}</strong></span>
        <span>Owner: <strong style="color:var(--text-secondary);">${a.owner || 'not set'}</strong></span>
        <span>Ports: <strong style="color:var(--text-secondary);">${a.ports.engine || '?'} / ${a.ports.dashboard || '?'}</strong></span>
        <span>Channels: <strong style="color:var(--text-secondary);">${[a.channels?.telegram?.enabled && 'Telegram', a.channels?.discord?.enabled && 'Discord'].filter(Boolean).join(', ') || 'Direct only'}</strong></span>
        ${a.status === 'running' ? `<a href="${dashUrl}/home23" target="_blank" style="color:var(--accent-blue);text-decoration:none;" onclick="event.stopPropagation();">Open Dashboard &rarr;</a>` : ''}
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
          <div style="background:rgba(255,255,255,0.02);border:1px solid var(--glass-border);border-radius:8px;padding:14px 16px;opacity:0.5;">
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text-muted);margin:0;">
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

async function restartAgent(name) {
  try {
    await fetch(`${API}/agents/${name}/stop`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 1000));
    await fetch(`${API}/agents/${name}/start`, { method: 'POST' });
    const statusEl = document.getElementById(`agent-status-${name}`);
    if (statusEl) {
      statusEl.textContent = 'Restarted';
      statusEl.style.color = 'var(--accent-green)';
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

  // Engine role dropdowns — collect ALL models across ALL providers
  const allModels = [];
  for (const [provName, prov] of Object.entries(data.providers || {})) {
    for (const m of (prov.defaultModels || [])) {
      allModels.push({ model: m, provider: provName });
    }
  }
  const roleKeys = ['thought', 'consolidation', 'dreaming', 'query'];
  for (const role of roleKeys) {
    const sel = document.getElementById(`engine-role-${role}`);
    if (!sel) continue;
    sel.innerHTML = '<option value="">Use Default</option>';
    for (const { model, provider } of allModels) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = `${model}  (${PROVIDER_DISPLAY[provider] || provider})`;
      if (data.engineRoles?.[role] === model) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Per-provider model lists
  const pmList = document.getElementById('provider-models-list');
  const providerOrder = ['ollama-cloud', 'anthropic', 'openai', 'openai-codex', 'xai'];
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
  for (const name of ['ollama-cloud', 'anthropic', 'openai', 'openai-codex', 'xai']) {
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

  const engineRoles = {};
  for (const role of ['thought', 'consolidation', 'dreaming', 'query']) {
    const val = document.getElementById(`engine-role-${role}`)?.value;
    if (val) engineRoles[role] = val;
  }

  const body = {
    chat: {
      defaultProvider: document.getElementById('models-default-provider').value,
      defaultModel: document.getElementById('models-default-model').value,
    },
    aliases,
    providerModels: collectProviderModels(),
    engineRoles,
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

async function loadFeeder() {
  try {
    const res = await fetch(`${API}/feeder`);
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
  document.getElementById('fd-compiler-model').value = f.compiler?.model || 'minimax-m2.7';

  // Converter
  document.getElementById('fd-converter-enabled').checked = f.converter?.enabled !== false;
  document.getElementById('fd-converter-vision').value = f.converter?.visionModel || 'gpt-4o-mini';
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
    const res = await fetch(`${API}/feeder`, {
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
        await fetch('/home23/feeder/update-compiler', {
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
        await fetch('/home23/feeder/add-watch-path', {
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

    statusEl.textContent = 'Saved ' + (applied.length ? `(${applied.length} hot-applied)` : '');
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
      fetch('/home23/feeder/live-status').catch(() => null),
      fetch('/home23/feeder-status').catch(() => null),
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
    const res = await fetch('/home23/feeder/flush', { method: 'POST' });
    const data = await res.json();
    statusEl.textContent = data.ok ? 'Flushed' : ('Error: ' + (data.error || 'unknown'));
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

    const res = await fetch('/home23/feeder/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.ok) {
      row.innerHTML = `<div style="color:var(--accent-red);">Upload failed: ${escapeHtml(data.error || 'unknown')}</div>`;
      return;
    }
    const fileList = (data.files || []).map((f) => `<div style="font-family:monospace; font-size:0.8em; opacity:0.8;">→ ${escapeHtml(f.name)} (${Math.round(f.size / 1024)}KB)</div>`).join('');
    row.innerHTML = `<div style="color:var(--accent-green);">✓ Uploaded ${data.count} file(s) to ${escapeHtml(data.label)}. Feeder will pick them up within ~1s.</div>${fileList}`;
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
    // Best-effort: use the existing PM2-restart pattern already in the settings API.
    // If no dedicated endpoint exists, surface the CLI command to the user.
    statusEl.innerHTML = 'Open a terminal and run: <code>pm2 restart home23-$(whoami)</code> — or use the Agents tab stop/start buttons.';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// ── Vibe ──

async function loadVibe() {
  try {
    const res = await fetch('/home23/api/settings/vibe');
    const data = await res.json();
    const v = data.vibe || {};
    const d = v.dreams || {};
    document.getElementById('vibe-autogen').checked = v.autoGenerate !== false;
    document.getElementById('vibe-gen-hours').value = v.generationIntervalHours ?? 12;
    document.getElementById('vibe-rot-seconds').value = v.rotationIntervalSeconds ?? 45;
    document.getElementById('vibe-gallery-limit').value = v.galleryLimit ?? 60;
    document.getElementById('vibe-dreams-enabled').checked = d.enabled !== false;
    document.getElementById('vibe-dreams-lookback').value = d.lookback ?? 3;
    document.getElementById('vibe-dreams-extraction').value = d.extraction === 'llm' ? 'llm' : 'heuristic';
  } catch (err) {
    console.error('[vibe] load failed', err);
  }
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
      dreams: {
        enabled: document.getElementById('vibe-dreams-enabled').checked,
        lookback: Number(document.getElementById('vibe-dreams-lookback').value),
        extraction: document.getElementById('vibe-dreams-extraction').value,
      },
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
  const order = ['ollama-cloud', 'anthropic', 'openai', 'xai'];
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

async function obSaveKeys() {
  const providers = {};
  for (const name of ['ollama-cloud', 'anthropic', 'openai', 'xai']) {
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

// ── Init ──

async function init() {
  setupSubTabs();
  // Load models first so provider cards can show model counts
  await loadModels();
  loadProviders();
  loadAgents();
  loadSystem();
  loadFeeder();
  loadVibe();
  loadOAuthStatus();

  document.getElementById('btn-save-providers').addEventListener('click', saveProviders);
  document.getElementById('btn-create-agent').addEventListener('click', showWizard);
  document.getElementById('btn-save-models').addEventListener('click', saveModels);
  document.getElementById('btn-save-system').addEventListener('click', saveSystem);
  document.getElementById('btn-install-deps').addEventListener('click', installDeps);
  document.getElementById('btn-build-ts').addEventListener('click', buildTS);
  setupFeederHandlers();
  document.getElementById('vibe-save')?.addEventListener('click', saveVibe);
  setupOAuthHandlers();
  setupOnboardingHandlers();

  setupWizard();

  // Check if onboarding is needed
  const needsOnboarding = await checkOnboarding();
  if (needsOnboarding) {
    showOnboarding();
  }
}

document.addEventListener('DOMContentLoaded', init);
