/**
 * Home23 Dashboard — Vanilla JS
 *
 * Current dashboard agent view on Home tab (ReginaCosmo layout).
 * COSMO 2.3 embedded via iframe on COSMO tab.
 * Secondary agent tabs created on demand.
 */

// ── Config ──

const REFRESH_MS = 30000;
const HOME_THOUGHT_ROTATE_MS = 16000;
let agents = [];
// Back-compat variable name: this is the agent that owns the current dashboard.
let primaryAgent = null;
let homePrimaryAgent = null;
let currentTab = 'home';
let dashboardScopeRegistry = null;
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

function currentAgentLabel(fallback = 'This agent') {
  return primaryAgent?.displayName || primaryAgent?.name || fallback;
}

const DASHBOARD_SCOPE_FALLBACK = {
  home: {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: 'Home is the live surface for {{dashboardAgent}}. Tiles, pulse, chat, and feed data belong to this dashboard agent.',
  },
  intelligence: {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: "Intelligence is scoped to {{dashboardAgent}}. It reflects this dashboard agent's internal state and live system observations.",
  },
  query: {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: "Query targets {{dashboardAgent}}'s brain by default. PGS and query defaults resolve against the current dashboard agent unless you override them.",
  },
  'brain-map': {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: "Brain Map opens {{dashboardAgent}}'s graph by default. It uses the current dashboard brain route when resolving the graph view.",
  },
  about: {
    kind: 'shared',
    chip: 'Shared',
    summaryTemplate: 'About is a shared system surface. It describes the Home23 install rather than one specific agent.',
  },
  settings: {
    kind: 'mixed',
    chip: 'Mixed',
    summaryTemplate: 'Settings mixes house-wide and agent-scoped configuration. Use the Settings page scope controls to see which areas target {{dashboardAgent}} versus the whole house.',
  },
  cosmo23: {
    kind: 'external',
    chip: 'External',
    summaryTemplate: 'cosmo23 is an external shared research surface. It is linked from this dashboard but not owned by one Home23 agent.',
  },
  evobrew: {
    kind: 'external',
    chip: 'External',
    summaryTemplate: 'evobrew is an external shared surface. The dashboard deep-links it with the current agent, but the service itself is house-managed.',
  },
  agent: {
    kind: 'peer',
    chip: 'Other Agent',
    summaryTemplate: 'This panel shows {{peerAgent}} from inside {{dashboardAgent}}\'s dashboard. It is a peer-agent view, not the owner of the current dashboard shell.',
  },
};

function getDashboardScopeMeta(tabKey) {
  const key = tabKey && tabKey.startsWith('agent-') ? 'agent' : (tabKey || currentTab);
  const registry = dashboardScopeRegistry?.tabs || {};
  return registry[key] || DASHBOARD_SCOPE_FALLBACK[key] || DASHBOARD_SCOPE_FALLBACK.home;
}

function renderDashboardScopeText(meta, tabKey = currentTab) {
  const peerName = tabKey && tabKey.startsWith('agent-')
    ? agents.find(a => a.name === tabKey.replace('agent-', ''))?.displayName || tabKey.replace('agent-', '')
    : '';
  const replacements = {
    dashboardAgent: currentAgentLabel('this dashboard agent'),
    primaryAgent: homePrimaryAgent?.displayName || homePrimaryAgent?.name || currentAgentLabel('the Home23 primary agent'),
    peerAgent: peerName || 'the other agent',
  };
  return String(meta?.summaryTemplate || '').replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] || '');
}

function refreshDashboardScopeUI() {
  document.querySelectorAll('.h23-tab[data-tab], .h23-tab[data-scope-tab]').forEach(tab => {
    const tabKey = tab.dataset.scopeTab || tab.dataset.tab;
    const meta = getDashboardScopeMeta(tabKey);
    if (!tab.dataset.tabLabel) tab.dataset.tabLabel = tab.textContent.trim();
    const label = tab.dataset.tabLabel;
    tab.innerHTML = `<span class="h23-tab-label">${label}</span><span class="h23-tab-scope-chip scope-${meta.kind}">${meta.chip}</span>`;
    tab.title = renderDashboardScopeText(meta, tabKey);
  });

  const scopeMeta = getDashboardScopeMeta(currentTab);
  const kicker = document.getElementById('dashboard-scope-kicker');
  const summary = document.getElementById('dashboard-scope-summary');
  if (kicker) {
    const scopeLabel = scopeMeta.kind === 'dashboard'
      ? 'This Dashboard Agent'
      : scopeMeta.kind === 'peer'
        ? 'Peer Agent Surface'
        : scopeMeta.kind === 'mixed'
          ? 'Mixed Surface'
          : scopeMeta.kind === 'external'
            ? 'External Surface'
            : 'Shared Surface';
    kicker.textContent = `${scopeLabel} · ${scopeMeta.chip}`;
  }
  if (summary) {
    summary.textContent = renderDashboardScopeText(scopeMeta, currentTab);
  }
}

