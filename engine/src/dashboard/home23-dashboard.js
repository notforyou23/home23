/**
 * Home23 Dashboard — Vanilla JS
 *
 * Primary agent view on Home tab (ReginaCosmo layout).
 * COSMO 2.3 embedded via iframe on COSMO tab.
 * Secondary agent tabs created on demand.
 */

// ── Config ──

const REFRESH_MS = 30000;
let agents = [];
let primaryAgent = null;
let currentTab = 'home';
let cosmo23Url = '';
let evobrewUrl = '';
let cosmo23Loaded = false;
let intelRefreshInterval = null;

// ── Init ──

async function init() {
  startClock();
  await loadAgents();
  renderAgentTabs();
  setupTabHandlers();
  await loadHomeTiles();
  startAutoRefresh();
  updateCosmoIndicator();
  setInterval(updateCosmoIndicator, REFRESH_MS);

  // Initialize dashboard chat
  if (typeof initChat === 'function') {
    initChat('tile');
  }
}

// ── Clock ──

function startClock() {
  function update() {
    const el = document.getElementById('clock');
    if (el) {
      el.textContent = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true
      });
    }
  }
  update();
  setInterval(update, 1000);
}

// ── Load Agents ──

async function loadAgents() {
  try {
    const res = await fetch('/home23/agents.json');
    if (res.ok) agents = await res.json();
  } catch { /* ignore */ }

  // Fallback: current dashboard is the only agent
  if (agents.length === 0) {
    agents = [{
      name: 'agent',
      displayName: 'Agent',
      dashboardPort: window.location.port || 5002,
      enginePort: 5001
    }];
  }

  // Primary agent = the one whose dashboard we're on
  const currentPort = parseInt(window.location.port) || 5002;
  primaryAgent = agents.find(a => a.dashboardPort === currentPort) || agents[0];

  // Set header name
  document.getElementById('home-name').textContent = primaryAgent.displayName || primaryAgent.name;
  document.getElementById('primary-agent-name').textContent = primaryAgent.displayName || primaryAgent.name;

  // Load config and construct host-relative URLs
  const host = window.location.hostname;
  try {
    const cfgRes = await fetch('/home23/config.json');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      cosmo23Url = `http://${host}:${cfg.cosmo23Port}`;
      evobrewUrl = `http://${host}:${cfg.evobrewPort}`;

      // Wire evobrew button
      const evobrewBtn = document.getElementById('evobrew-btn');
      if (evobrewBtn && evobrewUrl) {
        evobrewBtn.href = `${evobrewUrl}/?agent=${primaryAgent.name}`;
        evobrewBtn.target = '_blank';
      }
    }
  } catch { /* config offline */ }

  // Wire settings button
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.location.href = '/home23/settings';
    });
  }

  // Wire COSMO tab button
  const cosmoBtn = document.getElementById('cosmo23-btn');
  if (cosmoBtn) {
    cosmoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Deactivate all data-tab buttons
      document.querySelectorAll('.h23-tab[data-tab]').forEach(t => t.classList.remove('active'));
      cosmoBtn.classList.add('active');
      currentTab = 'cosmo23';
      showCosmoFrame();
    });
  }

  // Wire COSMO indicator click -> switch to COSMO tab
  const indicator = document.getElementById('cosmo23-indicator');
  if (indicator) {
    indicator.addEventListener('click', () => {
      if (cosmoBtn) cosmoBtn.click();
    });
  }

  // Wire COSMO iframe refresh button
  const refreshBtn = document.getElementById('cosmo23-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshCosmoFrame());
  }

  // Wire Intelligence tab synthesis button
  setupIntelSynthButton();
}

// ── COSMO iframe ──

function showCosmoFrame() {
  // Hide all panels
  document.querySelectorAll('.h23-panel').forEach(p => p.classList.remove('active'));
  const frame = document.getElementById('cosmo23-frame');
  const wrap = document.getElementById('cosmo23-frame-wrap');
  if (!cosmo23Loaded && cosmo23Url) {
    frame.src = cosmo23Url;
    cosmo23Loaded = true;
  }
  if (wrap) wrap.style.display = 'block';
}

