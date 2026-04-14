/**
 * Home23 Dashboard — Vanilla JS
 *
 * Primary agent view on Home tab (ReginaCosmo layout).
 * COSMO 2.3 embedded via iframe on COSMO tab.
 * Secondary agent tabs created on demand.
 */

// ── Config ──

const REFRESH_MS = 30000;
const HOME_THOUGHT_ROTATE_MS = 16000;
let agents = [];
let primaryAgent = null;
let currentTab = 'home';
let cosmo23Url = '';
let evobrewUrl = '';
let cosmo23Loaded = false;
let cosmoOnline = false;
let intelRefreshInterval = null;
let homeThoughtRotationTimer = null;
let homeTileLayout = [];
let homeTileLayoutSignature = '';
let homeTileCustomRefreshers = new Map();
let homeTileCustomState = new Map();
let tileActionDialogState = null;
let homeTileBroadcast = null;

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
  setupHomeLayoutHandlers();
  setupTileActionHandlers();
  setupHomeTileBroadcast();
  await loadHomeLayoutConfig({ force: true });
  connectEnginePulse();
  loadHomeTiles().catch(() => { /* initial home load is best-effort */ });
  startHomeThoughtRotation();
  startAutoRefresh();
  updateCosmoIndicator();
  setInterval(updateCosmoIndicator, REFRESH_MS);

  // Update pulse "ago" timer every second
  setInterval(updatePulseAgo, 1000);

  // Check for Home23 updates
  checkUpdateNotification();

  // Poll notifications (pending thought-actions from cognitive cycles)
  updateNotificationBadge();
  setInterval(updateNotificationBadge, 15000);
}

// ── Notifications (thought-action queue) ──