async function loadDashboardScopeRegistry() {
  try {
    const res = await fetch('/home23/api/scope');
    if (!res.ok) return;
    dashboardScopeRegistry = await res.json();
  } catch { /* best effort */ }
}

function refreshDashboardIdentityUI() {
  const chip = document.getElementById('dashboard-identity-chip');
  if (!chip || !primaryAgent) return;

  const currentName = primaryAgent.displayName || primaryAgent.name || 'Agent';
  const homePrimaryName = homePrimaryAgent?.displayName || homePrimaryAgent?.name || currentName;
  const isHomePrimary = !!primaryAgent.isPrimary || primaryAgent.name === homePrimaryAgent?.name;
  chip.textContent = isHomePrimary
    ? `Dashboard: ${currentName} · primary agent`
    : `Dashboard: ${currentName} · secondary · Home primary: ${homePrimaryName}`;
  chip.title = isHomePrimary
    ? `${currentName} is the current dashboard and the Home23 primary agent.`
    : `${currentName} owns this dashboard. ${homePrimaryName} is the Home23 primary agent.`;
  document.title = `Home23 — ${currentName}`;
}

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
  await loadDashboardScopeRegistry();
  await loadAgents();
  renderAgentTabs();
  refreshDashboardScopeUI();
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

  // Poll autonomous actions (⚡ executions from ACT: tag)
  updateActionsBadge();
  setInterval(updateActionsBadge, 15000);

  // Live problems badge — polls every 20s. The engine verifies on its own
  // cadence (~90s), so 20s is plenty fresh for the dashboard.
  updateProblemsBadge();
  setInterval(updateProblemsBadge, 20000);

  // Signals badge — wins, resolutions, positive observations. Polls 30s.
  updateSignalsBadge();
  setInterval(updateSignalsBadge, 30000);

  // Brain storage badge — polls every 30s. Shows disk node count and flags
  // mismatch between disk-side snapshot and in-memory state.
  updateBrainStorageBadge();
  setInterval(updateBrainStorageBadge, 30000);

  // Pulse tile (Jerry's voice). Tile text updates when a new remark lands;
  // rotating stat under it cycles every 8s.
  updatePulseTile();
  setInterval(updatePulseTile, 20000);
  startPulseRotation();
}

// ── Pulse tile (Jerry's voice + rotating stats) ──

let _pulseLatest = null;
let _pulseStatsIdx = 0;
let _pulseRotateTimer = null;
let _pulseLastRemarkId = null;

async function updatePulseTile() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/pulse/latest`);
    if (!r.ok) return;
    const data = await r.json();
    _pulseLatest = data.remark;
    renderPulseTile();
  } catch { /* silent */ }
}

function renderPulseTile() {
  const textEl = document.getElementById('pulse-remark-text');
  const ageEl = document.getElementById('pulse-remark-age');
  if (!textEl) return;

  if (!_pulseLatest || !_pulseLatest.text) {
    textEl.textContent = `${currentAgentLabel()} has not spoken yet. Waiting for the first pulse cycle.`;
    textEl.style.color = 'var(--text-muted)';
    textEl.style.fontStyle = 'italic';
    if (ageEl) ageEl.textContent = '';
    return;
  }

  textEl.textContent = _pulseLatest.text;
  textEl.style.color = 'var(--text-primary)';
  textEl.style.fontStyle = 'normal';

  if (ageEl) {
    const age = timeSince(new Date(_pulseLatest.ts));
    ageEl.textContent = `cycle ${_pulseLatest.cycle ?? '?'} · ${age}`;
  }

  // If remark changed, reset the rotating stats to start
  if (_pulseLatest.id !== _pulseLastRemarkId) {
    _pulseLastRemarkId = _pulseLatest.id;
    _pulseStatsIdx = 0;
    rotatePulseStat();
  }
}

function rotatePulseStat() {
  const el = document.getElementById('pulse-rotating-stat');
  if (!el || !_pulseLatest) return;

  const stats = _pulseLatest.stats || [];
  if (stats.length === 0) {
    el.textContent = '';
    return;
  }

  const stat = stats[_pulseStatsIdx % stats.length];
  el.innerHTML = `<span style="font-size:13px;margin-right:6px;">${stat.icon || '•'}</span><span style="color:var(--text-secondary);">${escapeHtml(String(stat.label))}:</span> <span style="color:var(--text-primary);font-weight:500;">${escapeHtml(String(stat.value))}</span>`;
  _pulseStatsIdx++;
}

function startPulseRotation() {
  if (_pulseRotateTimer) return;
  rotatePulseStat();
  _pulseRotateTimer = setInterval(rotatePulseStat, 8000);
}

async function openPulseHistoryPanel() {
  // Reuse the actions overlay DOM — hijack it for pulse history
  const overlay = document.getElementById('actions-overlay');
  const list = document.getElementById('actions-list');
  const title = overlay?.querySelector('.h23-brainlog-title');
  if (!overlay || !list) return;
  if (title) title.textContent = `💬 Pulse History — ${currentAgentLabel('Agent')}'s Remarks`;
  overlay.style.display = 'flex';
  list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/pulse/history?limit=40`);
    const data = await r.json();
    const remarks = data.remarks || [];
    if (remarks.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">No remarks yet.</div>';
      return;
    }
    list.innerHTML = remarks.map(r => {
      const ts = r.ts ? new Date(r.ts).toLocaleString() : '';
      const briefCount = (r.brief?.notable?.length || 0) + (r.brief?.novelThoughts?.length || 0);
      const briefSummary = briefCount > 0 ? `${briefCount} signal${briefCount === 1 ? '' : 's'} fed this remark` : 'quiet context';
      return `
        <div style="padding:12px 14px;margin-bottom:8px;background:rgba(255,255,255,0.02);border-left:3px solid #5ac8fa;">
          <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;">
            cycle ${r.cycle ?? '?'} · ${r.model || 'unknown model'} · ${ts}
          </div>
          <div style="color:#fff;font-size:14px;line-height:1.5;margin-bottom:6px;">${escapeHtmlNotif(r.text || '')}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${briefSummary}</div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

