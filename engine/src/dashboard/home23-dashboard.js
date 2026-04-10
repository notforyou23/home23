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

// ── Engine Pulse State ──
const enginePulse = {
  state: 'unknown',    // awake, sleeping, thinking
  phase: '',           // current activity description
  energy: 0,
  cycle: 0,
  lastEventTime: null, // Date of last engine event
  lastThought: null,   // timestamp of last thought
};

// ── Init ──

async function init() {
  updateClocks();
  setInterval(updateClocks, 10000);
  initParticles();
  await loadAgents();
  renderAgentTabs();
  setupTabHandlers();
  setupVibeActions();
  await loadHomeTiles();
  startAutoRefresh();
  updateCosmoIndicator();
  setInterval(updateCosmoIndicator, REFRESH_MS);

  // Initialize dashboard chat
  if (typeof initChat === 'function') {
    initChat('tile');
  }

  // Connect engine pulse SSE
  connectEnginePulse();

  // Update pulse "ago" timer every second
  setInterval(updatePulseAgo, 1000);
}

// ── Engine Pulse (Live Activity Indicator) ──

function connectEnginePulse() {
  // Connect directly to engine's WebSocket (port 5001) for real-time events
  const enginePort = primaryAgent ? primaryAgent.enginePort || 5001 : 5001;
  const wsUrl = `ws://${window.location.hostname}:${enginePort}`;
  let ws;
  let reconnectTimer = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const dot = document.getElementById('pulse-dot');
      if (dot && !dot.className.includes('awake') && !dot.className.includes('sleeping')) {
        dot.className = 'h23-pulse-dot awake';
      }
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') return; // welcome message
        enginePulse.lastEventTime = new Date();
        handleEngineEvent(data);
        renderPulse();
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      const dot = document.getElementById('pulse-dot');
      if (dot) dot.className = 'h23-pulse-dot';
      // Reconnect after 5 seconds
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 5000);
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnect
    };
  }

  connect();
}

function handleEngineEvent(data) {
  switch (data.type) {
    case 'cycle_start':
      enginePulse.cycle = data.cycle || enginePulse.cycle;
      enginePulse.state = data.mode === 'sleeping' ? 'sleeping' : 'awake';
      enginePulse.phase = 'starting cycle';
      if (data.cognitiveState) {
        enginePulse.energy = data.cognitiveState.energy || enginePulse.energy;
      }
      break;

    case 'thought_generated':
      enginePulse.state = data.role === 'sleep' ? 'sleeping' : 'thinking';
      enginePulse.phase = data.role === 'sleep'
        ? data.thought?.substring(0, 60) || 'resting'
        : `thinking (${data.role || 'focus'})`;
      enginePulse.cycle = data.cycle || enginePulse.cycle;
      enginePulse.lastThought = new Date();
      break;

    case 'sleep_triggered':
      enginePulse.state = 'sleeping';
      enginePulse.phase = 'entering sleep';
      enginePulse.energy = data.energy || enginePulse.energy;
      break;

    case 'wake_triggered':
      enginePulse.state = 'awake';
      enginePulse.phase = 'waking up';
      enginePulse.energy = data.energyRestored || enginePulse.energy;
      break;

    case 'coordinator_review':
      enginePulse.phase = 'strategic review';
      break;

    case 'executive_decision':
      enginePulse.phase = `executive: ${(data.action || '').toLowerCase()}`;
      break;

    case 'agent_spawned':
      enginePulse.phase = `spawning ${data.agentType || 'agent'}`;
      break;

    case 'agent_completed':
      enginePulse.phase = `${data.agentType || 'agent'} completed`;
      break;

    case 'dream_rewiring':
      enginePulse.state = 'sleeping';
      enginePulse.phase = 'dreaming (rewiring)';
      break;

    case 'cognitive_state_changed':
    case 'cognitive_state_update':
      if (data.energy !== undefined) enginePulse.energy = data.energy;
      if (data.mode) {
        enginePulse.state = data.mode === 'sleeping' ? 'sleeping' : 'awake';
      }
      if (data.newValue && data.metric === 'mode') {
        enginePulse.state = data.newValue === 'sleeping' ? 'sleeping' : 'awake';
      }
      break;

    case 'cycle_complete':
      enginePulse.phase = 'cycle complete';
      break;

    case 'node_created':
      enginePulse.phase = 'creating memory';
      break;
  }
}

// Cached pulse DOM elements (populated on first render)
let _pulseEls = null;
let _pulseRafPending = false;