function hideCosmoFrame() {
  const wrap = document.getElementById('cosmo23-frame-wrap');
  if (wrap) wrap.style.display = 'none';
}

function refreshCosmoFrame() {
  const frame = document.getElementById('cosmo23-frame');
  if (frame && cosmo23Url) {
    frame.src = cosmo23Url;
    cosmo23Loaded = true;
  }
}

// ── COSMO status indicator ──

async function updateCosmoIndicator() {
  if (!cosmo23Url) return;
  const dot = document.getElementById('cosmo23-ind-dot');
  const text = document.getElementById('cosmo23-ind-text');
  if (!dot || !text) return;
  try {
    const res = await fetch(`${cosmo23Url}/api/status`, { signal: AbortSignal.timeout(5000) });
    const status = await res.json();
    if (status.running && status.activeContext) {
      dot.className = 'h23-cosmo-indicator-dot running';
      text.textContent = `COSMO: running — ${status.activeContext.runName || 'research'}`;
    } else {
      dot.className = 'h23-cosmo-indicator-dot';
      text.textContent = 'COSMO: idle';
    }
  } catch {
    dot.className = 'h23-cosmo-indicator-dot error';
    text.textContent = 'COSMO: offline';
  }
}

// ── Tabs ──

function renderAgentTabs() {
  const container = document.getElementById('agent-tabs');
  // Only show tabs for other agents (not primary — that's "Home")
  const others = agents.filter(a => a.name !== primaryAgent.name);
  container.innerHTML = others.map(a =>
    `<button class="h23-tab" data-tab="agent-${a.name}">🐢 ${a.displayName || a.name}</button>`
  ).join('');
}

function setupTabHandlers() {
  document.querySelectorAll('.h23-tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs (including cosmo button)
      document.querySelectorAll('.h23-tab[data-tab]').forEach(t => t.classList.remove('active'));
      const cosmoBtn = document.getElementById('cosmo23-btn');
      if (cosmoBtn) cosmoBtn.classList.remove('active');

      // Hide cosmo frame
      hideCosmoFrame();

      // Hide all panels
      document.querySelectorAll('.h23-panel').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      currentTab = tab.dataset.tab;

      let panel = document.getElementById(`panel-${currentTab}`);
      if (!panel && currentTab.startsWith('agent-')) {
        const name = currentTab.replace('agent-', '');
        panel = createAgentPanel(name);
        document.querySelector('.h23-main').appendChild(panel);
        loadAgentPanel(name);
      }
      if (panel) panel.classList.add('active');

      // Intelligence tab: load content and start refresh
      if (currentTab === 'intelligence') {
        loadIntelligence();
        if (!intelRefreshInterval) {
          intelRefreshInterval = setInterval(loadIntelligence, 30_000);
        }
      } else {
        if (intelRefreshInterval) {
          clearInterval(intelRefreshInterval);
          intelRefreshInterval = null;
        }
      }
    });
  });
}

// ── Home Tiles (primary agent) ──

async function loadHomeTiles() {
  const base = apiBase(primaryAgent);

  // State
  try {
    const state = await apiFetch(`${base}/api/state`);
    if (state) {
      updateSystemTile(state);
      updatePills(state);
      document.getElementById('system-status').textContent = '● COSMO active';
      document.getElementById('system-status').className = 'h23-status';
    }
  } catch {
    document.getElementById('system-status').textContent = '● offline';
    document.getElementById('system-status').className = 'h23-status offline';
  }

  // Feeder status
  try {
    const feederData = await apiFetch('/home23/feeder-status');
    if (feederData) updateFeederTile(feederData);
  } catch { /* offline */ }

  // Thoughts
  try {
    const data = await apiFetch(`${base}/api/thoughts?limit=20`);
    if (data) {
      const thoughts = data.thoughts || data.journal || data || [];
      updateThoughtsTile(thoughts);
      updateBrainLog(thoughts);
    }
  } catch { /* offline */ }
}