async function updateActionsBadge() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/home23/api/settings/agency/recent?limit=100`);
    if (!r.ok) return;
    const data = await r.json();
    const actions = data.actions || [];
    // Count outcome events in the last hour
    const oneHourAgo = Date.now() - 3600 * 1000;
    const recent = actions.filter(a => a.phase === 'outcome' && a.ts && new Date(a.ts).getTime() >= oneHourAgo);
    const el = document.getElementById('pulse-actions');
    const sep = document.getElementById('pulse-actions-sep');
    const badge = document.getElementById('pulse-actions-badge');
    if (!el || !badge) return;
    if (recent.length > 0) {
      el.style.display = '';
      if (sep) sep.style.display = '';
      badge.textContent = `⚡ ${recent.length}`;
      const rejected = recent.filter(a => a.status === 'rejected').length;
      badge.style.color = rejected > 0 ? '#ffb347' : '#30d158';
    } else {
      el.style.display = 'none';
      if (sep) sep.style.display = 'none';
    }
  } catch { /* silent */ }
}

async function openActionsPanel() {
  const overlay = document.getElementById('actions-overlay');
  const list = document.getElementById('actions-list');
  if (!overlay || !list) return;
  overlay.style.display = 'flex';
  list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/home23/api/settings/agency/recent?limit=200`);
    const data = await r.json();
    const actions = data.actions || [];
    if (actions.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">No actions yet. Cognitive cycles emit <code>ACT:</code> tags which the dispatcher executes — when they do, they\'ll show up here.</div>';
      return;
    }
    // Pair intent + outcome by matching action+role+cycle+target
    const chronological = [...actions].reverse();
    const pairs = [];
    const open = new Map();
    for (const ev of chronological) {
      const k = `${ev.action}|${ev.role}|${ev.cycle}|${ev.target || ''}`;
      if (ev.phase === 'intent') open.set(k, ev);
      else if (ev.phase === 'outcome') {
        pairs.push({ intent: open.get(k), outcome: ev });
        open.delete(k);
      }
    }
    for (const [, intent] of open) pairs.push({ intent, outcome: null });
    pairs.reverse();

    list.innerHTML = pairs.slice(0, 80).map(({ intent, outcome }) => {
      const status = outcome?.status || 'in_flight';
      const col = status === 'success' ? '#30d158'
        : status === 'dry_run' ? '#5ac8fa'
        : status === 'rejected' ? '#ff6b6b'
        : 'rgba(255,255,255,0.5)';
      const ts = outcome?.ts || intent?.ts;
      const time = ts ? new Date(ts).toLocaleString() : '';
      const reason = intent?.reason ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;">${escapeHtmlNotif(intent.reason)}</div>` : '';
      const detail = outcome?.detail ? `<div style="font-size:12px;color:${col};margin-top:4px;">${escapeHtmlNotif(outcome.detail)}</div>` : '';
      return `
        <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.02);border-left:3px solid ${col};">
          <div style="display:flex;justify-content:space-between;gap:12px;">
            <div style="flex:1;">
              <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:4px;">
                <span style="color:${col};font-weight:600;text-transform:uppercase;">${status}</span>
                · <code style="color:#5ac8fa;">${escapeHtmlNotif(intent?.action || '?')}</code>${intent?.target ? ' → ' + escapeHtmlNotif(intent.target) : ''}
                · cycle ${intent?.cycle || '?'}
                · ${intent?.role || '?'}
                · ${time}
              </div>
              ${reason}
              ${detail}
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

function closeActionsPanel() {
  const overlay = document.getElementById('actions-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ── Live Problems (verifier-backed ground truth) ──
let _liveProblems = { problems: [], snapshot: null };
let _problemEditingId = null;

async function updateProblemsBadge() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/live-problems`);
    if (!r.ok) return;
    const data = await r.json();
    _liveProblems = data;
    const el = document.getElementById('pulse-problems');
    const sep = document.getElementById('pulse-problems-sep');
    const badge = document.getElementById('pulse-problems-badge');
    if (!el || !badge) return;
    if (!data.available) {
      el.style.display = 'none';
      if (sep) sep.style.display = 'none';
      return;
    }
    const s = data.snapshot || { counts: { open: 0, chronic: 0, resolved: 0 }, resolvedJustNow: [] };
    const openCount = s.counts.open + s.counts.chronic;
    const resolvedCount = (s.resolvedJustNow || []).length;
    el.style.display = '';
    if (sep) sep.style.display = '';
    if (s.counts.chronic > 0) {
      badge.textContent = `🩺 ${openCount} (${s.counts.chronic} chronic)`;
      badge.style.color = '#ff6b6b';
    } else if (openCount > 0) {
      badge.textContent = `🩺 ${openCount}`;
      badge.style.color = '#ffb347';
    } else if (resolvedCount > 0) {
      badge.textContent = `🩺 all clear ✓`;
      badge.style.color = '#30d158';
    } else {
      badge.textContent = `🩺 ok`;
      badge.style.color = 'rgba(255,255,255,0.45)';
    }
  } catch { /* silent */ }
}