function renderPulse() {
  // Throttle to one render per animation frame
  if (_pulseRafPending) return;
  _pulseRafPending = true;
  requestAnimationFrame(_renderPulseNow);
}

function _renderPulseNow() {
  _pulseRafPending = false;
  if (!_pulseEls) {
    _pulseEls = {
      dot: document.getElementById('pulse-dot'),
      state: document.getElementById('pulse-state'),
      phase: document.getElementById('pulse-phase'),
      energy: document.getElementById('pulse-energy'),
      cycle: document.getElementById('pulse-cycle'),
    };
  }
  if (!_pulseEls.dot) return;

  _pulseEls.dot.className = 'h23-pulse-dot ' + (enginePulse.state || '');
  _pulseEls.state.textContent = enginePulse.state || '—';
  _pulseEls.phase.textContent = enginePulse.phase || '—';
  _pulseEls.energy.textContent = `⚡ ${Math.round((enginePulse.energy || 0) * 100)}%`;
  _pulseEls.cycle.textContent = `cycle ${enginePulse.cycle || '—'}`;
}

function updatePulseAgo() {
  const ref = enginePulse.lastThought || enginePulse.lastEventTime;
  setText('pulse-ago', ref ? timeSince(ref) : '—');
}

// ── Clock ──

function updateClocks() {
  const agentTz = window.__agentTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const fmt = (tz) => now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true });
  const fmt24 = (tz) => now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

  const tz1Time = document.getElementById('tz1-time');
  if (tz1Time) tz1Time.textContent = fmt(agentTz);
  const tz1Label = document.getElementById('tz1-label');
  if (tz1Label) tz1Label.textContent = agentTz.split('/').pop().replace(/_/g, ' ');

  const secondaryTz = window.__secondaryTimezone;
  const tz2Container = document.getElementById('tz2-container');
  if (secondaryTz && tz2Container) {
    tz2Container.style.display = 'flex';
    const tz2Time = document.getElementById('tz2-time');
    if (tz2Time) tz2Time.textContent = fmt24(secondaryTz);
    const tz2Label = document.getElementById('tz2-label');
    if (tz2Label) tz2Label.textContent = secondaryTz.split('/').pop().replace(/_/g, ' ');
  }
}

// ── Particles ──

function initParticles() {
  if (typeof particlesJS === 'undefined') return;
  particlesJS('particles-js', {
    particles: {
      number: { value: 40, density: { enable: true, value_area: 1000 } },
      color: { value: ['#ffffff', '#007AFF', '#00C7BE', '#30D158'] },
      shape: { type: 'circle' },
      opacity: { value: 0.3, random: true, anim: { enable: true, speed: 1, opacity_min: 0.1, sync: false } },
      size: { value: 3, random: true, anim: { enable: true, speed: 2, size_min: 1, sync: false } },
      line_linked: { enable: true, distance: 200, color: '#ffffff', opacity: 0.15, width: 1 },
      move: { enable: true, speed: 0.8, direction: 'none', random: true, straight: false, out_mode: 'out', bounce: false }
    },
    interactivity: {
      detect_on: 'canvas',
      events: { onhover: { enable: true, mode: 'bubble' }, onclick: { enable: false }, resize: true },
      modes: { bubble: { distance: 200, size: 6, duration: 2, opacity: 0.6, speed: 3 } }
    },
    retina_detect: true
  });
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

  // Set agent name in thoughts tile
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
    const res = await fetch(`${cosmo23Url}/api/status`, { signal: AbortSignal.timeout(10000) });
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

      // Brain Map tab: initialize on first visit
      if (currentTab === 'brain-map') {
        if (typeof initBrainMap === 'function') initBrainMap();
      }

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

  // State → Home23 engine status indicator
  try {
    const state = await apiFetch(`${base}/api/state`);
    if (state) {
      updateSystemTile(state);
      updatePulseFromState(state);
      const dot = document.getElementById('engine-dot');
      if (dot) { dot.className = 'status-dot alive'; }
      const temporalState = state.temporal?.state || state.cognitiveState?.mode || 'awake';
      setText('engine-status-text', temporalState === 'sleeping' ? 'ENGINE · SLEEPING' : 'ENGINE');
    }
  } catch {
    const dot = document.getElementById('engine-dot');
    if (dot) { dot.className = 'status-dot dead'; }
    setText('engine-status-text', 'ENGINE offline');
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
      _cachedThoughts = thoughts;
      updateThoughtsTile(thoughts);
      updateBrainLog(thoughts);
    }
  } catch { /* offline */ }

  // Dreams
  try {
    const dreamData = await apiFetch(`${base}/api/dreams?limit=20`);
    if (dreamData) {
      const dreams = dreamData.dreams || dreamData || [];
      _cachedDreams = dreams;
      updateDreamLog(dreams);
    }
  } catch { /* offline */ }

  await loadVibeTile(primaryAgent, {
    imageId: 'home-vibe-image',
    captionId: 'home-vibe-caption',
    galleryHrefId: 'home-vibe-gallery-link',
  });
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