function updateSystemTile(state) {
  const journal = state.journal || [];
  const lastThought = journal.length > 0 ? journal[journal.length - 1] : null;

  setText('sys-uptime', state.uptime || formatUptime(state));
  setText('sys-thoughts', String(journal.length));
  setText('sys-nodes', String(state.memoryNodes || state.nodeCount || '—'));
  setText('sys-last', lastThought ? timeSince(new Date(lastThought.timestamp || Date.now())) : '—');

  // Excerpt of latest thought in system tile
  if (lastThought?.thought) {
    setText('sys-excerpt', lastThought.thought.slice(0, 120) + '...');
  }
}

function updatePills(state) {
  const journal = state.journal || [];
  setText('pill-cycle', `🧠 cycle ${state.cycleCount || '—'}`);
  setText('pill-mode', `${state.oscillatorMode || 'focus'}`);
  setText('pill-updated', `sensors ${timeSince(new Date())}`);
}

function updateThoughtsTile(thoughts) {
  if (thoughts.length === 0) return;
  const latest = thoughts[thoughts.length - 1];
  const text = latest.thought || latest.content || latest.text || '';
  const role = latest.role || '';
  const cycle = latest.cycle || '';

  setText('home-thought', text.slice(0, 400));
  setText('home-thought-meta', `CYCLE ${cycle}`);
}

function updateBrainLog(thoughts) {
  const container = document.getElementById('home-brainlog');
  if (!container) return;

  if (thoughts.length === 0) {
    container.innerHTML = '<p class="h23-muted">Loading...</p>';
    return;
  }

  const reversed = [...thoughts].reverse();
  container.innerHTML = reversed.map(t => {
    const text = t.thought || t.content || t.text || '';
    const role = t.role || '';
    const time = t.timestamp
      ? new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : (t.cycle ? `C${t.cycle}` : '');

    return `<div class="h23-log-entry">
      <span class="h23-log-time">${time}</span>
      <span class="h23-log-role">${role}</span>
      <span class="h23-log-text">${text.slice(0, 200)}</span>
    </div>`;
  }).join('');
}

// ── Feeder Tile ──