async function openProblemsPanel() {
  const overlay = document.getElementById('problems-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  await renderProblemsList();
}

function closeProblemsPanel() {
  const overlay = document.getElementById('problems-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function renderProblemsList() {
  const list = document.getElementById('problems-list');
  if (!list) return;
  list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/live-problems`);
    const data = await r.json();
    _liveProblems = data;
    if (!data.available) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Live-problems not available (engine not running or not wired).</div>';
      return;
    }
    const problems = (data.problems || []).slice().sort((a, b) => {
      const rank = { chronic: 0, open: 1, unverifiable: 2, resolved: 3 };
      return (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    });
    if (problems.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px;">No problems tracked. Add one below, or the engine will seed defaults on next start.</div>';
      return;
    }
    list.innerHTML = problems.map(p => renderProblemCard(p)).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

function renderProblemCard(p) {
  const stateColor = {
    open: '#ffb347', chronic: '#ff6b6b', resolved: '#30d158', unverifiable: '#888',
  }[p.state] || '#888';
  const stateLabel = p.state.toUpperCase();
  const ageMin = p.openedAt ? Math.max(0, Math.round((Date.now() - Date.parse(p.openedAt)) / 60000)) : null;
  const last = p.lastResult ? `${p.lastResult.ok ? 'ok' : 'fail'}: ${escapeHtml(p.lastResult.detail || '')}` : 'not yet checked';
  const lastChecked = p.lastCheckedAt ? ` · checked ${timeSinceSafe(p.lastCheckedAt)}` : '';
  const recentRem = (p.remediationLog || []).slice(-3).reverse();
  const stepsLabel = `step ${(p.stepIndex || 0)}/${(p.remediation || []).length}`;
  const originTag = p.seedOrigin && p.seedOrigin !== 'system'
    ? ` <span style="color:rgba(255,255,255,0.4);font-size:10px;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(p.seedOrigin)}</span>`
    : '';
  // Active dispatch banner — Tier-2 agent is working on this right now.
  let dispatchBanner = '';
  if (p.dispatchedAt && !p.lastResult?.ok) {
    const step = (p.remediation || [])[p.stepIndex || 0];
    const budget = step?.args?.budgetHours ?? 12;
    const elapsed = (Date.now() - Date.parse(p.dispatchedAt)) / 3600000;
    const pct = Math.min(100, Math.round((elapsed / budget) * 100));
    dispatchBanner = `<div style="background:rgba(90,200,250,0.08);border:1px solid rgba(90,200,250,0.2);border-radius:6px;padding:7px 10px;margin:6px 0;font-size:12px;color:#5ac8fa;display:flex;align-items:center;gap:10px;">
      <span>🔍 Agent working</span>
      <span style="color:rgba(255,255,255,0.65);">${elapsed.toFixed(1)}h / ${budget}h</span>
      <div style="flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:#5ac8fa;"></div></div>
      ${p.dispatchedTurnId ? `<code style="font-size:10px;color:rgba(255,255,255,0.4);">${escapeHtml(p.dispatchedTurnId)}</code>` : ''}
    </div>`;
  }
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid ${stateColor}33;border-left:3px solid ${stateColor};border-radius:8px;padding:12px 14px;margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <span style="color:${stateColor};font-weight:600;font-size:12px;letter-spacing:0.5px;">${stateLabel}${ageMin !== null && p.state !== 'resolved' ? ' · ' + ageMin + 'm' : ''}</span>
      <span style="color:#fff;font-size:14px;flex:1;">${escapeHtml(p.claim)}${originTag}</span>
      <code style="background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;font-size:11px;color:rgba(255,255,255,0.5);">${escapeHtml(p.id)}</code>
      <button onclick="openProblemEditor('${escapeAttr(p.id)}')" style="background:transparent;border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.7);padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;">edit</button>
    </div>
    ${dispatchBanner}
    <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:6px;">
      <span>verifier: <code style="background:rgba(255,255,255,0.04);padding:1px 4px;border-radius:3px;">${escapeHtml(p.verifier?.type || '—')}</code></span>
      <span style="margin-left:12px;">last: ${last}${lastChecked}</span>
      <span style="margin-left:12px;">remediation: ${stepsLabel}${p.escalated ? ' · <span style="color:#ff6b6b;">escalated</span>' : ''}</span>
    </div>
    ${recentRem.length > 0 ? `<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:4px;">recent attempts: ${recentRem.map(r => `<span style="margin-right:10px;">${escapeHtml(r.type)}=${escapeHtml(r.outcome)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
function timeSinceSafe(iso) {
  try { const ms = Date.now() - Date.parse(iso); const s = Math.round(ms / 1000); if (s < 60) return `${s}s ago`; const m = Math.round(s / 60); if (m < 60) return `${m}m ago`; return `${Math.round(m / 60)}h ago`; } catch { return '?'; }
}

async function tickProblemsNow() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/live-problems/tick`, { method: 'POST' });
    if (r.ok) await renderProblemsList();
  } catch { /* silent */ }
}

function openProblemEditor(id) {
  _problemEditingId = id;
  const title = document.getElementById('problem-editor-title');
  const pid = document.getElementById('pe-id');
  const claim = document.getElementById('pe-claim');
  const verifier = document.getElementById('pe-verifier');
  const rem = document.getElementById('pe-remediation');
  const del = document.getElementById('pe-delete');
  const status = document.getElementById('pe-status');
  if (status) status.textContent = '';
  if (id) {
    const p = (_liveProblems.problems || []).find(x => x.id === id);
    if (!p) return;
    title.textContent = `Edit: ${p.id}`;
    pid.value = p.id; pid.disabled = true;
    claim.value = p.claim || '';
    verifier.value = JSON.stringify(p.verifier || {}, null, 2);
    rem.value = JSON.stringify(p.remediation || [], null, 2);
    del.style.display = '';
  } else {
    title.textContent = 'Add Problem';
    pid.value = ''; pid.disabled = false;
    claim.value = '';
    verifier.value = '{\n  "type": "file_mtime",\n  "args": { "path": "~/.health_log.jsonl", "maxAgeMin": 360 }\n}';
    rem.value = '[\n  { "type": "notify_jtr", "args": { "text": "Something\'s wrong — check." }, "cooldownMin": 360 }\n]';
    del.style.display = 'none';
  }
  document.getElementById('problem-editor-overlay').style.display = 'flex';
}

function closeProblemEditor() {
  const ov = document.getElementById('problem-editor-overlay');
  if (ov) ov.style.display = 'none';
  _problemEditingId = null;
}

async function saveProblemEdit() {
  const pid = document.getElementById('pe-id').value.trim();
  const claim = document.getElementById('pe-claim').value.trim();
  const verifierText = document.getElementById('pe-verifier').value.trim();
  const remText = document.getElementById('pe-remediation').value.trim();
  const status = document.getElementById('pe-status');
  if (!pid || !claim) { status.textContent = 'id + claim required'; status.style.color = '#ff6b6b'; return; }
  let verifier, remediation;
  try { verifier = verifierText ? JSON.parse(verifierText) : null; } catch (e) { status.textContent = 'verifier JSON invalid: ' + e.message; status.style.color = '#ff6b6b'; return; }
  try { remediation = remText ? JSON.parse(remText) : []; } catch (e) { status.textContent = 'remediation JSON invalid: ' + e.message; status.style.color = '#ff6b6b'; return; }
  try {
    const method = _problemEditingId ? 'PUT' : 'POST';
    const url = _problemEditingId
      ? `${dashboardBaseUrl()}/api/live-problems/${encodeURIComponent(_problemEditingId)}`
      : `${dashboardBaseUrl()}/api/live-problems`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pid, claim, verifier, remediation, seedOrigin: 'user' }),
    });
    const data = await res.json();
    if (!res.ok) { status.textContent = data.error || `HTTP ${res.status}`; status.style.color = '#ff6b6b'; return; }
    status.textContent = 'saved'; status.style.color = '#30d158';
    await renderProblemsList();
    setTimeout(closeProblemEditor, 600);
  } catch (err) {
    status.textContent = 'save failed: ' + err.message; status.style.color = '#ff6b6b';
  }
}

async function deleteProblemFromEditor() {
  if (!_problemEditingId) return;
  if (!confirm(`Delete problem "${_problemEditingId}"? If it's a seeded invariant it will come back on next engine start.`)) return;
  try {
    await fetch(`${dashboardBaseUrl()}/api/live-problems/${encodeURIComponent(_problemEditingId)}`, { method: 'DELETE' });
    await renderProblemsList();
    closeProblemEditor();
  } catch { /* silent */ }
}

// ── Brain Storage (disk vs memory truth) ──
let _brainStorage = null;

async function updateBrainStorageBadge() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/brain/storage`);
    if (!r.ok) return;
    const data = await r.json();
    _brainStorage = data;
    const el = document.getElementById('pulse-brain');
    const sep = document.getElementById('pulse-brain-sep');
    const badge = document.getElementById('pulse-brain-badge');
    if (!el || !badge) return;

    const snapNodes = data.snapshot?.nodeCount;
    if (snapNodes == null) {
      el.style.display = 'none';
      if (sep) sep.style.display = 'none';
      return;
    }
    el.style.display = '';
    if (sep) sep.style.display = '';

    const ageMs = data.snapshot?.savedAt ? (Date.now() - new Date(data.snapshot.savedAt).getTime()) : null;
    const ageStr = ageMs == null ? '?' : (ageMs < 60000 ? `${Math.round(ageMs/1000)}s` : `${Math.round(ageMs/60000)}m`);

    if (data.mismatch) {
      badge.textContent = `🧠 ${snapNodes} ⚠️ mismatch`;
      badge.style.color = '#ff6b6b';
    } else {
      badge.textContent = `🧠 ${snapNodes.toLocaleString()} · saved ${ageStr} ago`;
      badge.style.color = 'rgba(255,255,255,0.55)';
    }
  } catch { /* silent */ }
}

async function openBrainStoragePanel() {
  const overlay = document.getElementById('brain-storage-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  await renderBrainStoragePanel();
}

function closeBrainStoragePanel() {
  const overlay = document.getElementById('brain-storage-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function renderBrainStoragePanel() {
  const content = document.getElementById('brain-storage-content');
  if (!content) return;
  content.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/brain/storage`);
    const data = await r.json();
    _brainStorage = data;

    const snap = data.snapshot;
    const mem = data.inMemory;
    const hw = data.highWater;
    const files = data.files || {};
    const backups = data.backups || [];

    const mb = (b) => { if (b == null) return '—'; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`; return `${(b / 1048576).toFixed(1)} MB`; };
    const ago = (iso) => { if (!iso) return '—'; const ms = Date.now() - new Date(iso).getTime(); if (ms < 60000) return `${Math.round(ms/1000)}s ago`; if (ms < 3600000) return `${Math.round(ms/60000)}m ago`; return `${Math.round(ms/3600000)}h ago`; };

    const mismatchWarn = data.mismatch
      ? `<div style="background:rgba(255,107,107,0.15);border:1px solid rgba(255,107,107,0.4);border-radius:6px;padding:10px 14px;margin-bottom:14px;color:#ff6b6b;">⚠️ MISMATCH: disk says ${snap?.nodeCount} nodes, memory says ${mem?.nodes}. Something is wrong — do NOT restart the engine until investigated.</div>`
      : '';

    content.innerHTML = `
      ${mismatchWarn}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 14px;">
          <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">On disk (snapshot)</div>
          <div style="font-size:22px;color:#fff;">${(snap?.nodeCount ?? '—').toLocaleString()} nodes</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:2px;">${(snap?.edgeCount ?? '—').toLocaleString()} edges · cycle ${snap?.cycle ?? '—'}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:6px;">saved ${ago(snap?.savedAt)} · source: ${snap?.memorySource || '—'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 14px;">
          <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Last verified (engine)</div>
          <div style="font-size:22px;color:#fff;">${snap?.nodeCount != null ? snap.nodeCount.toLocaleString() : '—'} nodes</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:2px;">${snap?.edgeCount != null ? snap.edgeCount.toLocaleString() + ' edges' : ''}</div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Files</div>
        <div style="font-family:var(--font-mono,monospace);font-size:12px;color:rgba(255,255,255,0.75);line-height:1.6;">
          <div>state.json.gz            · ${mb(files.state?.bytes)}</div>
          <div>memory-nodes.jsonl.gz    · ${mb(files.nodesSidecar?.bytes)}</div>
          <div>memory-edges.jsonl.gz    · ${mb(files.edgesSidecar?.bytes)}</div>
          <div>brain-snapshot.json      · ${mb(files.snapshot?.bytes)}</div>
        </div>
      </div>
      ${hw ? `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">High-water mark</div>
        <div style="font-size:14px;color:#fff;">${hw.maxNodeCount.toLocaleString()} nodes</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;">last hit ${ago(hw.lastSeen)}. Drop-detector opens a live problem if current falls &gt;10% below.</div>
      </div>` : ''}
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 14px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Rolling backups (${backups.length})</div>
        ${backups.length === 0 ? '<div style="font-size:12px;color:rgba(255,255,255,0.45);">No backups yet — first one gets created after ~1 hour of successful saves.</div>' : `<div style="font-family:var(--font-mono,monospace);font-size:12px;color:rgba(255,255,255,0.7);line-height:1.5;">${backups.map(b => `<div>${b.name}</div>`).join('')}</div>`}
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

// ── Notifications (thought-action queue) ──

async function updateNotificationBadge() {
  // NOTIFY stream now drains off-engine via the promoter worker into the
  // live-problems registry — not shown as a primary pulse-bar surface anymore.
  // Panel still reachable via openNotificationsPanel() for debugging.
  const el = document.getElementById('pulse-notifs');
  if (el) el.style.display = 'none';
}

// ── Signals (wins, resolutions, positive observations) ──

async function updateSignalsBadge() {
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/signals?limit=50&sinceHours=48`);
    if (!r.ok) return;
    const data = await r.json();
    const signals = data.signals || [];
    const el = document.getElementById('pulse-signals');
    const sep = document.getElementById('pulse-signals-sep');
    const badge = document.getElementById('pulse-signals-badge');
    if (!el || !badge) return;
    if (signals.length === 0) {
      el.style.display = 'none';
      if (sep) sep.style.display = 'none';
      return;
    }
    el.style.display = '';
    if (sep) sep.style.display = '';
    badge.textContent = `✨ ${signals.length}`;
    badge.style.color = '#30d158';
  } catch { /* silent */ }
}

async function openSignalsPanel() {
  const overlay = document.getElementById('signals-overlay');
  const list = document.getElementById('signals-list');
  if (!overlay || !list) return;
  overlay.style.display = 'flex';
  list.innerHTML = '<div style="color:rgba(255,255,255,0.6);padding:20px;">Loading...</div>';
  try {
    const r = await fetch(`${dashboardBaseUrl()}/api/signals?limit=200&sinceHours=48`);
    const data = await r.json();
    const signals = data.signals || [];
    if (signals.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.5);padding:20px;">No signals yet. Wins and positive observations show up here as the system resolves problems and observes healthy patterns.</div>';
      return;
    }
    list.innerHTML = signals.map(s => renderSignalCard(s)).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

function closeSignalsPanel() {
  const overlay = document.getElementById('signals-overlay');
  if (overlay) overlay.style.display = 'none';
}

function renderSignalCard(s) {
  const typeMeta = {
    resolved:             { icon: '✓', color: '#30d158', label: 'RESOLVED' },
    autonomous_fix:       { icon: '🔧', color: '#5ac8fa', label: 'AUTO-FIX' },
    observation:          { icon: '💡', color: '#ffb347', label: 'OBSERVATION' },
    action_success:       { icon: '⚡', color: '#bf5af2', label: 'ACTION' },
    registry_suggestion:  { icon: '📋', color: '#ff9f0a', label: 'REGISTRY SUGGESTION' },
  }[s.type] || { icon: '•', color: '#888', label: (s.type || 'SIGNAL').toUpperCase() };
  const ts = s.ts ? new Date(s.ts).toLocaleString() : '—';
  const evidenceBits = [];
  if (s.evidence?.problemId) evidenceBits.push(`problem: <code style="font-size:11px;background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;">${escapeHtml(s.evidence.problemId)}</code>`);
  if (s.evidence?.fixRecipe) evidenceBits.push(`fix: ${escapeHtml(s.evidence.fixRecipe)}`);
  if (s.evidence?.verifierDetail) evidenceBits.push(`check: ${escapeHtml(s.evidence.verifierDetail)}`);
  if (s.evidence?.category && s.evidence?.target) evidenceBits.push(`<code style="font-size:11px;background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;">${escapeHtml(s.evidence.category)}:${escapeHtml(s.evidence.target)}</code>`);
  if (typeof s.evidence?.rejectionCount === 'number') evidenceBits.push(`${s.evidence.rejectionCount} rejections`);
  return `<div style="background:rgba(255,255,255,0.03);border:1px solid ${typeMeta.color}33;border-left:3px solid ${typeMeta.color};border-radius:8px;padding:10px 14px;margin-bottom:8px;">
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px;">
      <span style="color:${typeMeta.color};font-size:16px;">${typeMeta.icon}</span>
      <span style="color:${typeMeta.color};font-weight:600;font-size:11px;letter-spacing:0.5px;">${typeMeta.label}</span>
      <span style="color:rgba(255,255,255,0.45);font-size:12px;">${escapeHtml(s.source || '—')}</span>
      ${typeof s.cycle === 'number' ? `<span style="color:rgba(255,255,255,0.35);font-size:11px;">cycle ${s.cycle}</span>` : ''}
      <span style="color:rgba(255,255,255,0.35);font-size:11px;margin-left:auto;">${ts}</span>
    </div>
    ${s.title ? `<div style="color:#fff;font-size:13px;margin-bottom:3px;">${escapeHtml(s.title)}</div>` : ''}
    ${s.message && s.message !== s.title ? `<div style="color:rgba(255,255,255,0.7);font-size:12px;line-height:1.4;">${escapeHtml(s.message)}</div>` : ''}
    ${evidenceBits.length ? `<div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:5px;">${evidenceBits.join(' · ')}</div>` : ''}
  </div>`;
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

  // Current dashboard agent = the one whose dashboard we're on
  const currentPort = parseInt(window.location.port) || 5002;
  primaryAgent = agents.find(a => a.dashboardPort === currentPort) || agents[0];
  homePrimaryAgent = agents.find(a => a.isPrimary) || primaryAgent;
  refreshDashboardIdentityUI();

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
      refreshDashboardScopeUI();
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
  // Only show tabs for other agents; Home belongs to the current dashboard agent.
  const others = agents.filter(a => a.name !== primaryAgent.name);
  container.innerHTML = others.map(a =>
    `<button class="h23-tab" data-tab="agent-${a.name}" data-tab-label="🐢 ${a.displayName || a.name}">🐢 ${a.displayName || a.name}</button>`
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
      refreshDashboardScopeUI();

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

      // Query tab: initialize on first visit (resolves current dashboard agent brain via cosmo23).
      if (currentTab === 'query') {
        if (typeof initQueryTab === 'function') initQueryTab();
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

// ── Home Tiles (current dashboard agent) ──

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
    <div class="h23-tile h23-tile-thoughts h23-tile-pulse" style="cursor:pointer;" onclick="openPulseHistoryPanel()" title="Tap to see pulse history">
      <div class="h23-tile-header" style="display:flex;align-items:center;gap:8px;">
        💬 <span id="primary-agent-name">${escapeHtml(primaryAgent?.displayName || primaryAgent?.name || 'Agent')}</span>
        <span id="pulse-remark-age" style="margin-left:auto;font-size:11px;color:var(--text-muted);font-weight:400;"></span>
      </div>
      <div id="pulse-remark-body" style="display:flex;flex-direction:column;gap:10px;">
        <div id="pulse-remark-text" style="font-size:14px;line-height:1.55;color:var(--text-primary);">Loading…</div>
        <div id="pulse-rotating-stat" style="font-size:12px;color:var(--text-muted);border-top:1px solid var(--glass-border);padding-top:8px;min-height:20px;"></div>
      </div>
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
        <button class="h23-chat-agent-pill" id="chat-agent-pill" type="button" title="Switch agent">
          <span class="h23-chat-agent-avatar" id="chat-agent-avatar">…</span>
          <span class="h23-chat-agent-name" id="chat-agent-name">Loading…</span>
        </button>
        <div class="h23-chat-actions">
          <button class="h23-chat-expand-btn" id="chat-expand-btn" type="button" title="Expand">&#8599;</button>
          <button class="h23-chat-expand-btn" id="chat-more-btn" type="button" title="More" aria-haspopup="menu" aria-expanded="false">&#8230;</button>
        </div>
        <!-- Hidden selects keep existing populate/select logic working without
             cluttering the tile header. ⋯ menu exposes model/agent change. -->
        <select class="h23-chat-agent-select" id="chat-agent-select" hidden>
          <option>Loading...</option>
        </select>
        <select class="h23-chat-model-select" id="chat-model-select" hidden>
          <option>model</option>
        </select>
      </div>
      <div class="h23-chat-conv-panel" id="chat-conv-panel">
        <div style="padding:10px 14px;border-bottom:1px solid var(--glass-border);display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">History</span>
          <button class="h23-chat-expand-btn" type="button" onclick="toggleConversationList()" title="Close" style="width:24px;height:24px;font-size:12px;">&#10005;</button>
        </div>
        <div class="h23-chat-conv-list" id="chat-conv-list"></div>
      </div>
      <!-- Slot: shared message-list + input subtree is cloned here from
           #chat-shared-template at init, then moved in/out of the overlay
           on expand/collapse via appendChild. -->
      <div class="h23-chat-slot" id="chat-slot-tile" data-slot="tile"></div>
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
      captionEl.textContent = data.item.caption || '';
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