async function updateNotificationBadge() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/notifications`);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById('pulse-notifs');
    const badge = document.getElementById('pulse-notifs-badge');
    if (!el || !badge) return;
    if (data.pending > 0) {
      el.style.display = '';
      badge.textContent = `🔔 ${data.pending}`;
      badge.style.color = data.pending > 5 ? '#ffb347' : '#5ac8fa';
    } else {
      el.style.display = 'none';
    }
  } catch { /* silent — dashboard refresh handles retries */ }
}

async function openNotificationsPanel() {
  const overlay = document.getElementById('notifications-overlay');
  const list = document.getElementById('notifications-list');
  if (!overlay || !list) return;
  overlay.style.display = 'flex';
  list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/notifications`);
    const data = await r.json();
    if (!data.items || data.items.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">No notifications yet. Cognitive cycles will queue action proposals here.</div>';
      return;
    }
    list.innerHTML = data.items.map(n => {
      const ts = new Date(n.ts).toLocaleString();
      const roleIcon = { curiosity: '❓', analyst: '🔬', critic: '⚠️', curator: '📋', proposal: '⚡' }[n.source] || '🧠';
      const opacity = n.acknowledged ? '0.4' : '1';
      const bgColor = n.acknowledged ? 'transparent' : 'rgba(0,122,255,0.05)';
      return `
        <div style="padding:10px 12px;margin-bottom:8px;background:${bgColor};border-left:3px solid ${n.acknowledged ? 'rgba(255,255,255,0.1)' : '#5ac8fa'};opacity:${opacity};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div style="flex:1;">
              <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:4px;">
                ${roleIcon} ${n.source} · cycle ${n.cycle} · ${ts}
              </div>
              <div style="color:#fff;">${escapeHtmlNotif(n.message)}</div>
            </div>
            ${n.acknowledged ? '<span style="color:rgba(255,255,255,0.4);font-size:11px;">✓ ack</span>' : `<button onclick="ackNotification('${n.id}')" style="background:rgba(255,255,255,0.1);border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Ack</button>`}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

function escapeHtmlNotif(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function closeNotificationsPanel() {
  const overlay = document.getElementById('notifications-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function ackNotification(id) {
  try {
    await fetch(`${dashboardBaseUrl()}/api/notifications/${id}/ack`, { method: 'POST' });
    openNotificationsPanel();
    updateNotificationBadge();
  } catch {}
}

async function acknowledgeAllNotifications() {
  try {
    await fetch(`${dashboardBaseUrl()}/api/notifications/ack-all`, { method: 'POST' });
    openNotificationsPanel();
    updateNotificationBadge();
  } catch {}
}

function dashboardBaseUrl() {
  return `http://${window.location.hostname}:${window.location.port || 5002}`;
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
      if (!enginePulse.state || enginePulse.state === 'unknown') {
        enginePulse.state = 'awake';
        renderPulse();
      }
      setEngineOnlineStatus(enginePulse.state);
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
      setEngineOfflineStatus();
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

function setEngineOnlineStatus(temporalState = 'awake') {
  const dot = document.getElementById('engine-dot');
  if (dot) dot.className = 'status-dot alive';
  setText('engine-status-text', temporalState === 'sleeping' ? 'ENGINE · SLEEPING' : 'ENGINE');
}

function setEngineOfflineStatus() {
  const dot = document.getElementById('engine-dot');
  if (dot) dot.className = 'status-dot dead';
  setText('engine-status-text', 'ENGINE offline');
}

async function fetchEngineHealth(agent) {
  const enginePort = agent ? agent.enginePort || 5001 : 5001;
  return apiFetch(`http://${window.location.hostname}:${enginePort}/health`, { timeoutMs: 3000 });
}

function seedPulseFromSummary(summary, engineHealth = null) {
  if (!summary && !engineHealth) return;

  if (summary?.cycleCount && (!enginePulse.cycle || enginePulse.cycle < summary.cycleCount)) {
    enginePulse.cycle = summary.cycleCount;
  }

  if (summary?.lastThoughtAt && !enginePulse.lastThought) {
    enginePulse.lastThought = new Date(summary.lastThoughtAt);
  }

  if ((!enginePulse.state || enginePulse.state === 'unknown') && summary?.temporalState) {
    enginePulse.state = summary.temporalState;
  } else if ((!enginePulse.state || enginePulse.state === 'unknown') && engineHealth) {
    enginePulse.state = 'awake';
  }

  if (!enginePulse.phase && summary?.lastThoughtRole) {
    enginePulse.phase = summary.lastThoughtRole === 'sleep'
      ? 'resting'
      : `thinking (${summary.lastThoughtRole})`;
  }

  renderPulse();
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
  const primaryAgentName = document.getElementById('primary-agent-name');
  if (primaryAgentName) {
    primaryAgentName.textContent = primaryAgent.displayName || primaryAgent.name;
  }

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
  if (wrap) wrap.style.display = 'block';

  if (cosmoOnline) {
    // Online — show iframe, hide offline overlay
    hideCosmoOfflineOverlay();
    if (!cosmo23Loaded && cosmo23Url) {
      frame.src = cosmo23Url;
      cosmo23Loaded = true;
    }
  } else {
    // Offline — show actionable overlay instead of blank iframe
    showCosmoOfflineOverlay();
  }
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

function showCosmoOfflineOverlay() {
  let overlay = document.getElementById('cosmo23-offline-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cosmo23-offline-overlay';
    overlay.style.cssText = 'position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(10,10,18,0.95); gap:16px;';
    overlay.innerHTML = `
      <div style="font-size:36px; opacity:0.4;">&#x1F52C;</div>
      <div style="font-size:16px; color:#ccc; font-weight:500;">COSMO 2.3 is offline</div>
      <div id="cosmo23-offline-detail" style="font-size:13px; color:#888; max-width:400px; text-align:center;">The research engine process is not running.</div>
      <button id="cosmo23-restart-btn" style="margin-top:8px; padding:8px 24px; background:rgba(99,102,241,0.25); border:1px solid rgba(99,102,241,0.5); color:#a5b4fc; border-radius:8px; font-size:14px; cursor:pointer; transition:all 0.15s;">Start COSMO 2.3</button>
      <div id="cosmo23-restart-status" style="font-size:12px; color:#888; min-height:18px;"></div>
    `;
    const wrap = document.getElementById('cosmo23-frame-wrap');
    if (wrap) wrap.appendChild(overlay);

    // Wire restart button
    overlay.querySelector('#cosmo23-restart-btn').addEventListener('click', restartCosmo23);
  }
  overlay.style.display = 'flex';
  // Hide iframe behind overlay
  const frame = document.getElementById('cosmo23-frame');
  if (frame) frame.style.visibility = 'hidden';
}

function hideCosmoOfflineOverlay() {
  const overlay = document.getElementById('cosmo23-offline-overlay');
  if (overlay) overlay.style.display = 'none';
  const frame = document.getElementById('cosmo23-frame');
  if (frame) frame.style.visibility = 'visible';
}

async function restartCosmo23() {
  const btn = document.getElementById('cosmo23-restart-btn');
  const status = document.getElementById('cosmo23-restart-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
  if (status) status.textContent = '';
  try {
    const res = await fetch('/home23/api/settings/cosmo23/restart', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (status) status.textContent = 'Started. Connecting...';
      // Give it a moment to bind the port, then recheck
      setTimeout(async () => {
        await updateCosmoIndicator();
        if (cosmoOnline) {
          hideCosmoOfflineOverlay();
          cosmo23Loaded = false;
          const frame = document.getElementById('cosmo23-frame');
          if (frame && cosmo23Url) { frame.src = cosmo23Url; cosmo23Loaded = true; }
        } else {
          if (status) status.textContent = 'Process started but not yet responding. Try refreshing in a few seconds.';
          if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
        }
      }, 3000);
    } else {
      if (status) status.textContent = `Error: ${data.error || 'unknown'}`;
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    }
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
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
    cosmoOnline = true;
    if (status.running && status.activeContext) {
      dot.className = 'h23-cosmo-indicator-dot running';
      text.textContent = `COSMO: running — ${status.activeContext.runName || 'research'}`;
    } else {
      dot.className = 'h23-cosmo-indicator-dot';
      text.textContent = 'COSMO: idle';
    }
    // If we just came back online and the tab is showing, refresh
    if (currentTab === 'cosmo23') hideCosmoOfflineOverlay();
  } catch {
    cosmoOnline = false;
    dot.className = 'h23-cosmo-indicator-dot error';
    text.textContent = 'COSMO: offline';
    // If viewing the COSMO tab right now, show the overlay
    if (currentTab === 'cosmo23') showCosmoOfflineOverlay();
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

function layoutHasTile(tileId) {
  return homeTileLayout.some((item) => item.tileId === tileId);
}

function fallbackHomeLayout() {
  return [
    { tileId: 'thought-feed', size: 'third', tile: { id: 'thought-feed', kind: 'core' } },
    { tileId: 'vibe', size: 'third', tile: { id: 'vibe', kind: 'core' } },
    { tileId: 'chat', size: 'third', tile: { id: 'chat', kind: 'core' } },
    { tileId: 'system-summary', size: 'full', tile: { id: 'system-summary', kind: 'core' } },
    { tileId: 'brain-log', size: 'half', tile: { id: 'brain-log', kind: 'core' } },
    { tileId: 'dream-log', size: 'half', tile: { id: 'dream-log', kind: 'core' } },
    { tileId: 'feeder', size: 'full', tile: { id: 'feeder', kind: 'core' } },
  ];
}

function getVisibleCustomTiles() {
  return homeTileLayout.filter((item) => item?.tile?.kind === 'custom');
}

function getHomeTile(tileId) {
  return homeTileLayout.find((item) => item.tileId === tileId)?.tile || null;
}

function renderThoughtFeedTile() {
  return `
    <div class="h23-tile h23-tile-thoughts">
      <div class="h23-tile-header">🌊 <span id="primary-agent-name">${escapeHtml(primaryAgent?.displayName || primaryAgent?.name || 'Agent')}</span></div>
      <div class="h23-thought-text" id="home-thought">Loading...</div>
      <div class="h23-thought-meta" id="home-thought-meta"></div>
    </div>
  `;
}

function renderVibeTile() {
  return `
    <div class="h23-tile h23-tile-vibe">
      <div class="h23-tile-header"><span id="vibe-trigger">🎨 Vibe</span></div>
      <div class="h23-vibe-image" id="home-vibe-image">
        <span class="h23-vibe-placeholder">Generating...</span>
      </div>
      <div class="h23-vibe-caption" id="home-vibe-caption"></div>
      <div class="h23-vibe-actions">
        <a class="h23-vibe-action" id="home-vibe-gallery-link" href="/home23/vibe-gallery">Gallery</a>
      </div>
    </div>
  `;
}

function renderChatTile() {
  return `
    <div class="h23-tile h23-tile-chat" id="tile-chat">
      <div class="h23-chat-header">
        <div class="h23-chat-selects">
          <select class="h23-chat-agent-select" id="chat-agent-select">
            <option>Loading...</option>
          </select>
          <select class="h23-chat-model-select" id="chat-model-select">
            <option>model</option>
          </select>
        </div>
        <div class="h23-chat-actions">
          <button class="h23-chat-expand-btn" id="chat-new-btn" type="button" title="New conversation" onclick="newConversation()">+</button>
          <button class="h23-chat-expand-btn" id="chat-history-btn" type="button" title="Conversation history" onclick="toggleConversationList()">&#9776;</button>
          <button class="h23-chat-expand-btn" id="chat-expand-btn" type="button" title="Expand">&#8599;</button>
        </div>
      </div>
      <div class="h23-chat-conv-panel" id="chat-conv-panel">
        <div style="padding:10px 14px;border-bottom:1px solid var(--glass-border);display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">History</span>
          <button class="h23-chat-expand-btn" type="button" onclick="toggleConversationList()" title="Close" style="width:24px;height:24px;font-size:12px;">&#10005;</button>
        </div>
        <div class="h23-chat-conv-list" id="chat-conv-list"></div>
      </div>
      <div class="h23-chat-messages" id="chat-messages">
        <div class="h23-chat-empty">Loading...</div>
      </div>
      <div class="h23-chat-input-area" id="chat-input-area">
        <textarea class="h23-chat-input" id="chat-input" placeholder="Message your agent..." rows="1"></textarea>
        <button class="h23-chat-send-btn" id="chat-send-btn" type="button">&#9654;</button>
      </div>
    </div>
  `;
}

function renderSystemSummaryTile() {
  return `
    <div class="h23-tile h23-tile-system-summary">
      <div class="h23-tile-header"><span class="icon">⚡</span> System Summary</div>
      <div class="h23-system-bar" id="system-bar">
        <div class="h23-system-bar-item"><label>Uptime</label><div class="value" id="sys-uptime">—</div></div>
        <div class="h23-system-bar-item"><label>Thoughts</label><div class="value" id="sys-thoughts">—</div></div>
        <div class="h23-system-bar-item"><label>Nodes</label><div class="value" id="sys-nodes">—</div></div>
        <div class="h23-system-bar-item"><label>Last</label><div class="value" id="sys-last">—</div></div>
      </div>
      <div class="h23-system-summary-excerpt" id="sys-excerpt"></div>
    </div>
  `;
}

function renderBrainLogTile() {
  return `
    <div class="h23-tile h23-tile-brainlog h23-tile-log" onclick="openLogOverlay('brain')">
      <div class="h23-brainlog-header">
        <span class="h23-brainlog-title">🧠 BRAIN LOG</span>
        <span class="h23-brainlog-stamp" id="brainlog-stamp"></span>
      </div>
      <div class="h23-brain-log" id="home-brainlog">
        <p class="h23-muted">Loading...</p>
      </div>
    </div>
  `;
}

function renderDreamLogTile() {
  return `
    <div class="h23-tile h23-tile-brainlog h23-tile-log" onclick="openLogOverlay('dream')">
      <div class="h23-brainlog-header">
        <span class="h23-brainlog-title">💭 DREAM LOG</span>
        <span class="h23-brainlog-stamp" id="dreamlog-stamp"></span>
      </div>
      <div class="h23-dream-log" id="home-dreamlog">
        <p class="h23-muted">Loading...</p>
      </div>
    </div>
  `;
}

function renderFeederTile() {
  return `
    <div class="h23-tile h23-tile-feeder h23-tile-log" id="tile-feeder" onclick="openFeederOverlay()">
      <div class="h23-tile-header"><span class="icon">📥</span> Ingestion Compiler</div>
      <div id="home-feeder">
        <p class="h23-muted">Loading...</p>
      </div>
    </div>
  `;
}

function renderCustomTile(tile) {
  const safeId = tile.id;
  const refreshSeconds = Math.max(5, Math.round((tile.refreshMs || REFRESH_MS) / 1000));

  return `
    <div class="h23-tile h23-tile-custom" id="tile-custom-${safeId}" data-custom-tile-id="${safeId}">
      <div class="h23-tile-header"><span class="icon">${escapeHtml(tile.icon || '🧩')}</span> ${escapeHtml(tile.title || safeId)}</div>
      <div class="h23-custom-status" id="tile-custom-status-${safeId}">Loading...</div>
      <div class="h23-custom-value" id="tile-custom-value-${safeId}">—</div>
      <div class="h23-custom-subtitle" id="tile-custom-subtitle-${safeId}">Connecting to ${escapeHtml(tile.mode)}…</div>
      <div class="h23-custom-metrics" id="tile-custom-metrics-${safeId}"></div>
      <div class="h23-custom-actions" id="tile-custom-actions-${safeId}"></div>
      <div class="h23-custom-footer">
        <span id="tile-custom-cache-${safeId}">refresh ${refreshSeconds}s</span>
        <span id="tile-custom-updated-${safeId}"></span>
      </div>
    </div>
  `;
}

function renderHomeLayoutItem(item) {
  const sizeClass = `h23-home-size-${item.size || 'third'}`;
  let markup = '';

  switch (item.tileId) {
    case 'thought-feed':
      markup = renderThoughtFeedTile();
      break;
    case 'vibe':
      markup = renderVibeTile();
      break;
    case 'chat':
      markup = renderChatTile();
      break;
    case 'system-summary':
      markup = renderSystemSummaryTile();
      break;
    case 'brain-log':
      markup = renderBrainLogTile();
      break;
    case 'dream-log':
      markup = renderDreamLogTile();
      break;
    case 'feeder':
      markup = renderFeederTile();
      break;
    default:
      markup = renderCustomTile(item.tile || {});
      break;
  }

  return `<section class="h23-home-item ${sizeClass}" data-home-tile-id="${escapeHtml(item.tileId)}">${markup}</section>`;
}

function renderHomeLayout(layout) {
  const host = document.getElementById('home-layout-grid');
  if (!host) return;

  homeTileLayout = Array.isArray(layout) ? layout : [];
  host.innerHTML = homeTileLayout.map(renderHomeLayoutItem).join('');

  const primaryNameEl = document.getElementById('primary-agent-name');
  if (primaryNameEl && primaryAgent) {
    primaryNameEl.textContent = primaryAgent.displayName || primaryAgent.name;
  }

  setupVibeActions();
  syncCustomTileRefreshers();

  if (layoutHasTile('chat') && typeof initChat === 'function') {
    Promise.resolve(initChat('tile')).catch(() => { /* best effort */ });
  } else if (typeof closeOverlay === 'function') {
    closeOverlay();
  }

  loadVisibleCustomTiles().catch(() => { /* best effort */ });
}

async function loadHomeLayoutConfig({ force = false } = {}) {
  const config = await apiFetch('/home23/api/tiles/config', { timeoutMs: 4000 });
  if (!config?.layout) {
    if (homeTileLayout.length === 0) {
      renderHomeLayout(fallbackHomeLayout());
      homeTileLayoutSignature = 'fallback';
      return true;
    }
    return false;
  }

  const signature = JSON.stringify(config.layout);
  if (!force && signature === homeTileLayoutSignature) {
    return false;
  }

  homeTileLayoutSignature = signature;
  renderHomeLayout(config.layout);
  return true;
}

function setupHomeLayoutHandlers() {
  const host = document.getElementById('home-layout-grid');
  if (!host || host.dataset.bound === 'true') return;

  host.addEventListener('click', (event) => {
    const actionBtn = event.target.closest('[data-tile-action-id]');
    if (!actionBtn) return;
    openTileActionDialog(actionBtn.dataset.tileId, actionBtn.dataset.tileActionId);
  });

  host.dataset.bound = 'true';
}

function setupHomeTileBroadcast() {
  if (typeof BroadcastChannel === 'undefined') return;
  homeTileBroadcast = new BroadcastChannel('home23-dashboard-tiles');
  homeTileBroadcast.addEventListener('message', async () => {
    try {
      await loadHomeLayoutConfig();
      await loadHomeTiles();
      await loadVisibleCustomTiles();
    } catch {
      /* best effort */
    }
  });
}

function syncCustomTileRefreshers() {
  const nextTiles = new Map(getVisibleCustomTiles().map((item) => [item.tile.id, item.tile.refreshMs || REFRESH_MS]));

  for (const [tileId, entry] of homeTileCustomRefreshers.entries()) {
    if (!nextTiles.has(tileId) || nextTiles.get(tileId) !== entry.refreshMs) {
      clearInterval(entry.timer);
      homeTileCustomRefreshers.delete(tileId);
      homeTileCustomState.delete(tileId);
    }
  }

  for (const [tileId, refreshMs] of nextTiles.entries()) {
    if (homeTileCustomRefreshers.has(tileId)) continue;
    const timer = setInterval(() => {
      loadCustomTileData(tileId).catch(() => { /* tile-local errors are rendered in-place */ });
    }, refreshMs);
    homeTileCustomRefreshers.set(tileId, { timer, refreshMs });
  }
}

async function loadVisibleCustomTiles() {
  const tiles = getVisibleCustomTiles();
  await Promise.all(tiles.map((item) => loadCustomTileData(item.tile.id).catch(() => null)));
}

function renderCustomTileMetrics(tileId, metrics) {
  const host = document.getElementById(`tile-custom-metrics-${tileId}`);
  if (!host) return;

  if (!Array.isArray(metrics) || metrics.length === 0) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = metrics.map((metric) => `
    <div class="h23-custom-metric">
      <span class="h23-custom-metric-label">${escapeHtml(metric.label || 'Metric')}</span>
      <span class="h23-custom-metric-value">${escapeHtml(metric.value ?? '—')}</span>
    </div>
  `).join('');
}

function renderCustomTileActions(tileId, actions) {
  const host = document.getElementById(`tile-custom-actions-${tileId}`);
  if (!host) return;

  if (!Array.isArray(actions) || actions.length === 0) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = actions.map((action) => `
    <button class="h23-custom-action-btn" type="button" data-tile-id="${escapeHtml(tileId)}" data-tile-action-id="${escapeHtml(action.id)}">
      ${escapeHtml(action.label || action.id)}
    </button>
  `).join('');
}

function renderCustomTileData(tileId, payload) {
  const tileEl = document.getElementById(`tile-custom-${tileId}`);
  if (!tileEl) return;

  const content = payload?.content || {};
  tileEl.classList.remove('is-error');
  setText(`tile-custom-status-${tileId}`, content.status ?? 'Live');
  setText(`tile-custom-value-${tileId}`, content.value ?? '—');
  setText(`tile-custom-subtitle-${tileId}`, content.subtitle ?? '');
  setText(`tile-custom-cache-${tileId}`, payload?.cache?.hit
    ? `cached · ${Math.round((payload.cache.refreshMs || REFRESH_MS) / 1000)}s ttl`
    : `refresh ${Math.round((payload?.cache?.refreshMs || getHomeTile(tileId)?.refreshMs || REFRESH_MS) / 1000)}s`);
  setText(`tile-custom-updated-${tileId}`, payload?.fetchedAt ? `Updated ${timeSince(new Date(payload.fetchedAt))}` : '');
  renderCustomTileMetrics(tileId, content.metrics || []);
  renderCustomTileActions(tileId, payload?.actions || []);

  homeTileCustomState.set(tileId, {
    ...(homeTileCustomState.get(tileId) || {}),
    payload,
  });
}

function renderCustomTileError(tileId, error) {
  const tileEl = document.getElementById(`tile-custom-${tileId}`);
  if (!tileEl) return;

  tileEl.classList.add('is-error');
  setText(`tile-custom-status-${tileId}`, 'Unavailable');
  setText(`tile-custom-value-${tileId}`, '—');
  setText(`tile-custom-subtitle-${tileId}`, error?.message || 'Tile request failed');
  setText(`tile-custom-cache-${tileId}`, 'retrying automatically');
  setText(`tile-custom-updated-${tileId}`, '');
  renderCustomTileMetrics(tileId, []);
  renderCustomTileActions(tileId, []);
}

async function loadCustomTileData(tileId) {
  try {
    const res = await fetch(`/home23/api/tiles/${encodeURIComponent(tileId)}/data`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Tile request failed (${res.status})`);
    }
    renderCustomTileData(tileId, data);
    return data;
  } catch (err) {
    renderCustomTileError(tileId, err);
    throw err;
  }
}

function buildTileActionFieldInput(field) {
  if (field.type === 'boolean') {
    return `
      <label class="h23-tile-action-checkbox">
        <input type="checkbox" data-tile-action-input="${escapeHtml(field.id)}" ${field.defaultValue ? 'checked' : ''}>
        <span>${escapeHtml(field.label)}</span>
      </label>
    `;
  }

  const inputType = field.type === 'number' ? 'number' : 'text';
  const value = field.defaultValue ?? '';
  return `
    <label>${escapeHtml(field.label)}</label>
    <input type="${inputType}" data-tile-action-input="${escapeHtml(field.id)}" value="${escapeHtml(value)}" ${field.required ? 'required' : ''}>
  `;
}

function openTileActionDialog(tileId, actionId) {
  const tile = getHomeTile(tileId);
  const runtimeState = homeTileCustomState.get(tileId);
  const action = runtimeState?.payload?.actions?.find((entry) => entry.id === actionId);
  if (!tile || !action) return;

  const requiresDialog = (action.fields && action.fields.length > 0) || action.confirmationText || action.method !== 'GET';
  if (!requiresDialog) {
    runTileAction(tileId, actionId).catch(() => {});
    return;
  }

  tileActionDialogState = { tileId, tile, action };
  setText('tile-action-title', `${tile.title} · ${action.label}`);
  setText('tile-action-confirmation', action.confirmationText || (action.method !== 'GET' ? 'Confirm this action.' : ''));

  const form = document.getElementById('tile-action-form');
  if (form) {
    form.innerHTML = (action.fields || []).map((field) => `
      <div class="h23-tile-action-field">
        ${buildTileActionFieldInput(field)}
      </div>
    `).join('');
  }

  setText('tile-action-status', '');
  document.getElementById('tile-action-overlay')?.classList.add('active');
}

function closeTileActionOverlay() {
  tileActionDialogState = null;
  document.getElementById('tile-action-overlay')?.classList.remove('active');
}

function collectTileActionDialogInput() {
  const inputs = document.querySelectorAll('[data-tile-action-input]');
  const values = {};
  inputs.forEach((input) => {
    const key = input.dataset.tileActionInput;
    if (!key) return;
    if (input.type === 'checkbox') {
      values[key] = input.checked;
    } else if (input.type === 'number') {
      values[key] = input.value === '' ? '' : Number(input.value);
    } else {
      values[key] = input.value;
    }
  });
  return values;
}

async function runTileAction(tileId, actionId, input = {}) {
  const actionState = homeTileCustomState.get(tileId)?.payload?.actions?.find((entry) => entry.id === actionId);
  const statusEl = document.getElementById('tile-action-status');
  const submitBtn = document.getElementById('tile-action-submit');

  if (statusEl) statusEl.textContent = 'Running action...';
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch(`/home23/api/tiles/${encodeURIComponent(tileId)}/actions/${encodeURIComponent(actionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Action failed (${res.status})`);
    }

    if (data.data) {
      renderCustomTileData(tileId, data.data);
    } else {
      await loadCustomTileData(tileId);
    }

    if (statusEl) statusEl.textContent = actionState?.method !== 'GET' ? 'Action completed.' : '';
    closeTileActionOverlay();
    return data;
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    throw err;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function setupTileActionHandlers() {
  document.getElementById('tile-action-cancel')?.addEventListener('click', closeTileActionOverlay);
  document.getElementById('tile-action-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!tileActionDialogState) return;
    try {
      const input = collectTileActionDialogInput();
      await runTileAction(tileActionDialogState.tileId, tileActionDialogState.action.id, input);
    } catch {
      /* status is rendered in overlay */
    }
  });
  document.getElementById('tile-action-submit')?.addEventListener('click', async () => {
    if (!tileActionDialogState) return;
    try {
      const input = collectTileActionDialogInput();
      await runTileAction(tileActionDialogState.tileId, tileActionDialogState.action.id, input);
    } catch {
      /* status is rendered in overlay */
    }
  });
}

async function loadHomeTiles() {
  const base = apiBase(primaryAgent);

  loadVibeTile(primaryAgent, {
    imageId: 'home-vibe-image',
    captionId: 'home-vibe-caption',
    galleryHrefId: 'home-vibe-gallery-link',
  }).catch(() => { /* best-effort */ });

  const [engineHealth, summary, feederData, thoughtData, dreamData] = await Promise.all([
    fetchEngineHealth(primaryAgent).catch(() => null),
    apiFetch(`${base}/api/home/summary`, { timeoutMs: 4000 }).catch(() => null),
    apiFetch('/home23/feeder-status', { timeoutMs: 4000 }).catch(() => null),
    apiFetch(`${base}/api/thoughts?limit=120`, { timeoutMs: 5000 }).catch(() => null),
    apiFetch(`${base}/api/dreams?limit=20&lite=1`, { timeoutMs: 3000 }).catch(() => null),
  ]);

  if (summary) {
    updateSystemTile(summary);
    seedPulseFromSummary(summary, engineHealth);
  }

  if (engineHealth) {
    setEngineOnlineStatus(enginePulse.state);
    setText('sys-uptime', formatDurationMs(engineHealth.uptime));
  } else if (!enginePulse.lastEventTime && (!enginePulse.state || enginePulse.state === 'unknown')) {
    setEngineOfflineStatus();
  }

  if (feederData) updateFeederTile(feederData);

  if (thoughtData) {
    const thoughts = thoughtData.thoughts || thoughtData.journal || thoughtData || [];
    _cachedThoughts = thoughts;
    updateThoughtsTile(thoughts);
    updateBrainLog(thoughts.slice(-20));
  }

  if (dreamData) {
    const dreams = dreamData.dreams || dreamData || [];
    _cachedDreams = dreams;
    updateDreamLog(dreams);
  }
}

function updateSystemTile(state) {
  const journal = Array.isArray(state.journal) ? state.journal : [];
  const lastThought = journal.length > 0 ? journal[journal.length - 1] : null;
  const uptime = state.uptime || formatUptime(state);
  const thoughtCount = state.thoughtCount ?? journal.length;
  const nodeCount = state.memoryNodes ?? state.nodeCount ?? state.memory?.nodes?.length ?? null;
  const lastThoughtAt = state.lastThoughtAt || lastThought?.timestamp || null;

  if (uptime && uptime !== '—') setText('sys-uptime', uptime);
  setText('sys-thoughts', thoughtCount != null ? String(thoughtCount) : '—');
  setText('sys-nodes', nodeCount != null ? String(nodeCount) : '—');
  setText('sys-last', lastThoughtAt ? timeSince(new Date(lastThoughtAt)) : '—');

  // Excerpt of latest thought in system tile
  const latestThoughtText = state.lastThoughtText || lastThought?.thought;
  if (latestThoughtText) {
    const excerpt = latestThoughtText.length > 120
      ? `${latestThoughtText.slice(0, 120)}...`
      : latestThoughtText;
    setText('sys-excerpt', excerpt);
  } else {
    setText('sys-excerpt', '');
  }

  updatePulseFromState(state);
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
  _cachedThoughts = thoughts;
  refreshHomeThoughtFeed();
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
  _cachedDreams = dreams;

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

  refreshHomeThoughtFeed();
}

function startHomeThoughtRotation() {
  if (homeThoughtRotationTimer) return;

  homeThoughtRotationTimer = setInterval(() => {
    if (currentTab !== 'home' || _homeThoughtFeed.length <= 1) return;
    _homeThoughtIndex = (_homeThoughtIndex + 1) % _homeThoughtFeed.length;
    renderHomeThoughtEntry(_homeThoughtFeed[_homeThoughtIndex]);
  }, HOME_THOUGHT_ROTATE_MS);
}

function refreshHomeThoughtFeed() {
  const nextFeed = buildHomeThoughtFeed(_cachedThoughts, _cachedDreams);
  const textEl = document.getElementById('home-thought');
  const metaEl = document.getElementById('home-thought-meta');
  if (!textEl || !metaEl) return;

  if (nextFeed.length === 0) {
    textEl.dataset.kind = 'thought';
    metaEl.dataset.kind = 'thought';
    setText('home-thought', 'Loading...');
    setText('home-thought-meta', '');
    _homeThoughtFeed = [];
    _homeThoughtCurrentId = null;
    _homeThoughtIndex = 0;
    return;
  }

  const existingIndex = nextFeed.findIndex(entry => entry.id === _homeThoughtCurrentId);
  if (existingIndex >= 0) {
    _homeThoughtIndex = existingIndex;
  } else if (_homeThoughtIndex >= nextFeed.length) {
    _homeThoughtIndex = 0;
  }

  _homeThoughtFeed = nextFeed;
  renderHomeThoughtEntry(_homeThoughtFeed[_homeThoughtIndex]);
}

function buildHomeThoughtFeed(thoughts, dreams) {
  const thoughtEntries = buildRoleDiverseThoughtEntries(thoughts, 8);
  const dreamEntries = buildDreamEntries(dreams, 4);
  const feed = [];

  while (thoughtEntries.length || dreamEntries.length) {
    for (let i = 0; i < 2 && thoughtEntries.length; i += 1) {
      feed.push(thoughtEntries.shift());
    }

    if (dreamEntries.length) {
      feed.push(dreamEntries.shift());
    }

    if (!dreamEntries.length && thoughtEntries.length) {
      feed.push(thoughtEntries.shift());
    }
  }

  return dedupeFeedEntries(feed).slice(0, 10);
}

function buildRoleDiverseThoughtEntries(thoughts, maxEntries = 8) {
  const validThoughts = [...(thoughts || [])]
    .filter(entry => {
      const text = (entry.thought || entry.content || entry.text || '').trim();
      return text && entry.role !== 'sleep';
    })
    .sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));

  const buckets = new Map();
  for (const thought of validThoughts) {
    const role = thought.role || 'thought';
    if (!buckets.has(role)) buckets.set(role, []);
    buckets.get(role).push(thought);
  }

  const roleOrder = [...buckets.entries()]
    .sort((a, b) => getTimestampMs(b[1][0]?.timestamp) - getTimestampMs(a[1][0]?.timestamp))
    .map(([role]) => role);

  const entries = [];
  while (entries.length < maxEntries) {
    let added = false;
    for (const role of roleOrder) {
      const bucket = buckets.get(role);
      if (bucket && bucket.length > 0) {
        entries.push(normalizeThoughtEntry(bucket.shift()));
        added = true;
        if (entries.length >= maxEntries) break;
      }
    }
    if (!added) break;
  }

  return entries.filter(Boolean);
}

function buildDreamEntries(dreams, maxEntries = 4) {
  return [...(dreams || [])]
    .filter(entry => (entry.content || entry.thought || '').trim().length > 20)
    .sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp))
    .slice(0, maxEntries)
    .map(normalizeDreamEntry)
    .filter(Boolean);
}

function normalizeThoughtEntry(entry) {
  const text = (entry.thought || entry.content || entry.text || '').trim();
  if (!text) return null;

  const timestampMs = getTimestampMs(entry.timestamp);
  const meta = ['Thought', (entry.role || 'inner life').toUpperCase()];
  if (entry.cycle) meta.push(`Cycle ${entry.cycle}`);
  if (timestampMs) meta.push(timeSince(new Date(timestampMs)));

  return {
    id: `thought:${entry.timestamp || entry.cycle || text.slice(0, 24)}`,
    kind: 'thought',
    text,
    meta: meta.join(' · '),
    timestampMs,
  };
}

function normalizeDreamEntry(entry) {
  const text = (entry.content || entry.thought || '').trim();
  if (!text) return null;

  const timestampMs = getTimestampMs(entry.timestamp);
  const meta = ['Dream'];
  if (entry.cycle) meta.push(`Cycle ${entry.cycle}`);
  if (timestampMs) meta.push(timeSince(new Date(timestampMs)));

  return {
    id: `dream:${entry.id || entry.timestamp || entry.cycle || text.slice(0, 24)}`,
    kind: 'dream',
    text,
    meta: meta.join(' · '),
    timestampMs,
  };
}

function dedupeFeedEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = (entry.text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderHomeThoughtEntry(entry) {
  const textEl = document.getElementById('home-thought');
  const metaEl = document.getElementById('home-thought-meta');
  if (!textEl || !metaEl || !entry) return;

  _homeThoughtCurrentId = entry.id;
  textEl.dataset.kind = entry.kind;
  metaEl.dataset.kind = entry.kind;
  setText('home-thought', entry.text);
  setText('home-thought-meta', entry.meta);
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

  const [summary, engineHealth] = await Promise.all([
    apiFetch(`${base}/api/home/summary`, { timeoutMs: 4000 }).catch(() => null),
    fetchEngineHealth(agent).catch(() => null)
  ]);

  if (summary) {
    setText(`sys2-thoughts-${agentName}`, summary.thoughtCount != null ? String(summary.thoughtCount) : '—');
    setText(`sys2-nodes-${agentName}`, summary.memoryNodes != null ? String(summary.memoryNodes) : '—');
    setText(`sys2-last-${agentName}`, summary.lastThoughtAt ? timeSince(new Date(summary.lastThoughtAt)) : '—');
  }

  if (engineHealth) {
    setText(`sys2-uptime-${agentName}`, formatDurationMs(engineHealth.uptime));
  }

  try {
    const data = await apiFetch(`${base}/api/thoughts?limit=20`);
    if (data) {
      const thoughts = data.thoughts || data.journal || data || [];
      if (thoughts.length > 0) {
        const latest = thoughts[thoughts.length - 1];
        setText(`thought-${agentName}`, latest.thought || latest.content || '');
        setText(`thought-meta-${agentName}`, `${(latest.role || 'thought').toUpperCase()} · CYCLE ${latest.cycle || ''}`);
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
      await loadHomeLayoutConfig();
      await loadHomeTiles();
      await loadVisibleCustomTiles();
    } else if (currentTab.startsWith('agent-')) {
      await loadAgentPanel(currentTab.replace('agent-', ''));
    }
    // cosmo23 tab: iframe handles its own refresh
  }, REFRESH_MS);
}

// ── Utilities ──

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  if (vibeTrigger && vibeTrigger.dataset.bound !== 'true') {
    vibeTrigger.addEventListener('click', async (event) => {
      if (event.detail !== 3) return;
      await triggerVibeGeneration();
    });
    vibeTrigger.dataset.bound = 'true';
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
let _homeThoughtFeed = [];
let _homeThoughtIndex = 0;
let _homeThoughtCurrentId = null;

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

async function apiFetch(url, options = {}) {
  const { timeoutMs = 15000 } = options;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return res.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function getTimestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
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

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

// ── Update Notification ──

async function checkUpdateNotification() {
  try {
    const res = await fetch('/home23/api/settings/update-status');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.updateAvailable) return;

    const bar = document.getElementById('update-notification');
    const text = document.getElementById('update-notification-text');
    if (!bar || !text) return;

    text.textContent = `Home23 v${data.latestVersion} available \u2014 run home23 update in your terminal`;
    bar.style.display = 'flex';

    const dismissBtn = document.getElementById('update-dismiss');
    if (dismissBtn) {
      dismissBtn.onclick = () => { bar.style.display = 'none'; };
    }
  } catch { /* silent */ }
}

// ── Start ──

document.addEventListener('DOMContentLoaded', init);