function updatePulseFromState(state) {
  // Feed pulse bar from state API (initial + polling fallback)
  const cs = state.cognitiveState || {};
  const temporal = state.temporal || {};
  enginePulse.cycle = state.cycleCount || enginePulse.cycle;
  enginePulse.energy = cs.energy || enginePulse.energy;
  if (temporal.state === 'sleeping' || cs.mode === 'sleeping') {
    enginePulse.state = 'sleeping';
  } else if (enginePulse.state === 'unknown') {
    enginePulse.state = 'awake';
  }
  if (!enginePulse.phase || enginePulse.phase === '—') {
    enginePulse.phase = state.oscillatorMode || 'focus';
  }
  const journal = state.journal || [];
  if (journal.length > 0) {
    const last = journal[journal.length - 1];
    if (last.timestamp) enginePulse.lastThought = new Date(last.timestamp);
  }
  renderPulse();
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

  // Update brain log timestamp
  const stamp = document.getElementById('brainlog-stamp');
  if (stamp) stamp.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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

// ── Dream Log ──

function updateDreamLog(dreams) {
  const container = document.getElementById('home-dreamlog');
  if (!container) return;

  const stamp = document.getElementById('dreamlog-stamp');
  if (stamp) stamp.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Filter to narrative dreams (with content), newest first
  const narratives = dreams
    .filter(d => d.content && d.content.length > 20)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  if (narratives.length === 0) {
    container.innerHTML = '<p class="h23-muted">No dreams yet — the agent dreams during sleep cycles.</p>';
    return;
  }

  container.innerHTML = narratives.slice(0, 10).map(d => {
    const time = d.timestamp
      ? new Date(d.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : (d.cycle ? `Cycle ${d.cycle}` : '');
    const cycle = d.cycle ? `cycle ${d.cycle}` : '';
    const meta = [time, cycle].filter(Boolean).join(' · ');
    const text = (d.content || d.thought || '').replace(/\*\*/g, '').replace(/\n/g, ' ').slice(0, 200);

    return `<div class="h23-dream-entry">
      <div class="h23-dream-meta">${meta}</div>
      <div class="h23-dream-text">${text}</div>
    </div>`;
  }).join('');
}

// ── Feeder Tile ──

let _cachedFeederData = null;

function updateFeederTile(data) {
  const container = document.getElementById('home-feeder');
  if (!container) return;

  const feeders = data.feeders || [];
  const feeder = feeders.find(f => f.member === primaryAgent.name) || feeders[0];

  if (!feeder) {
    container.innerHTML = '<p class="h23-muted">No feeder data</p>';
    return;
  }

  _cachedFeederData = feeder;
  const files = feeder.files || [];
  const compiled = feeder.compiledCount || 0;
  const total = feeder.totalFiles || 0;
  const processed = feeder.processedFiles || files.length;
  const pending = feeder.pendingCount || 0;
  const chunks = feeder.chunkCount || files.reduce((sum, f) => sum + (f.chunks || 0), 0);
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  // Most recent file
  const sorted = [...files].sort((a, b) => (b.lastIngested || '').localeCompare(a.lastIngested || ''));
  const recent = sorted[0];
  const recentName = recent ? recent.path.split('/').pop() : '';
  const recentAgo = recent?.lastIngested ? timeSince(new Date(recent.lastIngested)) : '';

  container.innerHTML = `
    <div class="h23-feeder-summary">
      <div class="h23-feeder-stat"><span class="value">${total}</span> in workspace</div>
      <div class="h23-feeder-stat"><span class="value${processed < total ? ' compiling' : ''}">${processed}</span> processed</div>
      <div class="h23-feeder-stat"><span class="value">${compiled}</span> compiled</div>
      <div class="h23-feeder-stat"><span class="value">${chunks}</span> nodes</div>
      <div class="h23-feeder-progress">
        <div class="h23-feeder-progress-bar"><div class="h23-feeder-progress-fill" style="width:${pct}%"></div></div>
        <div class="h23-feeder-progress-label">${processed} of ${total} · ${pending > 0 ? pending + ' remaining' : 'complete'}</div>
      </div>
    </div>
    ${recentName ? `<div class="h23-feeder-recent">Latest: <span class="filename">${recentName}</span> · ${recentAgo}</div>` : ''}
  `;
}

function openFeederOverlay() {
  const overlay = document.getElementById('feeder-overlay');
  const body = document.getElementById('feeder-overlay-body');
  if (!overlay || !body) return;

  if (!_cachedFeederData) {
    body.innerHTML = '<p class="h23-muted">No feeder data available</p>';
    overlay.style.display = 'flex';
    return;
  }

  const f = _cachedFeederData;
  const files = f.files || [];
  const compiled = f.compiledCount || 0;
  const quarantined = f.quarantinedCount || 0;
  const total = f.totalFiles || 0;
  const processed = f.processedFiles || files.length;
  const chunks = f.chunkCount || files.reduce((sum, x) => sum + (x.chunks || 0), 0);
  const pending = f.pendingCount || 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  const sorted = [...files].sort((a, b) => (b.lastIngested || '').localeCompare(a.lastIngested || ''));

  body.innerHTML = `
    <div class="h23-feeder-overlay-stats">
      <div class="h23-feeder-stat"><span class="value">${total}</span> in workspace</div>
      <div class="h23-feeder-stat"><span class="value${processed < total ? ' compiling' : ''}">${processed}</span> processed</div>
      <div class="h23-feeder-stat"><span class="value">${compiled}</span> compiled</div>
      <div class="h23-feeder-stat"><span class="value">${chunks}</span> brain nodes</div>
      <div class="h23-feeder-stat"><span class="value">${pending}</span> remaining</div>
      ${quarantined ? `<div class="h23-feeder-stat"><span class="value" style="color:#fb923c">${quarantined}</span> quarantined</div>` : ''}
    </div>
    <div class="h23-feeder-progress" style="margin-bottom:16px">
      <div class="h23-feeder-progress-bar"><div class="h23-feeder-progress-fill" style="width:${pct}%"></div></div>
      <div class="h23-feeder-progress-label">${processed} of ${total} files processed · ${compiled} through LLM compiler</div>
    </div>
    <div class="h23-feeder-overlay-section">
      <h3>Recent Files (${Math.min(sorted.length, 50)} shown)</h3>
      <div class="h23-feeder-file-list">
        ${sorted.map(x => {
          const name = x.path.split('/').pop();
          const dir = x.path.split('/').slice(-2, -1)[0] || '';
          const ago = x.lastIngested ? timeSince(new Date(x.lastIngested)) : '—';
          const isQuarantined = x.status === 'suspect_truncation' || x.status === 'un_normalizable';
          const badge = isQuarantined
            ? '<span class="badge quarantined">quarantined</span>'
            : x.compiled
              ? '<span class="badge compiled">compiled</span>'
              : '<span class="badge raw">raw</span>';
          return `<div class="h23-feeder-file">
            <span class="path" title="${x.path}">${dir ? dir + '/' : ''}${name}</span>
            <span class="meta">
              ${badge}
              <span class="chunks">${x.chunks || 0} chunks</span>
              <span class="ago">${ago}</span>
            </span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;

  overlay.style.display = 'flex';
}

function closeFeederOverlay() {
  const overlay = document.getElementById('feeder-overlay');
  if (overlay) overlay.style.display = 'none';
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
        <div class="h23-vibe-image" id="vibe-image-${agentName}"><span class="h23-vibe-placeholder">Generating...</span></div>
        <div class="h23-vibe-caption" id="vibe-caption-${agentName}"></div>
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

  await loadVibeTile(agent, {
    imageId: `vibe-image-${agentName}`,
    captionId: `vibe-caption-${agentName}`,
  });
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

function setupVibeActions() {
  const galleryLink = document.getElementById('home-vibe-gallery-link');
  if (galleryLink) {
    galleryLink.href = '/home23/vibe-gallery';
  }

  const vibeTrigger = document.getElementById('vibe-trigger');
  if (vibeTrigger) {
    vibeTrigger.addEventListener('click', async (event) => {
      if (event.detail !== 3) return;
      await triggerVibeGeneration();
    });
  }
}

async function triggerVibeGeneration() {
  setText('home-vibe-caption', 'Generating a fresh chaos vibe...');

  try {
    await fetch('/home23/api/vibe/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    await loadVibeTile(primaryAgent, {
      imageId: 'home-vibe-image',
      captionId: 'home-vibe-caption',
      galleryHrefId: 'home-vibe-gallery-link',
    });
  } catch (err) {
    setText('home-vibe-caption', `Generation failed: ${err.message}`);
  }
}

async function loadVibeTile(agent, { imageId, captionId, galleryHrefId = null }) {
  const base = apiBase(agent);
  const imageEl = document.getElementById(imageId);
  const captionEl = document.getElementById(captionId);
  const galleryHref = galleryHrefId ? document.getElementById(galleryHrefId) : null;
  if (!imageEl || !captionEl) return;

  if (galleryHref) {
    galleryHref.href = `${base}/home23/vibe-gallery`;
  }

  try {
    const data = await apiFetch(`${base}/home23/api/vibe/current`);
    const galleryUrl = `${base}/home23/vibe-gallery`;

    if (data?.item?.url) {
      imageEl.innerHTML = `<img src="${data.item.url}" alt="Vibe image for ${agent.displayName || agent.name}" loading="lazy">`;
      imageEl.classList.add('clickable');
      imageEl.onclick = () => { window.location.href = galleryUrl; };
      captionEl.textContent = data.item.caption || 'Latest chaos vibe';
      return;
    }

    imageEl.classList.remove('clickable');
    imageEl.onclick = null;
    const placeholder = data?.generating
      ? 'Conjuring a new chaos vibe...'
      : 'No image yet';
    imageEl.innerHTML = `<span class="h23-vibe-placeholder">${placeholder}</span>`;
    captionEl.textContent = data?.generating
      ? 'A fresh vibe image is being generated in the background.'
      : 'The gallery is empty. The dashboard will seed it on the next generation window.';
  } catch {
    imageEl.classList.remove('clickable');
    imageEl.onclick = null;
    imageEl.innerHTML = '<span class="h23-vibe-placeholder">Vibe offline</span>';
    captionEl.textContent = 'Could not load the current vibe image.';
  }
}

// ── Log Overlay ──

// Cache the last fetched data for overlay rendering
let _cachedThoughts = [];
let _cachedDreams = [];

function openLogOverlay(type) {
  const overlay = document.getElementById('log-overlay');
  const title = document.getElementById('log-overlay-title');
  const body = document.getElementById('log-overlay-body');
  if (!overlay || !body) return;

  if (type === 'brain') {
    title.textContent = '🧠 BRAIN LOG';
    const thoughts = _cachedThoughts;
    if (thoughts.length === 0) {
      body.innerHTML = '<p class="h23-muted">No thoughts yet.</p>';
    } else {
      const reversed = [...thoughts].reverse();
      body.innerHTML = reversed.map(t => {
        const text = t.thought || t.content || t.text || '';
        const role = t.role || '';
        const time = t.timestamp
          ? new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : '';
        const cycle = t.cycle ? `cycle ${t.cycle}` : '';
        return `<div class="h23-log-entry-full">
          <div class="h23-log-entry-full-meta">
            <span>${time}</span>
            <span class="h23-log-entry-full-role">${role}</span>
            <span>${cycle}</span>
          </div>
          <div class="h23-log-entry-full-text">${text}</div>
        </div>`;
      }).join('');
    }
  } else if (type === 'dream') {
    title.textContent = '💭 DREAM LOG';
    const dreams = _cachedDreams.filter(d => d.content && d.content.length > 20);
    if (dreams.length === 0) {
      body.innerHTML = '<p class="h23-muted">No dreams yet — the agent dreams during sleep cycles.</p>';
    } else {
      const sorted = [...dreams].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      body.innerHTML = sorted.map(d => {
        const time = d.timestamp
          ? new Date(d.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : '';
        const cycle = d.cycle ? `cycle ${d.cycle}` : '';
        const meta = [time, cycle].filter(Boolean).join(' · ');
        const text = (d.content || d.thought || '').replace(/\n/g, '<br>');
        return `<div class="h23-dream-entry-full">
          <div class="h23-dream-entry-full-meta">${meta}</div>
          <div class="h23-dream-entry-full-text">${text}</div>
        </div>`;
      }).join('');
    }
  }

  overlay.classList.add('active');
}

function closeLogOverlay() {
  const overlay = document.getElementById('log-overlay');
  if (overlay) overlay.classList.remove('active');
}

async function apiFetch(url) {
  // 15s timeout — /api/state serializes the full brain and can take several seconds
  // over Tailscale / LAN when the brain has thousands of nodes
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