function updateFeederTile(data) {
  const container = document.getElementById('home-feeder');
  if (!container) return;

  const feeders = data.feeders || [];
  // Find the feeder for our primary agent
  const feeder = feeders.find(f => f.member === primaryAgent.name) || feeders[0];

  if (!feeder) {
    container.innerHTML = '<p class="h23-muted">No feeder data</p>';
    return;
  }

  const files = feeder.files || [];
  const sorted = [...files].sort((a, b) => (b.lastIngested || '').localeCompare(a.lastIngested || ''));

  container.innerHTML = `
    <div class="h23-feeder-stats">
      <div class="h23-feeder-stat"><span class="value">${feeder.totalFiles}</span> documents</div>
      <div class="h23-feeder-stat"><span class="value">${feeder.pendingCount}</span> pending</div>
      <div class="h23-feeder-stat"><span class="value">${files.reduce((sum, f) => sum + (f.chunks || 0), 0)}</span> chunks</div>
    </div>
    <div class="h23-feeder-files">
      ${sorted.map(f => {
        const name = f.path.split('/').pop();
        const label = f.label ? `[${f.label}]` : '';
        return `<div class="h23-feeder-file">
          <span class="path">${name} ${label}</span>
          <span class="chunks">${f.chunks || 0} chunks</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ── Secondary Agent Panels ──

function createAgentPanel(agentName) {
  const agent = agents.find(a => a.name === agentName);
  const displayName = agent?.displayName || agentName;

  const panel = document.createElement('div');
  panel.className = 'h23-panel';
  panel.id = `panel-agent-${agentName}`;
  panel.innerHTML = `
    <div class="h23-grid-top">
      <div class="h23-tile h23-tile-thoughts">
        <div class="h23-tile-header"><span class="icon">🧠</span> ${displayName}</div>
        <div class="h23-thought-text" id="thought-${agentName}">Loading...</div>
        <div class="h23-thought-meta" id="thought-meta-${agentName}"></div>
      </div>
      <div class="h23-tile h23-tile-vibe">
        <div class="h23-tile-header"><span class="icon">🎨</span> Vibe</div>
        <div class="h23-vibe-image"><span class="h23-vibe-placeholder">Generating...</span></div>
      </div>
      <div class="h23-tile h23-tile-system">
        <div class="h23-tile-header"><span class="icon">⚡</span> System</div>
        <div class="h23-system-grid">
          <div class="h23-system-item"><label>UPTIME</label><div class="value" id="sys2-uptime-${agentName}">—</div></div>
          <div class="h23-system-item"><label>THOUGHTS</label><div class="value" id="sys2-thoughts-${agentName}">—</div></div>
          <div class="h23-system-item"><label>NODES</label><div class="value" id="sys2-nodes-${agentName}">—</div></div>
          <div class="h23-system-item"><label>LAST THOUGHT</label><div class="value" id="sys2-last-${agentName}">—</div></div>
        </div>
      </div>
    </div>
    <div class="h23-tile h23-tile-brainlog">
      <div class="h23-tile-header"><span class="icon">🧠</span> BRAIN LOG</div>
      <div class="h23-brain-log" id="brainlog-${agentName}"><p class="h23-muted">Loading...</p></div>
    </div>
  `;
  return panel;
}

async function loadAgentPanel(agentName) {
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return;
  const base = apiBase(agent);

  try {
    const state = await apiFetch(`${base}/api/state`);
    if (state) {
      const journal = state.journal || [];
      const last = journal.length > 0 ? journal[journal.length - 1] : null;
      setText(`sys2-uptime-${agentName}`, state.uptime || '—');
      setText(`sys2-thoughts-${agentName}`, String(journal.length));
      setText(`sys2-nodes-${agentName}`, String(state.memoryNodes || '—'));
      setText(`sys2-last-${agentName}`, last ? timeSince(new Date(last.timestamp || Date.now())) : '—');
    }
  } catch { /* offline */ }

  try {
    const data = await apiFetch(`${base}/api/thoughts?limit=20`);
    if (data) {
      const thoughts = data.thoughts || data.journal || data || [];
      if (thoughts.length > 0) {
        const latest = thoughts[thoughts.length - 1];
        setText(`thought-${agentName}`, (latest.thought || '').slice(0, 400));
        setText(`thought-meta-${agentName}`, `CYCLE ${latest.cycle || ''}`);
      }
      // Brain log
      const container = document.getElementById(`brainlog-${agentName}`);
      if (container && thoughts.length > 0) {
        const reversed = [...thoughts].reverse();
        container.innerHTML = reversed.map(t => {
          const text = t.thought || t.content || '';
          const role = t.role || '';
          const time = t.timestamp
            ? new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            : '';
          return `<div class="h23-log-entry">
            <span class="h23-log-time">${time}</span>
            <span class="h23-log-role">${role}</span>
            <span class="h23-log-text">${text.slice(0, 200)}</span>
          </div>`;
        }).join('');
      }
    }
  } catch { /* offline */ }
}

// ── Auto-Refresh ──

function startAutoRefresh() {
  setInterval(async () => {
    if (currentTab === 'home') {
      await loadHomeTiles();
    } else if (currentTab.startsWith('agent-')) {
      await loadAgentPanel(currentTab.replace('agent-', ''));
    }
    // cosmo23 tab: iframe handles its own refresh
  }, REFRESH_MS);
}

// ── Utilities ──

function apiBase(agent) {
  const port = agent.dashboardPort;
  return port == (parseInt(window.location.port) || 5002)
    ? '' : `http://${window.location.hostname}:${port}`;
}

async function apiFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return res.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatUptime(state) {
  // Try to derive from cycle count and interval
  if (state.cycleCount && state.cycleInterval) {
    const seconds = state.cycleCount * (state.cycleInterval / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  return '—';
}

// ── Intelligence Tab ──

async function loadIntelligence() {
  const host = window.location.hostname;
  const dashPort = location.port;

  try {
    const res = await fetch(`http://${host}:${dashPort}/api/synthesis/state`);
    const state = await res.json();

    // Timestamp
    const tsEl = document.getElementById('intel-timestamp');
    if (tsEl) {
      tsEl.textContent = state.generatedAt
        ? `Last synthesis: ${new Date(state.generatedAt).toLocaleString()}`
        : 'No synthesis yet';
    }

    // Vitals
    const stats = state.brainStats || {};
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
    setVal('iv-nodes', stats.nodes?.toLocaleString());
    setVal('iv-edges', stats.edges?.toLocaleString());
    setVal('iv-cycles', stats.cycles);
    setVal('iv-compiled', stats.documentsCompiled);

    // Self-Understanding
    const selfEl = document.getElementById('intel-self-content');
    if (selfEl && state.selfUnderstanding) {
      const su = state.selfUnderstanding;
      let html = `<p>${su.summary || 'No self-understanding yet.'}</p>`;
      if (su.relationship) {
        html += `<p style="margin-top:0.5rem;color:#93c5fd;font-size:0.85rem;">${su.relationship}</p>`;
      }
      if (su.currentObsessions && su.currentObsessions.length > 0) {
        html += `<div class="h23-intel-obsessions">${su.currentObsessions.map(o => `<span class="h23-intel-obsession">${o}</span>`).join('')}</div>`;
      }
      selfEl.innerHTML = html;
    } else if (selfEl) {
      selfEl.innerHTML = '<p class="h23-muted">Awaiting first synthesis run...</p>';
    }

    // Consolidated Insights
    const insightsEl = document.getElementById('intel-insights-list');
    if (insightsEl && state.consolidatedInsights && state.consolidatedInsights.length > 0) {
      insightsEl.innerHTML = state.consolidatedInsights.map(i => `
        <div class="h23-intel-insight">
          <div class="h23-intel-insight-title">${i.title || 'Untitled'}</div>
          <div class="h23-intel-insight-excerpt">${i.excerpt || ''}</div>
          <div class="h23-intel-insight-meta">
            ${i.source ? `Source: ${i.source}` : ''}
            ${i.themes ? i.themes.map(t => `<span class="h23-intel-insight-theme">${t}</span>`).join('') : ''}
          </div>
        </div>
      `).join('');
    } else if (insightsEl) {
      insightsEl.innerHTML = '<div class="h23-intel-card"><p class="h23-muted">No insights yet. Run synthesis to generate.</p></div>';
    }

    // Knowledge Index
    const indexEl = document.getElementById('intel-index-content');
    if (indexEl) {
      indexEl.textContent = state.knowledgeIndex || 'No compiled documents yet.';
    }

    // Recent Activity
    const activityEl = document.getElementById('intel-activity-list');
    if (activityEl && state.recentActivity && state.recentActivity.length > 0) {
      activityEl.innerHTML = state.recentActivity.map(a => `<li>${a}</li>`).join('');
    } else if (activityEl) {
      activityEl.innerHTML = '<li class="h23-muted">No recent activity.</li>';
    }
  } catch (err) {
    console.warn('[intel] Failed to load synthesis state:', err.message);
  }
}

function setupIntelSynthButton() {
  const btn = document.getElementById('intel-synth-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.classList.add('running');
    btn.textContent = 'Running...';

    const host = window.location.hostname;
    const dashPort = location.port;

    try {
      await fetch(`http://${host}:${dashPort}/api/synthesis/run`, { method: 'POST' });
      // Poll for completion
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`http://${host}:${dashPort}/api/synthesis/state`);
          const state = await res.json();
          if (state.generatedAt && new Date(state.generatedAt).getTime() > Date.now() - 60_000) {
            clearInterval(poll);
            btn.classList.remove('running');
            btn.textContent = 'Run Synthesis';
            await loadIntelligence();
          }
        } catch { /* keep polling */ }
        if (attempts > 60) {
          clearInterval(poll);
          btn.classList.remove('running');
          btn.textContent = 'Run Synthesis';
        }
      }, 2000);
    } catch {
      btn.classList.remove('running');
      btn.textContent = 'Run Synthesis';
    }
  });
}

// ── Start ──

document.addEventListener('DOMContentLoaded', init);
