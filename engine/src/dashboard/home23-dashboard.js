/**
 * Home23 Dashboard — Vanilla JS
 *
 * Current dashboard agent view on the resident Home/Agency surfaces.
 * COSMO 2.3 embedded via iframe on COSMO tab.
 */

// ── Config ──

const REFRESH_MS = 30000;
const GOOD_LIFE_API_TIMEOUT_MS = 12000;
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
const goodLifeSurfaceState = new Map();
const goodLifeFleetState = new Map();
let goodLifeOverlayState = {
  scope: 'home',
  tab: 'issues',
  selectedProblemId: null,
};
let residentHomeLatestState = null;
let workersState = {
  workers: [],
  templates: [],
  runs: [],
  receipt: null,
  lastLoadedAt: null,
};

function currentAgentLabel(fallback = 'This agent') {
  return primaryAgent?.displayName || primaryAgent?.name || fallback;
}

const DASHBOARD_SCOPE_FALLBACK = {
  home: {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: '{{dashboardAgent}} is running from resident agency state. Routine organs stay hidden until they need action.',
  },
  workers: {
    kind: 'mixed',
    chip: 'Workers',
    summaryTemplate: 'Workers are reusable house capabilities. They run through {{dashboardAgent}}\'s connector, keep their own workspaces, and feed receipts back into house-agent memory.',
  },
  agency: {
    kind: 'dashboard',
    chip: 'This Agent',
    summaryTemplate: 'Agency is the resident pursuit surface for {{dashboardAgent}}: inbox decisions, active pursuits, authority receipts, and consequences.',
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
};

function getDashboardScopeMeta(tabKey) {
  const key = tabKey || currentTab;
  const registry = dashboardScopeRegistry?.tabs || {};
  return registry[key] || DASHBOARD_SCOPE_FALLBACK[key] || DASHBOARD_SCOPE_FALLBACK.home;
}

function renderDashboardScopeText(meta, tabKey = currentTab) {
  const replacements = {
    dashboardAgent: currentAgentLabel('this dashboard agent'),
    primaryAgent: homePrimaryAgent?.displayName || homePrimaryAgent?.name || currentAgentLabel('the Home23 primary agent'),
  };
  return String(meta?.summaryTemplate || '').replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] || '');
}

function refreshDashboardScopeUI() {
  const isCosmoTab = currentTab === 'cosmo23';
  document.body.classList.toggle('h23-external-focus', isCosmoTab);
  if (!isCosmoTab) setCosmoHomeDrawerOpen(false);

  document.querySelectorAll('.h23-tab[data-tab], .h23-tab[data-scope-tab]').forEach(tab => {
    const tabKey = tab.dataset.scopeTab || tab.dataset.tab;
    const meta = getDashboardScopeMeta(tabKey);
    if (!tab.dataset.tabLabel) tab.dataset.tabLabel = tab.textContent.trim();
    const label = tab.dataset.tabLabel;
    tab.innerHTML = `<span class="h23-tab-label">${label}</span>`;
    tab.title = renderDashboardScopeText(meta, tabKey);
  });

  const scopeMeta = getDashboardScopeMeta(currentTab);
  const kicker = document.getElementById('dashboard-scope-kicker');
  const summary = document.getElementById('dashboard-scope-summary');
  if (kicker) {
    const scopeLabel = scopeMeta.kind === 'dashboard'
      ? 'This Dashboard Agent'
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
  const headerAgent = document.getElementById('header-agent-name');
  if (!primaryAgent) return;

  const currentName = primaryAgent.displayName || primaryAgent.name || 'Agent';
  if (headerAgent) headerAgent.textContent = currentName;
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
  await loadDashboardScopeRegistry();
  await loadAgents();
  refreshDashboardScopeUI();
  setupTabHandlers();
  setupOrganDrawer();
  setupResidentHomeSurface();
  setupWorkersSurface();
  connectEnginePulse();
  loadResidentHomeSurface().catch(() => { /* agency bridge may still be booting */ });
  startAutoRefresh();

  // Update pulse "ago" timer every second
  setInterval(updatePulseAgo, 1000);

  // Workers are connector-backed and cheap to refresh. Keep the user-facing
  // status current without pulling on the full engine loop.
  setInterval(() => {
    if (currentTab === 'workers') loadWorkersSurface().catch(() => {});
  }, 30000);

  setInterval(() => {
    if (currentTab === 'agency') loadAgencySurface().catch(() => {});
  }, 15000);

  setInterval(() => {
    if (currentTab === 'home') loadResidentHomeSurface().catch(() => {});
  }, 15000);
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
    const s = data.snapshot || { counts: { open: 0, chronic: 0, resolved: 0 } };
    const openCount = s.counts.open + s.counts.chronic;
    if (openCount <= 0) {
      el.style.display = 'none';
      if (sep) sep.style.display = 'none';
      return;
    }
    el.style.display = '';
    if (sep) sep.style.display = '';
    if (s.counts.chronic > 0) {
      badge.textContent = `🩺 ${openCount} (${s.counts.chronic} chronic)`;
      badge.style.color = '#ff6b6b';
    } else {
      badge.textContent = `🩺 ${openCount}`;
      badge.style.color = '#ffb347';
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
    const activeProblems = problems.filter((p) => p.state !== 'resolved');
    const resolvedProblems = problems.filter((p) => p.state === 'resolved');
    const activeHtml = activeProblems.length
      ? activeProblems.map(p => renderProblemCard(p)).join('')
      : '<div class="h23-problems-clear-note">No active live problems. Resolved verifier history is available below.</div>';
    list.innerHTML = `${renderProblemsOperatorSummary(data, problems)}${activeHtml}${renderProblemHistoryDrawer(resolvedProblems)}`;
  } catch (err) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Failed to load: ${err.message}</div>`;
  }
}

function renderProblemHistoryDrawer(resolvedProblems = []) {
  if (!resolvedProblems.length) return '';
  const rows = resolvedProblems.slice(0, 12).map((p) => `
    <div class="h23-problems-history-row">
      <span>${escapeHtml(p.claim || p.id || 'resolved problem')}</span>
      <small>${escapeHtml([
        p.id,
        p.lastResult?.detail || p.fixRecipe?.summary || 'verified clear',
        p.resolvedAt ? `resolved ${timeSinceSafe(p.resolvedAt)}` : null,
      ].filter(Boolean).join(' · '))}</small>
    </div>
  `).join('');
  return `
    <details class="h23-problems-history">
      <summary>Resolved verifier history (${resolvedProblems.length})</summary>
      <div class="h23-problems-history-list">${rows}</div>
    </details>
  `;
}

function problemLastAttempt(problem = {}) {
  const attempts = Array.isArray(problem.remediationLog) ? problem.remediationLog : [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function problemRepairText(problem = {}) {
  if (problem.state === 'resolved') {
    if (problem.fixRecipe?.summary) return problem.fixRecipe.summary;
    if (problem.lastResult?.detail) return `verified clear: ${problem.lastResult.detail}`;
    return 'verified clear';
  }
  const latest = problemLastAttempt(problem);
  if (latest?.detail) return latest.detail;
  if (latest?.type) return `${latest.type} ${latest.outcome || 'recorded'}`;
  const next = goodLifeNextRemediation(problem);
  if (next.type) return `next step: ${next.type}${next.text ? ` - ${next.text}` : ''}`;
  return next.text || 'no remediation plan recorded';
}

function problemUserText(problem = {}) {
  if (problem.state === 'resolved') return 'nothing; this issue is resolved';
  if (problem.escalated) return 'manual review needed; autonomous remediation has escalated this issue';
  if (goodLifeNeedsUser(problem)) {
    const next = goodLifeNextRemediation(problem);
    return next.text || 'manual/user intervention is the next remediation step';
  }
  return 'not needed yet; autonomous remediation can continue';
}

function renderProblemsOperatorSummary(data, problems) {
  const snapshot = data?.snapshot || {};
  const counts = snapshot.counts || {};
  const open = Number(counts.open || 0);
  const chronic = Number(counts.chronic || 0);
  const unverifiable = Number(counts.unverifiable || 0);
  const interventionRequired = Number(counts.interventionRequired || 0);
  const active = problems.filter((p) => ['open', 'chronic', 'unverifiable'].includes(p.state));
  const primary = active.find(goodLifeNeedsUser) || active[0] || null;
  const headline = interventionRequired > 0
    ? `${interventionRequired} issue${interventionRequired === 1 ? '' : 's'} need jtr`
    : active.length > 0
      ? `${active.length} issue${active.length === 1 ? '' : 's'} under autonomous repair`
      : 'No active verified issues';
  const severity = interventionRequired > 0 ? 'needs-user' : active.length > 0 ? 'repairing' : 'clear';
  return `
    <div class="h23-problems-operator ${severity}">
      <div>
        <label>Operator Status</label>
        <strong>${escapeHtml(headline)}</strong>
        <span>${escapeHtml(`${open} open / ${chronic} chronic / ${unverifiable} unverifiable`)}</span>
      </div>
      <div>
        <label>Current Issue</label>
        <strong>${escapeHtml(primary?.claim || 'registry is clear')}</strong>
        <span>${escapeHtml(primary?.lastResult?.detail || primary?.detail || 'no failing verifier result')}</span>
      </div>
      <div>
        <label>Fix Path</label>
        <strong>${escapeHtml(primary ? problemRepairText(primary) : 'no repair path active')}</strong>
        <span>${escapeHtml(primary ? `remediation step ${Number(primary.stepIndex || 0)} / ${(primary.remediation || []).length}` : 'no active remediation')}</span>
      </div>
      <div>
        <label>Needed From You</label>
        <strong>${escapeHtml(primary ? problemUserText(primary) : 'nothing right now')}</strong>
        <span>${escapeHtml(primary?.id || 'all tracked verifiers are clear or resolved')}</span>
      </div>
    </div>
  `;
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
  const needsUser = goodLifeNeedsUser(p);
  const currentLabel = p.state === 'resolved' ? 'Verifier result' : 'What broke';
  const repairLabel = p.state === 'resolved' ? 'Resolution' : 'What Home23 is doing';
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
      ${needsUser ? '<span class="h23-goodlife-needs-user">needs you</span>' : ''}
      <code style="background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;font-size:11px;color:rgba(255,255,255,0.5);">${escapeHtml(p.id)}</code>
    </div>
    ${dispatchBanner}
    ${renderProblemUserAction(p)}
    <div class="h23-problem-operator-grid">
      <div><label>${escapeHtml(currentLabel)}</label><span>${escapeHtml(p.lastResult?.detail || p.detail || 'verifier has not run yet')}</span></div>
      <div><label>${escapeHtml(repairLabel)}</label><span>${escapeHtml(problemRepairText(p))}</span></div>
      <div><label>Needed from you</label><span>${escapeHtml(problemUserText(p))}</span></div>
    </div>
    ${renderProblemEvidenceDrawer(p, { last, lastChecked, stepsLabel, recentRem })}
  </div>`;
}

function renderProblemEvidenceDrawer(p, { last, lastChecked, stepsLabel, recentRem } = {}) {
  const attempts = Array.isArray(recentRem) ? recentRem : [];
  return `
    <details class="h23-problem-evidence">
      <summary>Verifier evidence</summary>
      <div class="h23-problem-evidence-grid">
        <div><label>Verifier</label><span>${escapeHtml(p.verifier?.type || '—')}</span></div>
        <div><label>Last</label><span>${escapeHtml(`${last || 'not yet checked'}${lastChecked || ''}`)}</span></div>
        <div><label>Remediation</label><span>${escapeHtml(`${stepsLabel || 'step 0/0'}${p.escalated ? ' · escalated' : ''}`)}</span></div>
      </div>
      ${attempts.length > 0 ? `<div class="h23-problem-evidence-attempts">${attempts.map(r => `<span>${escapeHtml(r.type)}=${escapeHtml(r.outcome)}</span>`).join('')}</div>` : ''}
    </details>
  `;
}

function renderProblemUserAction(problem = {}) {
  if (!goodLifeNeedsUser(problem)) return '';
  const next = goodLifeNextRemediation(problem);
  const canRecordHandled = problem.escalated || next.requiresUser;
  const stepText = problem.escalated
    ? 'manual review'
    : next.type
    ? `${next.type}${next.total ? ` step ${next.index + 1} of ${next.total}` : ''}`
    : 'manual intervention';
  const actionText = problem.escalated ? problemUserText(problem) : (next.text || problemUserText(problem));
  return `
    <div class="h23-problem-user-action">
      <div>
        <label>Action Needed</label>
        <strong>${escapeHtml(stepText)}</strong>
        <span>${escapeHtml(actionText)}</span>
      </div>
      <div class="h23-problem-user-action-controls">
        <button type="button" onclick="openProblemEditor('${escapeAttr(problem.id)}')">Inspect Plan</button>
        ${canRecordHandled ? `<button type="button" onclick="recordProblemUserIntervention('${escapeAttr(problem.id)}')">Mark Handled + Re-check</button>` : ''}
        <button type="button" onclick="tickProblemsNow()">Re-check</button>
      </div>
    </div>
  `;
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

async function recordProblemUserIntervention(id) {
  if (!id) return;
  try {
    const detail = window.prompt('What did you handle for this issue?', 'Manual intervention completed.');
    if (detail === null) return;
    const res = await fetch(`${dashboardBaseUrl()}/api/live-problems/${encodeURIComponent(id)}/user-intervention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'good-life-operator',
        note: detail || 'Manual intervention completed.',
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await tickProblemsNow();
    await renderProblemsList();
  } catch (err) {
    const list = document.getElementById('problems-list');
    if (list) {
      list.insertAdjacentHTML('afterbegin', `<div style="color:#ff6b6b;padding:8px 12px;">Failed to record intervention: ${escapeHtml(err.message)}</div>`);
    }
  }
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
      enginePulse.state = 'offline';
      renderPulse();
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

function isOperatorRuntimeAlert(runtimeState) {
  return ['blocked', 'error', 'failed', 'offline'].includes(String(runtimeState || '').toLowerCase());
}

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
      rail: document.getElementById('engine-pulse'),
      runtime: document.getElementById('system-runtime'),
      dot: document.getElementById('pulse-dot'),
      state: document.getElementById('pulse-state'),
      energy: document.getElementById('pulse-energy'),
      cycle: document.getElementById('pulse-cycle'),
    };
  }
  if (!_pulseEls.dot) return;

  const runtimeState = enginePulse.state && enginePulse.state !== 'unknown' ? enginePulse.state : '';
  const showRuntime = isOperatorRuntimeAlert(runtimeState);
  if (_pulseEls.rail) _pulseEls.rail.hidden = !showRuntime;
  if (_pulseEls.runtime) _pulseEls.runtime.hidden = !showRuntime;
  _pulseEls.dot.className = 'h23-pulse-dot ' + runtimeState;
  if (_pulseEls.state) _pulseEls.state.textContent = runtimeState;
  if (_pulseEls.energy) _pulseEls.energy.textContent = `⚡ ${Math.round((enginePulse.energy || 0) * 100)}%`;
  if (_pulseEls.cycle) _pulseEls.cycle.textContent = `cycle ${enginePulse.cycle || '—'}`;
}

function updatePulseAgo() {
  const ref = enginePulse.lastThought || enginePulse.lastEventTime;
  setText('pulse-ago', ref ? timeSince(ref) : '—');
}

function setEngineOnlineStatus(temporalState = 'awake') {
  const dot = document.getElementById('engine-dot');
  if (dot) dot.className = 'status-dot alive';
  setText('engine-status-text', temporalState === 'sleeping' ? 'ENGINE · SLEEPING' : 'ENGINE');
  setText('sidebar-status-line', temporalState === 'sleeping' ? 'Engine sleeping.' : 'Engine online.');
}

function setEngineOfflineStatus() {
  const dot = document.getElementById('engine-dot');
  if (dot) dot.className = 'status-dot dead';
  setText('engine-status-text', 'ENGINE offline');
  setText('sidebar-status-line', 'Engine offline.');
}

async function fetchEngineHealth(agent) {
  const enginePort = agent ? agent.enginePort || 5001 : 5001;
  return apiFetch(`http://${window.location.hostname}:${enginePort}/health`, { timeoutMs: 10000 });
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
    cosmoBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      // Deactivate all data-tab buttons
      document.querySelectorAll('.h23-tab[data-tab]').forEach(t => t.classList.remove('active'));
      cosmoBtn.classList.add('active');
      currentTab = 'cosmo23';
      refreshDashboardScopeUI();
      syncOrganDrawerForTab();
      setCosmoHomeDrawerOpen(false);
      await updateCosmoIndicator();
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

  const homeToggleBtn = document.getElementById('cosmo23-home-toggle-btn');
  if (homeToggleBtn) {
    homeToggleBtn.addEventListener('click', () => {
      setCosmoHomeDrawerOpen(!document.body.classList.contains('h23-external-drawer-open'));
    });
  }

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
  setCosmoHomeDrawerOpen(false);
}

function setCosmoHomeDrawerOpen(open) {
  const enabled = currentTab === 'cosmo23' && !!open;
  document.body.classList.toggle('h23-external-drawer-open', enabled);
  const button = document.getElementById('cosmo23-home-toggle-btn');
  if (button) {
    button.setAttribute('aria-expanded', String(enabled));
    button.textContent = enabled ? 'Close Home23' : 'Home23';
  }
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
  try {
    const res = await fetch(`${cosmo23Url}/api/status`, { signal: AbortSignal.timeout(10000) });
    const status = await res.json();
    cosmoOnline = true;
    if (status.running && status.activeContext) {
      if (dot) dot.className = 'h23-cosmo-indicator-dot running';
      if (text) text.textContent = `COSMO: running — ${status.activeContext.runName || 'research'}`;
    } else {
      if (dot) dot.className = 'h23-cosmo-indicator-dot';
      if (text) text.textContent = 'COSMO: idle';
    }
    // If we just came back online and the tab is showing, refresh
    if (currentTab === 'cosmo23') hideCosmoOfflineOverlay();
  } catch {
    cosmoOnline = false;
    if (dot) dot.className = 'h23-cosmo-indicator-dot error';
    if (text) text.textContent = 'COSMO: offline';
    // If viewing the COSMO tab right now, show the overlay
    if (currentTab === 'cosmo23') showCosmoOfflineOverlay();
  }
}

// ── Tabs ──

function setupOrganDrawer() {
  syncOrganDrawerForTab();
}

function syncOrganDrawerForTab() {
  const drawer = document.getElementById('organs-drawer');
  if (!drawer) return;
  const organTabs = new Set(['workers', 'query', 'brain-map', 'cosmo23']);
  const isOrganTab = organTabs.has(currentTab);
  if (isOrganTab) {
    drawer.open = true;
  } else {
    drawer.open = false;
  }
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
      syncOrganDrawerForTab();

      let panel = document.getElementById(`panel-${currentTab}`);
      if (panel) panel.classList.add('active');

      // Brain Map tab: initialize on first visit
      if (currentTab === 'brain-map') {
        if (typeof initBrainMap === 'function') initBrainMap();
      }

      // Query tab: initialize on first visit (resolves current dashboard agent brain via cosmo23).
      if (currentTab === 'query') {
        if (typeof initQueryTab === 'function') initQueryTab();
      }

      if (currentTab === 'workers') {
        loadWorkersSurface().catch(() => {});
      }

      if (currentTab === 'agency') {
        loadAgencySurface().catch(() => {});
      }

      if (currentTab === 'home') loadResidentHomeSurface().catch(() => {});

    });
  });
}

// ── Resident Home ──

function setupResidentHomeSurface() {
  document.getElementById('resident-refresh')?.addEventListener('click', () => {
    loadResidentHomeSurface().catch((err) => renderResidentHomeError(err));
  });
  document.getElementById('resident-run-tick')?.addEventListener('click', () => {
    runResidentTickFromDashboard().catch((err) => renderResidentHomeError(err));
  });
  document.addEventListener('click', (event) => {
    const tabJump = event.target.closest('[data-tab-jump]');
    if (tabJump) {
      event.preventDefault();
      const tabKey = tabJump.dataset?.tabJump;
      const tab = tabKey ? document.querySelector(`.h23-tab[data-tab="${tabKey}"]`) : null;
      if (tab) tab.click();
      return;
    }

    const button = event.target.closest('[data-resident-pursuit-transition]');
    if (!button) return;
    const pursuitId = button.dataset.pursuitId;
    const status = button.dataset.residentPursuitTransition;
    const summary = button.dataset.transitionSummary || 'Updated from resident dashboard.';
    if (!pursuitId || !status) return;
    const confirmed = confirmResidentPursuitTransition(pursuitId, status, summary);
    if (!confirmed) return;
    button.disabled = true;
    transitionResidentPursuitFromDashboard(pursuitId, status, summary)
      .catch((err) => renderResidentHomeError(err))
      .finally(() => {
        button.disabled = false;
      });
  });
}

async function fetchAgencySnapshot() {
  const [stateRes, briefRes, pursuitsRes, eventsRes] = await Promise.all([
    fetch(`${dashboardBaseUrl()}/home23/api/agency/state`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/brief`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/pursuits?limit=24`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/events?limit=40`),
  ]);
  if (!stateRes.ok || !briefRes.ok || !pursuitsRes.ok || !eventsRes.ok) {
    throw new Error('resident agency state unavailable');
  }
  const statePayload = await stateRes.json();
  const briefPayload = await briefRes.json();
  const pursuitsPayload = await pursuitsRes.json();
  const eventsPayload = await eventsRes.json();
  return {
    state: statePayload.state || statePayload,
    brief: briefPayload.brief || briefPayload,
    pursuits: pursuitsPayload.pursuits || [],
    inbox: eventsPayload.inbox || [],
    receipts: eventsPayload.receipts || eventsPayload.actions || [],
    consequences: eventsPayload.consequences || [],
  };
}

async function loadResidentHomeSurface() {
  const snapshot = await fetchAgencySnapshot();
  renderResidentHomeSurface(snapshot);
}

async function runResidentTickFromDashboard() {
  const button = document.getElementById('resident-run-tick');
  const isRehearsal = button?.dataset?.actionMode === 'rehearsal';
  if (button) {
    button.disabled = true;
    button.textContent = isRehearsal ? 'Rehearsing' : 'Advancing';
  }
  try {
    const res = await fetch(`${dashboardBaseUrl()}/home23/api/agency/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'dashboard_operator_tick' }),
    });
    if (!res.ok) throw new Error(`tick failed (${res.status})`);
    await loadResidentHomeSurface();
  } finally {
    if (button) {
      button.disabled = false;
      syncResidentActionButton(residentHomeLatestState);
    }
  }
}

function confirmResidentPursuitTransition(pursuitId, status, summary) {
  const action = status === 'discarded'
    ? 'discard this resident pursuit'
    : status === 'closed'
      ? 'close this resident pursuit'
      : `move this resident pursuit to ${status}`;
  const message = [
    `Confirm: ${action}.`,
    'This writes an agency receipt and removes it from active attention.',
    summary ? `Receipt: ${summary}` : null,
    pursuitId ? `Pursuit: ${pursuitId}` : null,
  ].filter(Boolean).join('\n\n');
  return window.confirm(message);
}

async function transitionResidentPursuitFromDashboard(pursuitId, status, summary) {
  const res = await fetch(`${dashboardBaseUrl()}/home23/api/agency/pursuits/${encodeURIComponent(pursuitId)}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status,
      summary,
      reason: summary,
      evidenceRef: 'dashboard:resident-home',
    }),
  });
  if (!res.ok) throw new Error(`pursuit transition failed (${res.status})`);
  await loadResidentHomeSurface();
  if (currentTab === 'agency') loadAgencySurface().catch(() => {});
}

function renderResidentHomeSurface({ state, brief, pursuits, inbox, receipts, consequences }) {
  residentHomeLatestState = state;
  const active = Number(state.attention?.activePursuits || 0);
  const activeMax = Number(state.attention?.maxActivePursuits || state.charter?.attention?.maxActivePursuits || 0);
  const watch = Number(state.attention?.watchItems || 0);
  const watchMax = Number(state.attention?.maxWatchItems || state.charter?.attention?.maxWatchItems || 0);
  setText('resident-mode', residentPostureText(state));
  setHtml('resident-health-strip', renderResidentAttentionBudget({ active, activeMax, watch, watchMax }));
  syncResidentActionButton(state);

  const nextActionHtml = renderResidentNextAction(state);
  toggleResidentNextActionPanel(nextActionHtml);
  setHtml('resident-next-action', nextActionHtml);
  const operatorItems = residentOperatorItems(state, brief);
  toggleResidentOperatorPanel(operatorItems);
  setHtml('resident-operator-needed', operatorItems.length ? renderResidentOperatorNeeded(operatorItems) : '');
  const pursuitSource = Array.isArray(state.activePursuits) ? state.activePursuits : pursuits;
  const activePursuits = filterResidentBacklogPursuits(pursuitSource, state.currentPursuit?.id);
  toggleResidentAttentionPanel(activePursuits);
  setHtml('resident-active-pursuits', activePursuits.length
    ? activePursuits.map(renderResidentPursuitCard).join('')
    : '');
  const consequenceRows = groupResidentConsequences(residentHomeConsequenceRows(state.recentConsequences || consequences || [])).slice(0, 6);
  toggleResidentConsequencesPanel(consequenceRows);
  setHtml('resident-consequences', consequenceRows.length
    ? consequenceRows.map(renderResidentConsequenceItem).join('')
    : '');
}

function filterResidentBacklogPursuits(pursuits, currentPursuitId) {
  return (pursuits || [])
    .filter((p) => p && p.status !== 'discarded' && p.status !== 'closed')
    .filter((p) => !currentPursuitId || p.id !== currentPursuitId)
    .slice(0, 5);
}

function syncResidentActionButton(state) {
  const button = document.getElementById('resident-run-tick');
  if (!button) return;
  const action = residentActionButtonState(state);
  button.disabled = false;
  button.textContent = action.label;
  button.title = action.title;
  button.dataset.actionMode = action.mode;
}

function residentActionButtonState(state = {}) {
  const next = state.nextAction || {};
  const rehearsal = state.mode === 'dry_run' || next.dryRun;
  if (rehearsal) {
    return {
      label: 'Rehearse',
      title: 'Dry-run mode: records resident intent and receipts without live action.',
      mode: 'rehearsal',
    };
  }
  return {
    label: 'Advance',
    title: 'Advance the resident loop now.',
    mode: 'live',
  };
}

function renderResidentAttentionBudget({ active, activeMax, watch, watchMax }) {
  return `
    <span>${active}/${activeMax || '—'} active</span>
    <span>${watch}/${watchMax || '—'} watch</span>
  `;
}

function residentPostureText(state = {}) {
  if (state.bootcamp?.enabled) return 'in agency bootcamp';
  const mode = String(state.mode || '').trim();
  if (mode === 'dry_run') return 'rehearsing agency';
  if (mode === 'live') return 'acting live';
  if (mode) return humanizeResidentMachineText(mode).toLowerCase();
  return 'waiting for resident state';
}

function toggleResidentOperatorPanel(items) {
  const panel = document.getElementById('resident-operator-needed');
  if (panel) panel.hidden = !items.length;
}

function toggleResidentNextActionPanel(html) {
  const panel = document.getElementById('resident-next-action');
  if (panel) panel.hidden = !String(html || '').trim();
}

function toggleResidentAttentionPanel(items) {
  const panel = document.getElementById('resident-attention-panel');
  if (panel) panel.hidden = !items.length;
}

function toggleResidentConsequencesPanel(items) {
  const panel = document.getElementById('resident-consequence-panel');
  if (panel) panel.hidden = !items.length;
}

function humanizeResidentMachineText(text, fallback = '') {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  const neighborMatch = raw.match(/^\[neighbor\.([^\]]+)\]\s+\{/i);
  if (neighborMatch) {
    return `Neighbor report from ${residentTitleCase(neighborMatch[1])}`;
  }
  const bracketedJsonMatch = raw.match(/^\[([^\]]+)\]\s+\{/i);
  if (bracketedJsonMatch) {
    const source = bracketedJsonMatch[1];
    const sourceLabels = {
      'machine.memory': 'Machine memory telemetry',
      'machine.cpu': 'Machine CPU telemetry',
      'machine.process': 'Machine process telemetry',
      'machine.swap': 'Machine swap telemetry',
      'work.heartbeat': 'Work heartbeat',
      'work.live-problems': 'Live problem check',
    };
    if (sourceLabels[source]) return sourceLabels[source];
    return `${residentTitleCase(source.split('.').pop())} evidence`;
  }
  if (/^[{\[]/.test(raw) && /"agent"\s*:/.test(raw)) {
    return 'Structured resident evidence';
  }
  if (/^Cron agent-[\w-]+ \(exec\) finished with status ok\.$/i.test(raw)) {
    return 'Scheduler check finished';
  }
  if (/^Cron outcome updates resident pursuit ap_[\w-]+ with latest scheduler evidence\.$/i.test(raw)) {
    return 'Scheduler evidence updated a resident pursuit';
  }
  if (/^attach scheduler outcome to the bound resident pursuit/i.test(raw)) {
    return 'Attach scheduler evidence and continue based on semantic status';
  }
  if (raw === 'pursuit_has_no_editor_block') {
    return 'No editor block is stopping this step';
  }
  if (raw === 'advance_one_step') {
    return 'Advance one step';
  }
  if (raw === 'pursuit_closed_by_receipt') {
    return 'Pursuit closed';
  }
  return raw
    .replace(/\bagent-[0-9a-f-]{10,}\b/gi, 'agent')
    .replace(/\bap_[0-9a-f]{8,}\b/gi, 'resident pursuit')
    .replace(/\s+/g, ' ')
    .trim();
}

function residentSourceLabel(source) {
  const value = String(source || '').trim();
  if (!value) return '';
  if (value === 'domain.good-life') return 'Good Life';
  if (value.startsWith('cron.')) return 'cron receipt';
  if (value.startsWith('worker.')) return 'worker receipt';
  if (value.startsWith('chat.')) return 'chat';
  return value;
}

function residentTitleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function renderGoodLifeResidentPursuitTitle(p) {
  const raw = String(p?.title || p?.summary || '').trim();
  const drift = raw.match(/^(help|repair|recover|learn|play|rest|ask|observe)\s+-\s+(\w+)\s+([\w-]+)\s+drift/i);
  if (drift) return `${residentTitleCase(drift[3])} ${residentTitleCase(drift[1])}`;
  const policy = raw.match(/^(help|repair|recover|learn|play|rest|ask|observe)\b/i);
  if (policy) return `Good Life ${residentTitleCase(policy[1])}`;
  return '';
}

function renderResidentPursuitTitle(p) {
  if (p.source === 'domain.good-life') {
    const title = renderGoodLifeResidentPursuitTitle(p);
    if (title) return title;
  }
  return humanizeResidentMachineText(p.title || p.summary || p.id, 'Resident pursuit');
}

function renderResidentPursuitAuthority(p) {
  return residentAuthorityLabel(p.authorityLevel || p.risk);
}

function residentAuthorityLabel(level) {
  const value = String(level || '').trim().toUpperCase();
  if (value === 'L0') return 'observe';
  if (value === 'L1') return 'notes';
  if (value === 'L2') return 'bounded action';
  if (value === 'L3') return 'approval path';
  if (value === 'L4') return 'requires approval';
  return humanizeResidentMachineText(level, 'authority unknown').toLowerCase();
}

function renderResidentPursuitInspectLink(p) {
  return `
    <a class="h23-resident-inspect-link" href="#agency" aria-label="Inspect resident pursuit evidence" title="Inspect resident pursuit evidence" data-tab-jump="agency" data-pursuit-id="${escapeAttr(p.id || '')}"></a>
  `;
}

function renderResidentNextActionTitle(pursuit, next) {
  const title = renderGoodLifeResidentPursuitTitle(pursuit) || renderGoodLifeResidentPursuitTitle({ title: next.title || next.reason });
  if (title) return title;
  return humanizeResidentMachineText(pursuit.title || pursuit.summary || next.kind || next.pursuitId, 'Resident action');
}

function renderResidentNextActionMeta(pursuit, next) {
  return [
    residentAuthorityLabel(next.authorityLevel || pursuit.authorityLevel),
    residentActionReasonLabel(next.reason),
    residentActionModeLabel(next),
  ].filter(Boolean).join(' · ');
}

function residentActionReasonLabel(reason) {
  if (reason === 'pursuit_has_no_editor_block') return 'ready';
  return humanizeResidentMachineText(reason);
}

function residentActionModeLabel(next) {
  if (next?.dryRun) return 'rehearsal';
  return '';
}

function renderResidentNextAction(state) {
  const next = state.nextAction || {};
  const pursuit = state.currentPursuit || {};
  if (!next.kind && !pursuit.id) {
    return '';
  }
  return `
    <div class="h23-resident-section-title">Next Action</div>
    <div class="h23-resident-next-title">${escapeHtml(renderResidentNextActionTitle(pursuit, next))}</div>
    <div class="h23-resident-next-meta">${escapeHtml(renderResidentNextActionMeta(pursuit, next))}</div>
  `;
}

function residentOperatorItems(state, brief) {
  const obligations = Array.isArray(state.obligations) ? state.obligations : [];
  const questions = brief?.questions?.whatNeedsJtr || [];
  return obligations.length ? obligations : questions;
}

function renderResidentOperatorNeeded(items) {
  const title = '<div class="h23-resident-section-title">Needed From You</div>';
  return `${title}${items.slice(0, 4).map((item) => `
    <div class="h23-resident-alert">
      <strong>${escapeHtml(item.kind || item.type || item.title || 'operator input')}</strong>
      <span>${escapeHtml(item.summary || item.reason || item.text || item.pursuitId || '')}</span>
    </div>
  `).join('')}`;
}

function renderResidentPursuitCard(p) {
  const statusClass = p.status === 'active' ? 'active' : (p.status || 'watch');
  return `
    <article class="h23-resident-pursuit ${escapeAttr(statusClass)}">
      <div class="h23-resident-pursuit-head">
        <code>${escapeHtml(renderResidentPursuitAuthority(p))}</code>
      </div>
      <h3>${escapeHtml(renderResidentPursuitTitle(p))}</h3>
      <div class="h23-resident-pursuit-actions">
        ${renderResidentPursuitInspectLink(p)}
        <button type="button" class="h23-resident-action-btn danger h23-resident-veto-btn" aria-label="Veto resident pursuit as noise" title="Veto resident pursuit as noise" data-requires-confirmation="true" data-pursuit-id="${escapeAttr(p.id)}" data-resident-pursuit-transition="discarded" data-transition-summary="Vetoed from resident dashboard: this is noise or no longer worth active operator attention."></button>
      </div>
    </article>
  `;
}

function renderResidentConsequenceRow(c) {
  return `
    <div class="h23-resident-event consequence">
      <strong>${escapeHtml(renderResidentConsequenceTitle(c))}</strong>
      <span>${escapeHtml(renderResidentConsequenceSummary(c))}</span>
      <small>${escapeHtml(renderResidentConsequenceMeta(c))}</small>
    </div>
  `;
}

function renderResidentConsequenceTitle(c) {
  const type = String(c?.changeType || c?.status || 'consequence');
  if (type === 'cron_receipt_reattached') return 'Scheduler evidence attached';
  if (type === 'pursue' && /^Cron agent-[\w-]+ \([^)]+\) finished with status ok\.$/i.test(String(c?.summary || ''))) {
    return 'Scheduler run reviewed';
  }
  return humanizeResidentMachineText(type, 'Consequence');
}

function renderResidentConsequenceSummary(c) {
  const summary = String(c?.summary || c?.reason || '').trim();
  if (/^Cron receipt pursuit ap_[\w-]+ reattached to ap_[\w-]+\.$/i.test(summary)) {
    return 'A scheduler receipt was attached to its existing resident pursuit instead of becoming dashboard noise.';
  }
  return humanizeResidentMachineText(summary, 'No operator-facing summary yet.');
}

function renderResidentConsequenceMeta(c) {
  const parts = [];
  if (c?.source) parts.push(residentSourceLabel(c.source));
  if (c?.authorityLevel) parts.push(c.authorityLevel);
  if (c?.at) parts.push(timeSinceSafe(c.at));
  return parts.join(' · ');
}

function extractCronNameFromConsequence(c) {
  const text = String(c?.summary || c?.reason || '').trim();
  const quoted = text.match(/Recurring cron "([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  return humanizeResidentMachineText(c?.changeType || c?.status || 'cron');
}

function groupResidentSchedulerEvidence(row) {
  const type = String(row?.changeType || row?.status || '');
  const summary = String(row?.summary || row?.reason || '');
  return type === 'cron_receipt_reattached'
    || /^Cron receipt pursuit ap_[\w-]+ reattached to ap_[\w-]+\.$/i.test(summary)
    || (type === 'pursue' && /^Cron agent-[\w-]+ \([^)]+\) finished with status ok\.$/i.test(summary));
}

function residentHomeConsequenceRows(rows = []) {
  return (rows || []).filter((row) => !groupResidentSchedulerEvidence(row));
}

function groupResidentConsequences(rows = []) {
  const grouped = [];
  let cronRows = [];
  let schedulerRows = [];

  const flushCronGroup = () => {
    if (!cronRows.length) return;
    if (cronRows.length === 1) {
      grouped.push(cronRows[0]);
    } else {
      const names = cronRows.map(extractCronNameFromConsequence).filter(Boolean);
      const firstNames = names.slice(0, 3).join(', ');
      const more = names.length > 3 ? ` +${names.length - 3} more` : '';
      grouped.push({
        kind: 'group',
        changeType: 'cron_retirement_proposed',
        status: 'proposed',
        count: cronRows.length,
        at: cronRows[0]?.at,
        summary: `${cronRows.length} recurring crons reached stop conditions and are proposed for retirement.`,
        detail: [firstNames, more].filter(Boolean).join(''),
        items: cronRows,
      });
    }
    cronRows = [];
  };

  const flushSchedulerGroup = () => {
    if (!schedulerRows.length) return;
    if (schedulerRows.length === 1) {
      grouped.push(schedulerRows[0]);
    } else {
      grouped.push({
        kind: 'scheduler-evidence-group',
        changeType: 'scheduler_evidence_attached',
        status: 'reviewed',
        count: schedulerRows.length,
        at: schedulerRows[0]?.at,
        summary: `${schedulerRows.length} scheduler receipts were reviewed and folded into existing resident pursuits.`,
        items: schedulerRows,
      });
    }
    schedulerRows = [];
  };

  rows.forEach((row) => {
    if (row?.changeType === 'cron_retirement_proposed') {
      flushSchedulerGroup();
      cronRows.push(row);
      return;
    }
    if (groupResidentSchedulerEvidence(row)) {
      flushCronGroup();
      schedulerRows.push(row);
      return;
    }
    flushCronGroup();
    flushSchedulerGroup();
    grouped.push(row);
  });
  flushCronGroup();
  flushSchedulerGroup();
  return grouped;
}

function renderResidentConsequenceItem(c) {
  if (c?.kind === 'group') return renderResidentConsequenceGroup(c);
  if (c?.kind === 'scheduler-evidence-group') return renderResidentSchedulerEvidenceGroup(c);
  return renderResidentConsequenceRow(c);
}

function renderResidentConsequenceGroup(group) {
  return `
    <div class="h23-resident-event consequence grouped">
      <strong>Cron cleanup proposed</strong>
      <span>${escapeHtml(group.summary || '')}</span>
      <small>${escapeHtml([group.detail, group.at ? timeSinceSafe(group.at) : null].filter(Boolean).join(' · '))}</small>
    </div>
  `;
}

function renderResidentSchedulerEvidenceGroup(group) {
  return `
    <div class="h23-resident-event consequence grouped">
      <strong>Scheduler evidence folded in</strong>
      <span>${escapeHtml(group.summary || '')}</span>
      <small>${escapeHtml(group.at ? timeSinceSafe(group.at) : '')}</small>
    </div>
  `;
}

function renderResidentReceiptRow(r) {
  return `
    <div class="h23-resident-event">
      <strong>${escapeHtml(r.event || r.route || 'receipt')}</strong>
      <span>${escapeHtml(r.reason || r.status || '')}</span>
      <small>${escapeHtml([r.pursuitId, r.at ? timeSinceSafe(r.at) : null].filter(Boolean).join(' · '))}</small>
    </div>
  `;
}

function renderResidentInboxRow(c) {
  const decision = c.decision || {};
  return `
    <div class="h23-resident-event">
      <strong>${escapeHtml(decision.route || c.route || 'unrouted')}</strong>
      <span>${escapeHtml(c.summary || c.title || c.candidateId || '')}</span>
      <small>${escapeHtml([c.source, decision.reason].filter(Boolean).join(' · '))}</small>
    </div>
  `;
}

function renderResidentHomeError(err) {
  setText('resident-mode', 'state unavailable');
  const button = document.getElementById('resident-run-tick');
  if (button) {
    button.disabled = true;
    button.textContent = 'Unavailable';
    button.title = err?.message || 'Resident agency state is unavailable.';
  }
}

// ── Agency Inspector ──

async function loadAgencySurface() {
  const [stateRes, briefRes, inspectorRes, pursuitsRes, eventsRes] = await Promise.all([
    fetch(`${dashboardBaseUrl()}/home23/api/agency/state`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/brief`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/inspector?filter=cron_retirement_proposals&limit=20`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/pursuits?limit=24`),
    fetch(`${dashboardBaseUrl()}/home23/api/agency/events?limit=40`),
  ]);
  if (!stateRes.ok || !briefRes.ok || !inspectorRes.ok || !pursuitsRes.ok || !eventsRes.ok) {
    throw new Error('agency surface unavailable');
  }
  const state = await stateRes.json();
  const brief = await briefRes.json();
  const inspector = await inspectorRes.json();
  const pursuits = await pursuitsRes.json();
  const events = await eventsRes.json();
  renderAgencySurface({
    state,
    brief,
    inspector,
    pursuits: pursuits.pursuits || [],
    inbox: events.inbox || [],
    receipts: events.receipts || events.actions || [],
    consequences: events.consequences || [],
    scratch: events.scratch || [],
    truth: events.truth || [],
  });
}

function renderAgencySurface({ state, brief, inspector, pursuits, inbox, receipts, consequences, scratch, truth }) {
  const stats = document.getElementById('agency-stats');
  if (stats) {
    const active = Number(state.attention?.activePursuits || 0);
    const activeMax = Number(state.attention?.maxActivePursuits || state.charter?.attention?.maxActivePursuits || 0);
    const watch = Number(state.attention?.watchItems || 0);
    const watchMax = Number(state.attention?.maxWatchItems || state.charter?.attention?.maxWatchItems || 0);
    stats.innerHTML = `
      <div class="h23-worker-stat"><span>${escapeHtml(residentAgencyModeLabel(state.mode))}</span><label>Mode</label></div>
      <div class="h23-worker-stat"><span>${active}/${activeMax || '—'} · ${watch}/${watchMax || '—'}</span><label>Active/Watch</label></div>
      <div class="h23-worker-stat"><span>${agencyOperatorNeedCount(state, brief)}</span><label>Needs jtr</label></div>
      <div class="h23-worker-stat"><span>${escapeHtml(residentActionAuthorityLabel(state.nextAction))}</span><label>Next Authority</label></div>
    `;
  }

  const scratchEl = document.getElementById('agency-scratch');
  if (scratchEl) {
    scratchEl.innerHTML = renderAgencyScratchBlock(state, scratch);
  }

  const briefEl = document.getElementById('agency-brief');
  if (briefEl) {
    briefEl.innerHTML = renderAgencyBriefBlock(brief);
  }

  const truthEl = document.getElementById('agency-truth');
  if (truthEl) {
    truthEl.innerHTML = renderAgencyTruthBlock(state, truth);
  }

  const organsEl = document.getElementById('agency-organs');
  if (organsEl) {
    organsEl.innerHTML = renderAgencyOrgansBlock(state);
  }

  const retirementEl = document.getElementById('agency-retirement-proposals');
  if (retirementEl) {
    const proposals = inspector?.filters?.cronRetirementProposals?.items || [];
    const retirementDrawer = document.getElementById('agency-retirement-drawer');
    if (retirementDrawer) {
      retirementDrawer.hidden = !proposals.length;
      retirementDrawer.open = proposals.length > 0;
    }
    retirementEl.innerHTML = proposals.length
      ? proposals.map(renderAgencyRetirementProposalRow).join('')
      : '<p class="h23-muted">No cron retirement proposals.</p>';
  }

  const pursuitEl = document.getElementById('agency-pursuits');
  if (pursuitEl) {
    const visiblePursuits = residentAgencyVisiblePursuits(state, pursuits);
    pursuitEl.innerHTML = visiblePursuits.length ? visiblePursuits.map(renderAgencyPursuitRow).join('') : '<p class="h23-muted">No active or watch pursuits.</p>';
  }

  const receiptEl = document.getElementById('agency-receipts');
  if (receiptEl) {
    receiptEl.innerHTML = receipts.length ? receipts.slice(0, 16).map(renderAgencyReceiptRow).join('') : '<p class="h23-muted">No route receipts yet.</p>';
  }

  const inboxEl = document.getElementById('agency-inbox');
  if (inboxEl) {
    inboxEl.innerHTML = inbox.length ? inbox.slice(0, 20).map(renderAgencyInboxRow).join('') : '<p class="h23-muted">No inbox decisions yet.</p>';
  }

  const consequenceEl = document.getElementById('agency-consequences');
  if (consequenceEl) {
    consequenceEl.innerHTML = consequences.length ? consequences.slice(0, 16).map(renderAgencyConsequenceRow).join('') : '<p class="h23-muted">No verified consequences yet.</p>';
  }

  revealAgencyInspectorContract();
}

function revealAgencyInspectorContract() {
  const stats = document.getElementById('agency-stats');
  const brief = document.getElementById('agency-brief-section');
  if (stats) stats.hidden = false;
  if (brief) brief.hidden = false;
  revealAgencyEvidenceDrawers();
}

function revealAgencyEvidenceDrawers() {
  document.querySelectorAll('#panel-agency .h23-agency-evidence-drawer:not(#agency-retirement-drawer)').forEach((drawer) => {
    drawer.hidden = false;
  });
}

function residentAgencyVisiblePursuits(state, pursuits = []) {
  const pursuitSource = Array.isArray(state.activePursuits) ? state.activePursuits : pursuits;
  return (pursuitSource || []).filter((pursuit) => {
    const status = String(pursuit?.status || '').toLowerCase();
    return status !== 'discarded' && status !== 'closed';
  });
}

function agencyOperatorNeedCount(state, brief) {
  const obligations = Array.isArray(state.obligations) ? state.obligations.length : 0;
  const questions = Array.isArray(brief?.questions?.whatNeedFromJtr)
    ? brief.questions.whatNeedFromJtr.length
    : Array.isArray(brief?.questions?.whatNeedsJtr)
      ? brief.questions.whatNeedsJtr.length
      : 0;
  return obligations || questions || 0;
}

function residentAgencyModeLabel(mode) {
  if (mode === 'dry_run') return 'rehearsal';
  if (mode === 'live') return 'live';
  return humanizeResidentMachineText(mode || 'unknown');
}

function residentActionAuthorityLabel(next) {
  if (!next?.authorityLevel) return 'none';
  return next.dryRun ? `${next.authorityLevel} rehearsal` : next.authorityLevel;
}

function renderAgencyScratchBlock(state, scratch = []) {
  const nextAction = state.nextAction || {};
  const bootcamp = state.bootcamp || {};
  const lastKillReview = state.governance?.lastKillReview || null;
  const bootcampRules = Array.isArray(bootcamp.rules)
    ? bootcamp.rules
    : Object.entries(bootcamp)
        .filter(([key, value]) => key !== 'enabled' && value === true)
        .map(([key]) => key);
  const rows = [];
  if (nextAction.kind || nextAction.pursuitId) {
    rows.push(`
      <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #ffcc00;">
        <div style="font-size:12px;color:rgba(255,255,255,0.55);">Selected next action</div>
        <div style="color:#fff;font-size:13px;">${escapeHtml(nextAction.kind || 'advance_one_step')} ${nextAction.pursuitId ? `→ ${escapeHtml(nextAction.pursuitId)}` : ''}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(nextAction.summary || nextAction.nextMove || '')}</div>
      </div>
    `);
  }
  rows.push(`
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid ${bootcamp.enabled ? '#ff9f0a' : '#8e8e93'};">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">Agency bootcamp</div>
      <div style="color:#fff;font-size:13px;">${bootcamp.enabled ? 'enabled' : 'disabled'}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(bootcampRules.slice(0, 4).join(' · ') || 'No bootcamp rules reported.')}</div>
    </div>
  `);
  if (lastKillReview) {
    rows.push(`
      <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #ff453a;">
        <div style="font-size:12px;color:rgba(255,255,255,0.55);">Last kill review</div>
        <div style="color:#fff;font-size:13px;">${Number(lastKillReview.killed || 0)} killed · ${Number(lastKillReview.checked || 0)} checked</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(lastKillReview.at ? new Date(lastKillReview.at).toLocaleString() : '')}</div>
      </div>
    `);
  }
  for (const row of scratch.slice(0, 8)) {
    rows.push(renderAgencyScratchRow(row));
  }
  return rows.join('') || '<p class="h23-muted">No resident scratch entries yet.</p>';
}

function renderAgencyScratchRow(row) {
  const verdict = row.editorVerdict || row.verdict || {};
  const outcome = verdict.verdict || row.kind || row.event || 'scratch';
  const reason = verdict.reason || row.reason || row.summary || '';
  return `
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #bf5af2;">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(row.at ? new Date(row.at).toLocaleString() : '')}</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml(outcome)} ${row.pursuitId ? `→ ${escapeHtml(row.pursuitId)}` : ''}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(reason)}</div>
    </div>
  `;
}

function renderAgencyBriefBlock(brief) {
  if (!brief) return '<p class="h23-muted">No resident brief reported.</p>';
  const questions = brief.questions || {};
  const blocks = [
    renderAgencyBriefQuestionBlock('Following', questions.whatFollowing, renderAgencyBriefFollowingRow),
    renderAgencyBriefQuestionBlock('Changed', agencyMeaningfulBriefChanges(questions.whatChanged), renderAgencyBriefChangeRow),
    renderAgencyBriefQuestionBlock('Next', questions.whatDoingNext ? [questions.whatDoingNext] : [], renderAgencyBriefNextRow),
    renderAgencyBriefQuestionBlock('Needs jtr', questions.whatNeedFromJtr, renderAgencyBriefNeedRow),
  ].filter(Boolean);
  return blocks.join('') || '<p class="h23-muted">No resident brief reported.</p>';
}

function renderAgencyBriefQuestionBlock(label, items, renderRow) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return '';
  return `
    <div class="h23-agency-brief-block">
      <div class="h23-agency-brief-label">${escapeHtml(label)}</div>
      ${rows.slice(0, 4).map(renderRow).join('')}
    </div>
  `;
}

function agencyMeaningfulBriefChanges(items = []) {
  return (items || []).filter((item) => {
    const summary = String(item?.summary || item?.reason || '').trim();
    const kind = String(item?.kind || item?.type || '').trim();
    return summary !== 'pursuit_has_no_editor_block' && kind !== 'explicit_no_change';
  });
}

function renderAgencyBriefFollowingRow(item) {
  return `
    <div class="h23-agency-brief-row">
      <strong>${escapeHtml(renderResidentPursuitTitle(item))}</strong>
      <span>${escapeHtml(humanizeResidentMachineText(item.nextMove || item.desiredChangedFuture || item.whyItMatters || ''))}</span>
      <small>${escapeHtml([item.status, item.authorityLevel].filter(Boolean).join(' · '))}</small>
    </div>
  `;
}

function renderAgencyBriefChangeRow(item) {
  return `
    <div class="h23-agency-brief-row">
      <strong>${escapeHtml(renderResidentConsequenceTitle(item))}</strong>
      <span>${escapeHtml(renderResidentConsequenceSummary(item))}</span>
      <small>${escapeHtml(item.at ? timeSinceSafe(item.at) : '')}</small>
    </div>
  `;
}

function renderAgencyBriefNextRow(item) {
  return `
    <div class="h23-agency-brief-row">
      <strong>${escapeHtml(humanizeResidentMachineText(item.kind || 'advance_one_step'))}</strong>
      <span>${escapeHtml(residentActionReasonLabel(item.reason) || 'ready')}</span>
      <small>${escapeHtml([item.authorityLevel, residentActionModeLabel(item)].filter(Boolean).join(' · '))}</small>
    </div>
  `;
}

function renderAgencyBriefNeedRow(item) {
  return `
    <div class="h23-agency-brief-row">
      <strong>${escapeHtml(item.kind || item.type || item.title || 'jtr decision')}</strong>
      <span>${escapeHtml(item.summary || item.reason || item.text || '')}</span>
    </div>
  `;
}

function renderAgencyTruthBlock(state, truth = []) {
  const hierarchy = state.truth?.currentSourceHierarchy || state.charter?.sourceTruthHierarchy || [];
  const rows = [];
  rows.push(`
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #64d2ff;">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">Enforced source order</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml((hierarchy || []).slice(0, 4).join(' > ') || 'No hierarchy reported')}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">Open contradictions: ${escapeHtml(String(state.truth?.unresolvedContradictions || 0))}</div>
    </div>
  `);
  for (const claim of truth.slice(0, 8)) {
    rows.push(renderAgencyTruthRow(claim));
  }
  return rows.join('') || '<p class="h23-muted">No truth claims yet.</p>';
}

function renderAgencyTruthRow(claim) {
  const contested = claim.contradicts ? 'contested' : 'claim';
  return `
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid ${claim.contradicts ? '#ff453a' : '#30d158'};">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(claim.at ? new Date(claim.at).toLocaleString() : '')} · ${escapeHtml(claim.authority || claim.sourceType || '')}</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml(contested)} ${claim.subject ? `→ ${escapeHtml(claim.subject)}` : ''}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(claim.claim || claim.summary || claim.value || '')}</div>
    </div>
  `;
}

function renderAgencyOrgansBlock(state) {
  const organs = state.organs && typeof state.organs === 'object' ? Object.entries(state.organs) : [];
  if (!organs.length) return '<p class="h23-muted">No body organ contract reported.</p>';
  return organs.slice(0, 8).map(([name, organ]) => {
    const senses = Array.isArray(organ.canSense) ? organ.canSense.slice(0, 3).join(' · ') : '';
    const changes = Array.isArray(organ.canChange) ? organ.canChange.slice(0, 3).join(' · ') : '';
    const never = Array.isArray(organ.mustNeverDoAlone) ? organ.mustNeverDoAlone.slice(0, 2).join(' · ') : '';
    return `
      <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #ffd60a;">
        <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(organ.kind || 'organ')} · ${escapeHtml(organ.commandSurface || '')}</div>
        <div style="color:#fff;font-size:13px;">${escapeHtml(name)}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">senses: ${escapeHtml(senses || 'unknown')}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">changes: ${escapeHtml(changes || 'unknown')}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">never alone: ${escapeHtml(never || 'not specified')}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">failure: ${escapeHtml(organ.failureSurface || 'unknown')}</div>
      </div>
    `;
  }).join('');
}

function renderAgencyPursuitRow(p) {
  const age = p.updatedAt ? timeSinceSafe(p.updatedAt) : '';
  return `
    <button type="button" class="h23-worker-run-row" style="text-align:left;">
      <div><strong>${escapeHtml(p.status || 'unknown')}</strong> <span>${escapeHtml(p.authorityLevel || '')}</span></div>
      <div>${escapeHtml(p.title || p.summary || p.id)}</div>
      <small>${escapeHtml(p.dedupeKey || p.source || '')}${age ? ` · ${escapeHtml(age)}` : ''}</small>
    </button>
  `;
}

function renderAgencyRetirementProposalRow(proposal) {
  const evidenceChain = Array.isArray(proposal.evidenceChain) ? proposal.evidenceChain : [];
  const runEvidence = Array.isArray(proposal.runEvidence)
    ? proposal.runEvidence
    : evidenceChain.filter(item => item.type === 'cron_run_log_excerpt');
  const job = proposal.job || evidenceChain.find(item => item.type === 'cron_job') || {};
  const pursuit = proposal.pursuit || evidenceChain.find(item => item.type === 'agency_pursuit') || {};
  const runRows = runEvidence.length
    ? runEvidence.slice(0, 4).map(run => {
        const semanticStatus = run.semanticStatus || 'unknown';
        return `
          <div style="margin-top:8px;padding:8px 10px;background:rgba(0,0,0,0.16);border:1px solid rgba(255,255,255,0.08);border-radius:6px;">
            <div style="font-size:12px;color:rgba(255,255,255,0.72);">${escapeHtml(run.type || 'cron_run_log_excerpt')} · ${escapeHtml(run.status || 'unknown')} · ${escapeHtml(semanticStatus)}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.56);">${escapeHtml(run.responsePreview || run.summary || run.ref || '')}</div>
          </div>
        `;
      }).join('')
    : '<div style="margin-top:8px;font-size:12px;color:rgba(255,255,255,0.5);">No recent run evidence attached.</div>';
  return `
    <div style="padding:12px 14px;margin-bottom:10px;background:rgba(255,255,255,0.035);border-left:3px solid #ff9f0a;">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(proposal.at ? new Date(proposal.at).toLocaleString() : '')} · ${escapeHtml(proposal.changeType || 'cron_retirement_proposed')}</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml(job.name || job.ref || 'unknown cron')} ${proposal.pursuitId ? `→ ${escapeHtml(proposal.pursuitId)}` : ''}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.62);">${escapeHtml(proposal.summary || '')}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.52);margin-top:6px;">pursuit: ${escapeHtml(pursuit.summary || pursuit.ref || 'not linked')} · status: ${escapeHtml(proposal.status || 'unknown')}</div>
      ${runRows}
    </div>
  `;
}

function renderAgencyReceiptRow(r) {
  const authority = r.authority?.reason ? ` · ${r.authority.reason}` : '';
  return `
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #5ac8fa;">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(r.at ? new Date(r.at).toLocaleString() : '')}</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml(r.event || r.route || 'receipt')} ${r.pursuitId ? `→ ${escapeHtml(r.pursuitId)}` : ''}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml([r.reason, r.mode, authority].filter(Boolean).join(' · '))}</div>
    </div>
  `;
}

function renderAgencyInboxRow(c) {
  const decision = c.decision || {};
  return `
    <div class="h23-worker-run-row" style="cursor:default;">
      <div><strong>${escapeHtml(decision.route || 'unrouted')}</strong> <span>${escapeHtml(c.authorityLevel || '')}</span></div>
      <div>${escapeHtml(renderAgencyCandidateTitle(c))}</div>
      <small>${escapeHtml(c.source || '')} · ${escapeHtml(decision.reason || '')}</small>
    </div>
  `;
}

function renderAgencyCandidateTitle(candidate) {
  return humanizeResidentMachineText(
    candidate.title || candidate.summary || candidate.candidateId,
    'Agency candidate'
  );
}

function renderAgencyConsequenceRow(c) {
  return `
    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-left:3px solid #30d158;">
      <div style="font-size:12px;color:rgba(255,255,255,0.55);">${escapeHtml(c.at ? new Date(c.at).toLocaleString() : '')}</div>
      <div style="color:#fff;font-size:13px;">${escapeHtml(c.status || 'consequence')} ${c.pursuitId ? `→ ${escapeHtml(c.pursuitId)}` : ''}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);">${escapeHtml(c.summary || '')}</div>
    </div>
  `;
}

// ── Workers ──

function workerApiUrl(path = '') {
  const url = new URL(`/home23/api/workers${path}`, window.location.origin);
  if (primaryAgent?.name) url.searchParams.set('agent', primaryAgent.name);
  return `${url.pathname}${url.search}`;
}

const WORKER_CAPABILITY_PROFILES = {
  systems: {
    title: 'Home23 Systems',
    headline: 'Use this when Home23 feels slow, stale, broken, or confusing.',
    useWhen: [
      'A dashboard, endpoint, PM2 process, or live problem needs a grounded check.',
      'You want evidence before restarting anything.',
      'You need a specialist pass that house agents can remember.'
    ],
    can: [
      'Inspect Home23 PM2 status',
      'Probe dashboard and engine endpoints',
      'Read scoped service logs',
      'Verify health, freshness, and receipts'
    ],
    guardrails: [
      'No global PM2 stop/delete',
      'No destructive git or file cleanup',
      'No claimed fix without a verifier'
    ],
    starterTasks: [
      {
        label: 'Check Home23 health',
        detail: 'Verify the dashboard, engine state endpoint, and worker connector are responding. Do not change files or restart processes.'
      },
      {
        label: 'Why is it slow?',
        detail: 'Diagnose whether Home23 is under CPU, memory, process, or endpoint pressure. Use current host evidence and do not make changes.'
      },
      {
        label: 'Inspect live problem',
        detail: 'Inspect the current Home23 live problem, identify the verifier it depends on, and report the next concrete repair step without changing files.'
      },
      {
        label: 'Verify a fix',
        detail: 'Re-run the relevant Home23 verifier for the described issue and produce a receipt with pass/fail evidence. Do not change files unless explicitly requested.'
      }
    ]
  },
  freshness: {
    title: 'Freshness',
    headline: 'Use this when data may look recent but could be stale underneath.',
    useWhen: [
      'A metric, sensor, snapshot, or receipt may be stale.',
      'A file was written recently but its payload has older dates.',
      'A house agent needs to know whether evidence is current enough to trust.'
    ],
    can: [
      'Compare wrapper timestamps with semantic dates',
      'Check endpoint freshness',
      'Classify data as fresh, stale, historical-only, or unknown',
      'Identify the next freshness verifier'
    ],
    guardrails: [
      'Read-only by default',
      'No historical data as operational truth',
      'No freshness claim from mtime alone'
    ],
    starterTasks: [
      {
        label: 'Check data freshness',
        detail: 'Check whether the named Home23 data source is current enough to trust. Compare file timestamps, payload dates, receipts, and endpoint state.'
      },
      {
        label: 'Find stale signals',
        detail: 'Inspect current Home23 state for stale metrics, stale snapshots, or contradictory freshness evidence. Do not change files.'
      },
      {
        label: 'Verify latest receipt',
        detail: 'Inspect the latest relevant receipt or state snapshot and report whether it represents current truth or older belief.'
      }
    ]
  },
  memory: {
    title: 'Memory',
    headline: 'Use this when Home23 may be remembering old conclusions as current truth.',
    useWhen: [
      'A problem keeps being rediscovered.',
      'Old memory may outrank current state.',
      'Resolved work needs a receipt or suppression clue.'
    ],
    can: [
      'Compare old beliefs with current snapshots',
      'Find duplicate loops',
      'Identify missing goal-resolution receipts',
      'Prepare memory-curator handoffs'
    ],
    guardrails: [
      'No silent memory rewrites',
      'Current state before narrative memory',
      'Exact evidence required'
    ],
    starterTasks: [
      {
        label: 'Audit stale belief',
        detail: 'Audit whether the described belief is current, stale, resolved, duplicated, or unknown. Prefer state snapshots and resolution receipts over old narrative memory.'
      },
      {
        label: 'Find rediscovery loop',
        detail: 'Look for repeated Home23 memory or agenda entries that indicate a rediscovery loop. Return evidence and a memory-curator handoff.'
      },
      {
        label: 'Check resolution receipt',
        detail: 'Check whether the described completed work has a durable resolution receipt that should suppress future rediscovery.'
      }
    ]
  },
  parity: {
    title: 'Parity',
    headline: 'Use this when a native or web surface needs to match Home23 behavior.',
    useWhen: [
      'A Mac, iOS, tvOS, or web surface is missing a Home23 capability.',
      'A feature needs portable client instructions.',
      'A contract needs to explain product intent, not just endpoints.'
    ],
    can: [
      'Compare source and target surfaces',
      'Extract endpoint and response contracts',
      'Separate portable behavior from local setup',
      'Produce implementation handoffs'
    ],
    guardrails: [
      'No intent from git diff alone',
      'No site-specific defaults in portable contracts',
      'Contract before client code'
    ],
    starterTasks: [
      {
        label: 'Create parity handoff',
        detail: 'Compare the source Home23 feature with the target client surface and produce a portable parity handoff with routes, models, UX expectations, and smoke tests.'
      },
      {
        label: 'Check client gap',
        detail: 'Inspect whether the target client already implements the described Home23 feature. Return missing files, contract gaps, and next implementation steps.'
      },
      {
        label: 'Review contract',
        detail: 'Review the described API or UI contract for portability, selected-agent routing, and native-client readiness.'
      }
    ]
  },
  release: {
    title: 'Release',
    headline: 'Use this before shipping a Home23 app, package, or service change.',
    useWhen: [
      'A build or upload needs preflight evidence.',
      'Version, build, changelog, or artifact state may be wrong.',
      'A release needs a checklist before execution.'
    ],
    can: [
      'Check version/build metadata',
      'Inspect recent commits and release notes',
      'Run targeted preflight commands',
      'Produce release handoffs'
    ],
    guardrails: [
      'No publishing without explicit request',
      'No version bump without scope',
      'Exact artifact evidence required'
    ],
    starterTasks: [
      {
        label: 'Release preflight',
        detail: 'Run a release readiness preflight for the described target. Check version/build metadata, recent commits, required tests, and likely blockers.'
      },
      {
        label: 'Build checklist',
        detail: 'Produce a portable build and upload checklist for the described app or package without changing versions or publishing artifacts.'
      },
      {
        label: 'Changelog summary',
        detail: 'Summarize the release-relevant changes since the named commit or tag and identify any missing verification.'
      }
    ]
  },
  feeder: {
    title: 'Feeder',
    headline: 'Use this when documents are not flowing into memory correctly.',
    useWhen: [
      'Ingestion counts, watch paths, or compiler queues look wrong.',
      'Files are pending, quarantined, stale, or not compiled.',
      'A document source needs diagnosis before changing settings.'
    ],
    can: [
      'Inspect feeder status and manifests',
      'Compare watch paths to processed files',
      'Check compiler, converter, and quarantine state',
      'Report ingestion freshness'
    ],
    guardrails: [
      'No moving user files by default',
      'No watcher equals compiled assumption',
      'Exact paths and counts when available'
    ],
    starterTasks: [
      {
        label: 'Check ingestion health',
        detail: 'Inspect Home23 ingestion health for the selected agent. Report watch paths, pending files, processed count, compiled count, quarantine state, and freshness.'
      },
      {
        label: 'Find stuck documents',
        detail: 'Look for documents that are pending, quarantined, stale, or not compiled. Do not move or delete files.'
      },
      {
        label: 'Verify feeder settings',
        detail: 'Check whether feeder settings and live feeder status agree. Return mismatches and the next repair step.'
      }
    ]
  }
};

function getWorkerCapability(worker) {
  return WORKER_CAPABILITY_PROFILES[worker?.name] || {
    title: worker?.displayName || worker?.name || 'Worker',
    headline: worker?.purpose || 'Reusable specialist for bounded Home23 work.',
    useWhen: ['A house agent needs a focused, reusable pass without spinning up a full engine.'],
    can: ['Work in its own workspace', 'Produce a receipt', 'Return evidence for house-agent memory'],
    guardrails: ['Bounded task scope', 'Receipt before claims', 'No hidden full engine'],
    starterTasks: [
      {
        label: 'Run focused check',
        detail: `Use ${worker?.displayName || worker?.name || 'this worker'} for a bounded check. Return evidence, verifier status, and a one-sentence summary.`
      }
    ]
  };
}

async function workerApi(path = '', options = {}) {
  const res = await fetch(workerApiUrl(path), {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Worker API HTTP ${res.status}`);
  return data;
}

function setupWorkersSurface() {
  document.getElementById('workers-refresh-btn')?.addEventListener('click', () => {
    loadWorkersSurface().catch((err) => renderWorkersError(err));
  });
  document.getElementById('worker-run-btn')?.addEventListener('click', () => {
    runWorkerFromDashboard().catch((err) => {
      const status = document.getElementById('worker-run-status');
      if (status) status.textContent = err.message;
    });
  });
  document.getElementById('worker-run-select')?.addEventListener('change', renderWorkerIntents);
  document.getElementById('worker-intents')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-worker-starter]');
    if (!button) return;
    const promptEl = document.getElementById('worker-run-prompt');
    if (promptEl) {
      promptEl.value = button.dataset.workerStarter || '';
      promptEl.focus();
    }
  });
  document.getElementById('workers-runs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-worker-run-id]');
    if (!button) return;
    openWorkerReceipt(button.dataset.workerRunId).catch((err) => renderWorkerReceiptError(err));
  });
  document.getElementById('workers-receipt')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-worker-promote-memory]');
    if (!button) return;
    promoteWorkerMemory(button.dataset.workerPromoteMemory).catch((err) => renderWorkerReceiptError(err));
  });
}

async function loadWorkersSurface() {
  const [workersData, templatesData, runsData] = await Promise.all([
    workerApi(''),
    workerApi('/templates'),
    workerApi('/runs'),
  ]);
  workersState = {
    ...workersState,
    workers: workersData.workers || [],
    templates: templatesData.templates || [],
    runs: runsData.runs || [],
    lastLoadedAt: new Date(),
  };
  renderWorkersSurface();
}

function renderWorkersError(err) {
  const roster = document.getElementById('workers-roster');
  const runs = document.getElementById('workers-runs');
  if (roster) roster.innerHTML = `<div class="h23-workers-empty">Worker connector unavailable: ${escapeHtml(err.message)}</div>`;
  if (runs) runs.innerHTML = '<div class="h23-workers-empty">Recent runs are unavailable.</div>';
}

function renderWorkersSurface() {
  renderWorkerCapabilities();
  renderWorkerStats();
  renderWorkerRunSelect();
  renderWorkerIntents();
  renderWorkerRoster();
  renderWorkerRuns();
}

function renderWorkerCapabilities() {
  const container = document.getElementById('workers-capabilities');
  if (!container) return;
  if (workersState.workers.length === 0) {
    container.innerHTML = `
      <div class="h23-worker-capability-card wide">
        <div class="h23-worker-capability-kicker">Nothing installed yet</div>
        <h3>Create the first worker in the Worker Library.</h3>
        <p>Workers are reusable specialists that keep their own workspace and return receipts to the house agents.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = workersState.workers.map((worker) => {
    const profile = getWorkerCapability(worker);
    return `
      <article class="h23-worker-capability-card">
        <div class="h23-worker-capability-kicker">${escapeHtml(worker.displayName || worker.name)}</div>
        <h3>${escapeHtml(profile.headline)}</h3>
        <div class="h23-worker-capability-columns">
          <div>
            <strong>Use when</strong>
            <ul>${profile.useWhen.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
          <div>
            <strong>Can check</strong>
            <ul>${profile.can.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
        </div>
        <div class="h23-worker-guardrails">${profile.guardrails.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      </article>
    `;
  }).join('');
}

function renderWorkerStats() {
  const stats = document.getElementById('workers-stats');
  if (!stats) return;
  const passCount = workersState.runs.filter(run => run.verifierStatus === 'pass').length;
  const memoryCount = workersState.receipt?.memoryCandidates?.length || 0;
  stats.innerHTML = [
    ['Installed Specialists', workersState.workers.length],
    ['Completed Checks', workersState.runs.length],
    ['Verified Passes', passCount],
    ['Memory Handoffs', memoryCount],
  ].map(([label, value]) => `<div class="h23-worker-stat"><span>${escapeHtml(value)}</span><label>${escapeHtml(label)}</label></div>`).join('');
}

function renderWorkerRunSelect() {
  const select = document.getElementById('worker-run-select');
  if (!select) return;
  const current = select.value;
  if (workersState.workers.length === 0) {
    select.innerHTML = '<option value="">No workers available</option>';
    return;
  }
  select.innerHTML = workersState.workers.map((worker) => {
    const selected = current === worker.name ? ' selected' : '';
    return `<option value="${escapeHtml(worker.name)}"${selected}>${escapeHtml(worker.displayName || worker.name)}</option>`;
  }).join('');
}

function getSelectedWorkerForRun() {
  const select = document.getElementById('worker-run-select');
  const name = select?.value || workersState.workers[0]?.name;
  return workersState.workers.find(worker => worker.name === name) || workersState.workers[0] || null;
}

function renderWorkerIntents() {
  const container = document.getElementById('worker-intents');
  if (!container) return;
  const worker = getSelectedWorkerForRun();
  if (!worker) {
    container.innerHTML = '<div class="h23-workers-empty">Install a worker before running checks.</div>';
    return;
  }
  const profile = getWorkerCapability(worker);
  container.innerHTML = profile.starterTasks.map(task => `
    <button class="h23-worker-intent" type="button" data-worker-starter="${escapeAttr(task.detail)}">
      <strong>${escapeHtml(task.label)}</strong>
      <span>${escapeHtml(task.detail)}</span>
    </button>
  `).join('');
}

function renderWorkerRoster() {
  const container = document.getElementById('workers-roster');
  if (!container) return;
  if (workersState.workers.length === 0) {
    container.innerHTML = '<div class="h23-workers-empty">No workers have been installed yet. Open the Worker Library to add the first specialist.</div>';
    return;
  }
  container.innerHTML = workersState.workers.map((worker) => `
    <div class="h23-worker-row">
      <div>
        <div class="h23-worker-name">${escapeHtml(worker.displayName || worker.name)}</div>
        <div class="h23-worker-meta">${escapeHtml(worker.name)} · ${escapeHtml(worker.ownerAgent || 'house')} · ${escapeHtml(worker.class || 'worker')}</div>
        <div class="h23-worker-purpose">${escapeHtml(worker.purpose || '')}</div>
        <div class="h23-worker-human">${escapeHtml(getWorkerCapability(worker).headline)}</div>
      </div>
      <span class="h23-worker-pill">${escapeHtml(worker.class || 'worker')}</span>
    </div>
  `).join('');
}

function formatWorkerTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function workerStatusClass(value) {
  if (value === 'fixed' || value === 'pass') return 'pass';
  if (value === 'failed' || value === 'fail') return 'fail';
  if (value === 'blocked' || value === 'cancelled' || value === 'stale') return 'blocked';
  return 'neutral';
}

function renderWorkerRuns() {
  const container = document.getElementById('workers-runs');
  if (!container) return;
  const runs = workersState.runs.slice(0, 20);
  if (runs.length === 0) {
    container.innerHTML = '<div class="h23-workers-empty">No worker runs yet.</div>';
    return;
  }
  container.innerHTML = runs.map((run) => `
    <button class="h23-worker-run-row" type="button" data-worker-run-id="${escapeHtml(run.runId)}">
      <span class="h23-worker-run-main">
        <strong>${escapeHtml(run.worker)}</strong>
        <span>${escapeHtml(run.summary || run.runId)}</span>
        <small>owner ${escapeHtml(run.ownerAgent || 'house')}</small>
      </span>
      <span class="h23-worker-run-side">
        <span class="h23-worker-status ${workerStatusClass(run.status)}">${escapeHtml(run.status || 'running')}</span>
        <span class="h23-worker-status ${workerStatusClass(run.verifierStatus)}">${escapeHtml(run.verifierStatus || 'unknown')}</span>
        <time>${escapeHtml(formatWorkerTime(run.finishedAt || run.startedAt))}</time>
      </span>
    </button>
  `).join('');
}

async function runWorkerFromDashboard() {
  const select = document.getElementById('worker-run-select');
  const promptEl = document.getElementById('worker-run-prompt');
  const button = document.getElementById('worker-run-btn');
  const status = document.getElementById('worker-run-status');
  const worker = select?.value;
  const prompt = promptEl?.value?.trim();
  if (!worker) throw new Error('Select a specialist first.');
  if (!prompt) throw new Error('Pick a starter action or describe what you want checked.');

  if (button) button.disabled = true;
  if (status) status.textContent = 'Running...';
  try {
    const data = await workerApi(`/${encodeURIComponent(worker)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        requestedBy: 'human',
        requester: 'home23-dashboard',
        ownerAgent: primaryAgent?.name,
      }),
    });
    if (status) status.textContent = `Check complete: ${data.receipt?.status || data.runId}`;
    if (promptEl) promptEl.value = '';
    workersState.receipt = data.receipt || null;
    await loadWorkersSurface();
    if (data.runId) await openWorkerReceipt(data.runId);
  } finally {
    if (button) button.disabled = false;
  }
}

async function openWorkerReceipt(runId) {
  const receipt = await workerApi(`/runs/${encodeURIComponent(runId)}/receipt`);
  workersState.receipt = receipt;
  renderWorkerReceipt(receipt);
  renderWorkerStats();
}

function renderWorkerReceiptError(err) {
  const container = document.getElementById('workers-receipt');
  if (container) container.innerHTML = `<div class="h23-workers-empty">Receipt unavailable: ${escapeHtml(err.message)}</div>`;
}

function renderWorkerReceipt(receipt) {
  const container = document.getElementById('workers-receipt');
  if (!container) return;
  const evidence = (receipt.evidence || []).map(item => `
    <li><span class="h23-worker-status ${workerStatusClass(item.status)}">${escapeHtml(item.status || 'unknown')}</span> ${escapeHtml(item.type)} — ${escapeHtml(item.detail)}</li>
  `).join('');
  const artifacts = (receipt.artifacts || []).map(item => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const memory = (receipt.memoryCandidates || []).map(item => `<li>${escapeHtml(item.text)} <span>${escapeHtml(Math.round((item.confidence || 0) * 100))}%</span></li>`).join('');
  container.innerHTML = `
    <div class="h23-worker-receipt-head">
      <div>
        <div class="h23-worker-name">${escapeHtml(receipt.worker)} · ${escapeHtml(receipt.runId)}</div>
        <div class="h23-worker-meta">${escapeHtml(formatWorkerTime(receipt.startedAt))} → ${escapeHtml(formatWorkerTime(receipt.finishedAt))}</div>
      </div>
      <div class="h23-worker-receipt-badges">
        <span class="h23-worker-status ${workerStatusClass(receipt.status)}">${escapeHtml(receipt.status)}</span>
        <span class="h23-worker-status ${workerStatusClass(receipt.verifierStatus)}">${escapeHtml(receipt.verifierStatus)}</span>
      </div>
    </div>
    <p><strong>What happened:</strong> ${escapeHtml(receipt.summary || '')}</p>
    ${receipt.rootCause ? `<div class="h23-worker-root-cause">${escapeHtml(receipt.rootCause)}</div>` : ''}
    <div class="h23-worker-receipt-block">
      <h4>What was checked</h4>
      <ul>${evidence || '<li>No evidence recorded.</li>'}</ul>
    </div>
    <div class="h23-worker-receipt-block">
      <h4>Files produced</h4>
      <ul>${artifacts || '<li>No artifacts recorded.</li>'}</ul>
    </div>
    <div class="h23-worker-receipt-block">
      <h4>What Jerry can learn</h4>
      <ul>${memory || '<li>No memory candidates proposed.</li>'}</ul>
      <button class="h23-worker-btn secondary" type="button" data-worker-promote-memory="${escapeHtml(receipt.runId)}">Send to Memory Curator</button>
      <span class="h23-workers-status" id="worker-memory-status"></span>
    </div>
  `;
}

async function promoteWorkerMemory(runId) {
  const data = await workerApi(`/runs/${encodeURIComponent(runId)}/promote-memory`, { method: 'POST', body: JSON.stringify({}) });
  const status = document.getElementById('worker-memory-status');
  if (status) status.textContent = `${data.candidates || 0} candidate(s) ready for the memory curator.`;
}

function isGoodLifeWorkerSource(source) {
  const type = String(source?.type || '');
  return type === 'good-life-agenda' || type === 'live-problem' || type.startsWith('good-life');
}

function goodLifeWorkerRunsForScope(scope = 'home') {
  const owner = goodLifeAgentForScope(scope)?.name || primaryAgent?.name || '';
  return (workersState.runs || [])
    .filter((run) => {
      const sourceLinked = isGoodLifeWorkerSource(run.source);
      const requestedByGoodLife = String(run.requestedBy || '').startsWith('good-life');
      if (!sourceLinked && !requestedByGoodLife) return false;
      return !owner || !run.ownerAgent || run.ownerAgent === owner;
    })
    .slice(0, 8);
}

function formatWorkerRunSource(run) {
  const source = run?.source || {};
  const type = source.type === 'good-life-agenda'
    ? 'agenda'
    : source.type === 'live-problem'
      ? 'issue'
      : source.type || run?.requestedBy || 'worker';
  return [type, source.id].filter(Boolean).join(': ');
}

async function openGoodLifeWorkerReceipt(runId) {
  if (!runId) return;
  try {
    await openWorkerReceipt(runId);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `Opened worker receipt ${runId}.`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `Worker receipt unavailable: ${err.message}`);
  }
}

function renderGoodLifeWorkerReceiptDetail() {
  const receipt = workersState.receipt;
  if (!receipt || !isGoodLifeWorkerSource(receipt.source)) return '';
  const evidence = (receipt.evidence || []).slice(0, 4).map((item) => (
    `<li><span class="h23-worker-status ${workerStatusClass(item.status)}">${escapeHtml(item.status || 'unknown')}</span> ${escapeHtml(item.type || 'evidence')} - ${escapeHtml(item.detail || '')}</li>`
  )).join('');
  return `
    <div class="h23-goodlife-worker-receipt-detail">
      <div class="h23-goodlife-detail-head">
        <span class="h23-worker-status ${workerStatusClass(receipt.status)}">${escapeHtml(receipt.status || 'recorded')}</span>
        <strong>${escapeHtml(receipt.worker || 'worker')} · ${escapeHtml(receipt.runId || '')}</strong>
      </div>
      <p>${escapeHtml(receipt.summary || '')}</p>
      <ul>${evidence || '<li>No evidence recorded.</li>'}</ul>
    </div>
  `;
}

function goodLifeIssueWorkerName(problem = {}) {
  const plan = Array.isArray(problem.remediation) ? problem.remediation : [];
  const workerStep = plan.find((step) => step?.type === 'dispatch_to_worker' && step.args?.worker);
  return workerStep?.args?.worker || 'systems';
}

function goodLifeIssueLatestWorkerRun(problem = {}) {
  if (!problem?.id) return null;
  const matchesProblem = (run) => (
    run?.source?.type === 'live-problem'
    && run.source.id === problem.id
  );
  const runs = (workersState.runs || [])
    .filter(matchesProblem)
    .sort((a, b) => Date.parse(b.finishedAt || b.startedAt || b.createdAt || 0) - Date.parse(a.finishedAt || a.startedAt || a.createdAt || 0));
  return runs[0] || null;
}

function renderGoodLifeIssueWorkerReceipt(problem = {}) {
  if (!problem?.id) return '';
  const receipt = workersState.receipt;
  if (receipt?.source?.type === 'live-problem' && receipt.source.id === problem.id) {
    return renderGoodLifeWorkerReceiptDetail();
  }
  const latest = goodLifeIssueLatestWorkerRun(problem);
  if (!latest) return '';
  return `
    <section><h4>Latest Worker Receipt</h4>
      <div class="h23-goodlife-worker-receipt-detail">
        <div class="h23-goodlife-detail-head">
          <span class="h23-worker-status ${workerStatusClass(latest.status)}">${escapeHtml(latest.status || 'recorded')}</span>
          <strong>${escapeHtml(latest.worker || 'worker')} · ${escapeHtml(latest.runId || '')}</strong>
        </div>
        <p>${escapeHtml(latest.summary || 'Worker receipt recorded.')}</p>
        <div class="h23-goodlife-mini-actions">
          <span class="h23-worker-status ${workerStatusClass(latest.verifierStatus)}">${escapeHtml(latest.verifierStatus || 'unknown')}</span>
          <button type="button" onclick="openGoodLifeWorkerReceipt('${escapeAttr(latest.runId || '')}')">Open Receipt</button>
        </div>
      </div>
    </section>
  `;
}

function goodLifeIssueRecommendedStep(problem = {}) {
  const lastOk = problem.lastResult?.ok === true;
  if (problem.state === 'resolved' || lastOk) return 'Verifier is passing; no operator repair action is needed.';
  const latest = goodLifeIssueLatestWorkerRun(problem);
  const needsUser = goodLifeNeedsUser(problem);
  if (latest?.status === 'running') return `${latest.worker || goodLifeIssueWorkerName(problem)} worker is running; wait for its receipt before marking handled.`;
  if (latest?.summary) return latest.summary;
  if (needsUser) return `Run the ${goodLifeIssueWorkerName(problem)} worker, inspect the receipt, then mark handled only after the verifier passes or the manual action is done.`;
  const next = goodLifeNextRemediation(problem);
  return next.type ? `Let autonomous remediation continue with ${next.type}.` : 'Re-run the verifier, then dispatch a worker if the issue still fails.';
}

function renderGoodLifeIssueInterventionConsole(problem = {}) {
  if (!problem?.id) return '';
  const latest = goodLifeIssueLatestWorkerRun(problem);
  const workerName = goodLifeIssueWorkerName(problem);
  const needsUser = goodLifeNeedsUser(problem);
  const last = problem.lastResult || {};
  const next = goodLifeNextRemediation(problem);
  const verifierText = last.detail || 'not checked yet';
  const receiptText = latest
    ? `${latest.status || latest.verifierStatus || 'recorded'}${latest.runId ? ` - ${latest.runId}` : ''}`
    : 'no worker receipt yet';
  return `
    <section class="h23-goodlife-intervention-console">
      <h4>Operator Intervention</h4>
      <div class="h23-goodlife-intervention-grid">
        <div>
          <label>Recommended next step</label>
          <p>${escapeHtml(goodLifeIssueRecommendedStep(problem))}</p>
        </div>
        <div>
          <label>Verifier gate</label>
          <p>${escapeHtml(verifierText)}</p>
        </div>
        <div>
          <label>Worker lane</label>
          <p>${escapeHtml(workerName)}${latest?.worker ? ` - latest ${escapeHtml(latest.worker)}` : ''}</p>
        </div>
        <div>
          <label>Current receipt</label>
          <p>${escapeHtml(receiptText)}</p>
        </div>
      </div>
      <div class="h23-goodlife-intervention-actions">
        <button class="h23-goodlife-plain-btn" type="button" onclick="testGoodLifeVerifier('${escapeAttr(problem.id)}')">Check Verifier</button>
        <button class="h23-goodlife-plain-btn" type="button" onclick="runGoodLifeWorkerCheck('${escapeAttr(problem.id)}')">Ask ${escapeHtml(workerName)} Worker</button>
        ${latest?.runId ? `<button class="h23-goodlife-plain-btn" type="button" onclick="openGoodLifeWorkerReceipt('${escapeAttr(latest.runId)}')">Open Receipt</button>` : ''}
        <button class="h23-goodlife-plain-btn" type="button" onclick="openGoodLifeWorkers()">Worker Desk</button>
        <button class="h23-goodlife-plain-btn" type="button" onclick="reverifyGoodLifeOperator()">Run Engine Check</button>
        ${needsUser ? `<button class="h23-goodlife-plain-btn" type="button" onclick="recordGoodLifeUserIntervention('${escapeAttr(problem.id)}')">Record Handled</button>` : ''}
      </div>
      <div class="h23-goodlife-intervention-note">
        <strong>${escapeHtml(next.type || 'manual')}</strong>
        <span>${escapeHtml(next.text || 'verifier remains the gate')}</span>
      </div>
    </section>
  `;
}

function formatGoodLifeWorkerResult(receipt, fallback) {
  if (!receipt) return fallback || 'receipt recorded';
  const status = receipt.status || receipt.verifierStatus || 'recorded';
  const summary = receipt.summary ? ` - ${receipt.summary}` : '';
  const runId = receipt.runId ? ` (${receipt.runId})` : '';
  return `${status}${runId}${summary}`;
}

// ── Good Life tile (secondary agent panels) ──

function goodLifeDomId(base, scope = 'home') {
  return scope === 'home' ? base : `${base}-${scope}`;
}

function renderGoodLifeTile(scope = 'home', title = 'Good Life') {
  const id = (base) => goodLifeDomId(base, scope);
  const fleetHtml = scope === 'home'
    ? '<div class="h23-goodlife-fleet" id="goodlife-fleet-summary"></div>'
    : '';
  return `
    <div class="h23-tile h23-tile-goodlife">
      <div class="h23-tile-header">
        <span><span class="icon">⊙</span> ${escapeHtml(title)}</span>
        <button class="h23-goodlife-detail-btn" type="button" onclick="openGoodLifeOperator('${escapeAttr(scope)}')">Details</button>
      </div>
      <div class="h23-goodlife-head">
        <div>
          <div class="h23-goodlife-policy" id="${id('goodlife-policy')}">Loading...</div>
          <div class="h23-goodlife-summary" id="${id('goodlife-summary')}"></div>
        </div>
        <div class="h23-goodlife-status unknown" id="${id('goodlife-status')}">UNKNOWN</div>
      </div>
      <div class="h23-goodlife-brief" id="${id('goodlife-brief')}"></div>
      ${fleetHtml}
      <div class="h23-goodlife-grid">
        <section class="h23-goodlife-section">
          <div class="h23-goodlife-section-title">Why</div>
          <div class="h23-goodlife-answer" id="${id('goodlife-answer')}"></div>
        </section>
        <section class="h23-goodlife-section">
          <div class="h23-goodlife-section-title">Live Problems</div>
          <div id="${id('goodlife-problems')}"></div>
        </section>
        <section class="h23-goodlife-section">
          <div class="h23-goodlife-section-title">Action Card</div>
          <div class="h23-goodlife-action" id="${id('goodlife-action')}"></div>
        </section>
      </div>
      <div class="h23-goodlife-lanes" id="${id('goodlife-lanes')}"></div>
      <div class="h23-goodlife-meta" id="${id('goodlife-meta')}"></div>
    </div>
  `;
}

function goodLifeCssClass(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

const GOOD_LIFE_USER_INTERVENTION_TYPES = new Set([
  'notify_jtr',
  'request_user_input',
  'manual',
  'manual_intervention',
  'user_action',
]);

function goodLifeNextRemediation(problem = {}) {
  if (problem.nextRemediation) return problem.nextRemediation;
  const plan = Array.isArray(problem.remediation) ? problem.remediation : [];
  const index = Math.max(0, Number(problem.stepIndex || 0));
  const step = plan[index] || null;
  if (!step) {
    return {
      index,
      total: plan.length,
      type: null,
      requiresUser: false,
      text: plan.length ? 'remediation plan exhausted' : 'no remediation plan recorded',
    };
  }
  const type = String(step.type || '').trim();
  return {
    index,
    total: plan.length,
    type,
    requiresUser: GOOD_LIFE_USER_INTERVENTION_TYPES.has(type),
    text: step.args?.text || step.args?.message || step.args?.name || step.args?.target || type,
    cooldownMin: step.cooldownMin ?? null,
  };
}

function goodLifeNeedsUser(problem = {}) {
  return problem.escalated === true || problem.intervention?.required === true || goodLifeNextRemediation(problem).requiresUser === true;
}

function setGoodLifeStatus(scope, operator) {
  const el = document.getElementById(goodLifeDomId('goodlife-status', scope));
  if (!el) return;
  const status = operator?.status || 'unknown';
  const label = status === 'current' && operator?.safeToInherit
    ? 'CURRENT'
    : status.toUpperCase();
  el.textContent = label;
  el.className = `h23-goodlife-status ${goodLifeCssClass(status)}`;
}

function renderGoodLifeProblems(operator, data) {
  const live = operator?.liveProblems || data?.liveProblems?.snapshot || {};
  const counts = live.counts || {};
  const openRows = Array.isArray(live.open) ? live.open : [];
  const chronicRows = Array.isArray(live.chronic) ? live.chronic : [];
  const rows = [...openRows, ...chronicRows].slice(0, 5);
  const stats = `
    <div class="h23-goodlife-problem-stats">
      <span><strong>${Number(counts.open || 0)}</strong> open</span>
      <span><strong>${Number(counts.chronic || 0)}</strong> chronic</span>
      <span><strong>${Number(counts.unverifiable || 0)}</strong> unverifiable</span>
      <span><strong>${Number(counts.interventionRequired || 0)}</strong> need you</span>
    </div>
  `;

  if (rows.length === 0) {
    return `${stats}<div class="h23-goodlife-empty">No open or chronic problems</div>`;
  }

  const scope = data?._scope || 'home';
  return `${stats}<div class="h23-goodlife-problem-list">
    ${rows.map((row) => `
      <button class="h23-goodlife-problem-row" type="button" onclick="openGoodLifeOperator('${escapeAttr(scope)}', '${escapeAttr(row.id)}')">
        <span class="h23-goodlife-problem-state ${goodLifeCssClass(row.state)}">${escapeHtml(row.state)}</span>
        <span class="h23-goodlife-problem-id">${escapeHtml(row.id)}</span>
        <span class="h23-goodlife-problem-claim">${escapeHtml(row.issue || row.claim)}</span>
        ${goodLifeNeedsUser(row) ? '<span class="h23-goodlife-needs-user">needs you</span>' : ''}
      </button>
      ${row.detail ? `<div class="h23-goodlife-problem-detail">${escapeHtml(row.detail)}</div>` : ''}
    `).join('')}
  </div>`;
}

function goodLifeHasClearRegistryProjectionMismatch(operator) {
  const counts = operator?.liveProblems?.counts || {};
  const brief = operator?.operatorBrief || {};
  const liveOpen = Number(counts.open || 0) + Number(counts.chronic || 0) + Number(counts.interventionRequired || 0);
  const headline = String(brief.headline || '');
  return liveOpen === 0
    && (operator?.status === 'conflicted' || /projection disagrees/i.test(headline))
    && /registry is clear/i.test(headline);
}

function renderGoodLifeActionCard(operator, state) {
  if (goodLifeHasClearRegistryProjectionMismatch(operator)) {
    const rows = [
      ['Intent', 'reconcile'],
      ['Outcome', 'Good Life projection catches up to the clear live registry'],
      ['Stop', 'next evaluation agrees with live-problem registry'],
      ['Checks', 'registry open 0, chronic 0, need you 0'],
    ];
    return rows.map(([label, value]) => `
      <div class="h23-goodlife-action-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join('');
  }

  const card = operator?.actionCard || state?.policy?.actionCard || null;
  if (!card) return '<div class="h23-goodlife-empty">No routed action card</div>';

  const risk = [
    card.riskTier != null ? `risk ${card.riskTier}` : null,
    card.reversible === true ? 'reversible' : null,
    card.evidenceRequired === true ? 'evidence required' : null,
  ].filter(Boolean).join(', ');
  const rows = [
    ['Intent', card.intent],
    ['Outcome', card.expectedOutcome],
    ['Stop', card.stopCondition],
    ['Checks', risk],
  ].filter(([, value]) => value);

  return rows.map(([label, value]) => `
    <div class="h23-goodlife-action-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join('');
}

function renderGoodLifeBrief(operator, scope = 'home') {
  const brief = operator?.operatorBrief || null;
  if (!brief) return '';
  const latest = brief.latestResolution;
  const target = brief.target || {};
  const latestLine = latest?.id
    ? `<div class="h23-goodlife-brief-receipt">
        <span>Last resolution</span>
        <strong>${escapeHtml(latest.id)}</strong>
        ${latest.verifier ? `<small>${escapeHtml(latest.verifier)}</small>` : ''}
      </div>`
    : '';
  const action = target?.tab
    ? `<button class="h23-goodlife-brief-action" type="button" onclick="openGoodLifeOperator('${escapeAttr(scope)}', '${escapeAttr(target.id || '')}', '${escapeAttr(target.tab || '')}')">${escapeHtml(target.label || 'Open Details')}</button>`
    : '';
  return `
    <div class="h23-goodlife-brief-panel ${goodLifeCssClass(brief.severity)}">
      <div class="h23-goodlife-brief-status">${escapeHtml(brief.status || 'Status')}</div>
      <div class="h23-goodlife-brief-main">
        <strong>${escapeHtml(brief.headline || '')}</strong>
        <span>${escapeHtml(brief.why || '')}</span>
      </div>
      <div class="h23-goodlife-brief-next">
        <label>Next</label>
        <span>${escapeHtml(brief.next || '')}</span>
      </div>
      ${latestLine}
      ${action}
    </div>
  `;
}

function renderGoodLifeDigestList(operator) {
  const digest = operator?.operatorDigest || null;
  if (!digest) return '';
  const rows = [
    ['Issue', digest.issue],
    ['Now', digest.currentWork],
    ['Fixed', digest.latestFix],
    ['You', digest.userAction],
  ].filter(([, value]) => value);
  return `<div class="h23-goodlife-digest-list">
    ${rows.map(([label, value]) => `
      <div class="h23-goodlife-digest-row">
        <label>${escapeHtml(label)}</label>
        <span>${escapeHtml(value)}</span>
      </div>
    `).join('')}
  </div>`;
}

function renderGoodLifeRings(operator, scope = 'home') {
  const rings = Array.isArray(operator?.operatorRings) ? operator.operatorRings : [];
  if (!rings.length) return '';
  return `<div class="h23-goodlife-rings" aria-label="Good Life three-ring status">
    ${rings.map((ring) => {
    const action = ring.action || {};
    const tab = action.tab || 'issues';
    const id = action.id || '';
    const label = action.label || 'Open';
    return `<button class="h23-goodlife-ring ${goodLifeCssClass(ring.state || ring.label || 'unknown')}" type="button" onclick="openGoodLifeOperator('${escapeAttr(scope)}', '${escapeAttr(id)}', '${escapeAttr(tab)}')">
        <span>${escapeHtml(ring.name || '')}</span>
        <strong>${escapeHtml(ring.label || ring.state || 'unknown')}</strong>
        <small>${escapeHtml(ring.detail || '')}</small>
        <em>${escapeHtml(label)}</em>
      </button>`;
  }).join('')}
  </div>`;
}

function updateGoodLifeTile(data, scope = 'home') {
  const id = (base) => goodLifeDomId(base, scope);
  const state = data?.state || null;
  if (data) {
    data._scope = scope;
    goodLifeSurfaceState.set(scope, data);
    const agent = goodLifeAgentForScope(scope);
    if (agent) {
      goodLifeFleetState.set(scope, { agent, scope, data });
      renderGoodLifeFleetSummary();
    }
  }
  if (!state) {
    setText(id('goodlife-policy'), 'No Good Life state yet');
    setText(id('goodlife-summary'), '');
    setHtml(id('goodlife-brief'), '');
    setHtml(id('goodlife-answer'), '');
    setHtml(id('goodlife-problems'), '');
    setHtml(id('goodlife-action'), '');
    setHtml(id('goodlife-lanes'), '');
    setText(id('goodlife-meta'), '');
    setGoodLifeStatus(scope, { status: 'unknown', safeToInherit: false });
    return;
  }
  const operator = data?.operator || null;
  const policy = operator?.policy?.mode || state.policy?.mode || 'observe';
  const projectionMismatch = goodLifeHasClearRegistryProjectionMismatch(operator);
  setText(id('goodlife-policy'), projectionMismatch ? 'RECONCILE' : policy.toUpperCase());
  setText(
    id('goodlife-summary'),
    projectionMismatch
      ? `projection stale - ${operator?.operatorBrief?.headline || 'live registry is clear'}`
      : operator?.summary || state.summary || state.policy?.reason || ''
  );
  setGoodLifeStatus(scope, operator || { status: 'current', safeToInherit: true });
  setHtml(id('goodlife-brief'), renderGoodLifeBrief(operator, scope));

  const answerLines = operator?.operatorAnswer?.length
    ? operator.operatorAnswer
    : [state.summary || state.policy?.reason || ''];
  const digestHtml = renderGoodLifeDigestList(operator);
  const ringHtml = renderGoodLifeRings(operator, scope);
  setHtml(id('goodlife-answer'), (ringHtml || digestHtml)
    ? `${ringHtml}${digestHtml}`
    : answerLines.filter(Boolean).slice(0, 6).map((line) => (
    `<div class="h23-goodlife-answer-line">${escapeHtml(line)}</div>`
  )).join(''));
  setHtml(id('goodlife-problems'), renderGoodLifeProblems(operator, data));
  setHtml(id('goodlife-action'), renderGoodLifeActionCard(operator, state));

  const lanes = projectionMismatch
    ? [
        {
          name: 'live registry',
          status: 'clear',
          reasons: ['0 open live problems, 0 chronic, 0 need user intervention'],
          active: true,
        },
        {
          name: 'projection',
          status: 'stale',
          reasons: [operator?.operatorBrief?.why || 'Good Life state is older than the verifier receipts'],
          active: true,
        },
      ]
    : operator?.lanes || Object.entries(state.lanes || {}).map(([name, lane]) => ({
    name,
    status: lane?.status || 'unknown',
    reasons: lane?.reasons || [],
    active: false,
  }));
  const laneHtml = lanes.map((lane) => {
    const name = lane.name;
    const status = lane?.status || 'unknown';
    const title = Array.isArray(lane.reasons) && lane.reasons.length > 0 ? lane.reasons.join(' - ') : status;
    const active = lane.active ? ' active' : '';
    return `<span class="h23-goodlife-lane ${goodLifeCssClass(status)}${active}" title="${escapeHtml(title)}">${escapeHtml(name)} - ${escapeHtml(status)}</span>`;
  }).join('');
  setHtml(id('goodlife-lanes'), laneHtml);
  const latest = operator?.latestRegulatorAction;
  const workCounts = operator?.detail?.work?.obligations?.counts || {};
  const work = operator?.work || operator?.detail?.work?.summary || {};
  const activeWork = Number(workCounts.activeAgenda || 0) + Number(workCounts.activeGoals || 0);
  const latestActive = latest?.agendaId && goodLifeAgendaStatusIsActive(latest.agendaStatus);
  const latestStatus = latestActive && latest?.agendaStatus ? ` (${latest.agendaStatus})` : '';
  const action = latestActive
    ? `active work ${activeWork}; latest routed ${latest.agendaId}${latestStatus}`
    : `active work ${activeWork}; ${work.statusText || 'no active routed work'}`;
  const evaluatedAt = operator?.freshness?.evaluatedAt || state.evaluatedAt;
  const freshness = evaluatedAt ? `evaluated ${timeSince(new Date(evaluatedAt))}` : 'freshness unknown';
  setText(id('goodlife-meta'), `${freshness} - ${action}`);
}

function goodLifeAgentForScope(scope = 'home') {
  if (scope && scope.startsWith('agent-')) {
    const name = scope.slice('agent-'.length);
    return agents.find((agent) => agent.name === name) || null;
  }
  return primaryAgent;
}

function goodLifeLabelForScope(scope = 'home') {
  const agent = goodLifeAgentForScope(scope);
  return agent?.displayName || agent?.name || currentAgentLabel('This agent');
}

function goodLifeBaseForScope(scope = 'home') {
  const agent = goodLifeAgentForScope(scope);
  return agent ? apiBase(agent) : '';
}

function goodLifeOwnerAgentForScope(scope = 'home') {
  return goodLifeAgentForScope(scope)?.name || primaryAgent?.name || undefined;
}

async function loadGoodLifeForScope(scope = 'home') {
  const base = goodLifeBaseForScope(scope);
  const data = await apiFetch(`${base}/api/good-life`, { timeoutMs: GOOD_LIFE_API_TIMEOUT_MS }).catch(() => null);
  if (data) updateGoodLifeTile(data, scope);
  return data;
}

async function loadGoodLifeFleet({ updateTiles = true } = {}) {
  const configuredAgents = Array.isArray(agents) && agents.length
    ? agents
    : [primaryAgent].filter(Boolean);
  const rows = await Promise.all(configuredAgents.filter(Boolean).map(async (agent) => {
    const scope = agent.name === primaryAgent?.name ? 'home' : `agent-${agent.name}`;
    const base = apiBase(agent);
    const data = await apiFetch(`${base}/api/good-life`, { timeoutMs: GOOD_LIFE_API_TIMEOUT_MS }).catch(() => null);
    const row = { agent, scope, data };
    goodLifeFleetState.set(scope, row);
    if (data && updateTiles) updateGoodLifeTile(data, scope);
    return row;
  }));
  renderGoodLifeFleetSummary();
  return rows;
}

function goodLifeFleetAgentName(row = {}) {
  return row.agent?.displayName || row.agent?.name || goodLifeLabelForScope(row.scope || 'home');
}

function goodLifeFleetRank(row = {}) {
  const operator = row.data?.operator || {};
  const brief = operator.operatorBrief || {};
  const work = operator.work || operator.detail?.work?.summary || {};
  const counts = operator.liveProblems?.counts || {};
  if (!row.data) return 10;
  if (brief.needsUser || Number(counts.interventionRequired || 0) > 0 || work.status === 'needs-user') return 0;
  if (['critical', 'needs-user'].includes(brief.severity)) return 1;
  if (brief.severity === 'repairing' || Number(counts.open || 0) + Number(counts.chronic || 0) > 0) return 2;
  if (brief.severity === 'attention' || operator.status === 'conflicted' || operator.status === 'stale') return 3;
  if (work.status === 'review' || Number(work.agendaNeedingReview || 0) + Number(work.goalsNeedingReview || 0) > 0) return 4;
  if (brief.status === 'Resting') return 5;
  if (brief.severity === 'working' || work.status === 'working' || Number(work.activeTotal || 0) > 0) return 5;
  return 6;
}

function goodLifeFleetStatus(row = {}) {
  const operator = row.data?.operator || {};
  const brief = operator.operatorBrief || {};
  const work = operator.work || operator.detail?.work?.summary || {};
  const counts = operator.liveProblems?.counts || {};
  if (!row.data) {
    return { state: 'unknown', label: 'Unknown', text: 'Good Life API unavailable' };
  }
  if (brief.needsUser || Number(counts.interventionRequired || 0) > 0 || work.status === 'needs-user') {
    return { state: 'needs-user', label: 'Needs jtr', text: brief.next || work.statusText || 'manual decision required' };
  }
  if (brief.severity === 'repairing' || Number(counts.open || 0) + Number(counts.chronic || 0) > 0) {
    return { state: 'repairing', label: 'Repairing', text: brief.next || 'autonomous repair is running' };
  }
  if (brief.severity === 'attention' || operator.status === 'conflicted' || operator.status === 'stale') {
    return { state: 'attention', label: 'Attention', text: brief.next || brief.why || 'operator warning present' };
  }
  if (work.status === 'review' || Number(work.agendaNeedingReview || 0) + Number(work.goalsNeedingReview || 0) > 0) {
    return { state: 'review', label: 'Review', text: work.statusText || brief.next || 'operator review recommended' };
  }
  if (brief.status === 'Resting') {
    return { state: 'resting', label: 'Resting', text: brief.next || brief.why || 'sleep/wake lowering pressure' };
  }
  if (brief.severity === 'working' || work.status === 'working' || Number(work.activeTotal || 0) > 0) {
    return { state: 'working', label: 'Working', text: work.statusText || brief.next || 'autonomous work active' };
  }
  if (brief.status === 'Paused') {
    return { state: 'paused', label: 'Paused', text: goodLifePausedFleetText(operator) };
  }
  return { state: 'clear', label: 'Clear', text: brief.next || 'no user intervention needed' };
}

function goodLifePausedFleetText(operator = {}) {
  const brief = operator.operatorBrief || {};
  const activeLane = (operator.lanes || []).find((lane) => lane.active && String(lane.status || '').toLowerCase() !== 'healthy');
  const activeReason = Array.isArray(activeLane?.reasons) && activeLane.reasons.length
    ? activeLane.reasons[0]
    : null;
  const mode = operator.policy?.mode ? `${operator.policy.mode} requested` : null;
  const reset = operator.autonomyBudget?.resetText || '';
  const parts = [
    mode,
    activeReason,
    reset ? `budget ${reset}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' - ') : (brief.next || brief.why || 'self-maintenance paused by budget');
}

function goodLifeFleetTarget(row = {}) {
  const operator = row.data?.operator || {};
  const target = operator.operatorBrief?.target || {};
  if (target.tab) {
    return {
      tab: target.tab,
      id: target.id || '',
    };
  }
  const status = goodLifeFleetStatus(row);
  if (status.state === 'working' || status.state === 'review') {
    return { tab: 'work', id: '' };
  }
  if (status.state === 'clear') {
    return { tab: 'resolutions', id: '' };
  }
  return { tab: 'issues', id: '' };
}

function renderGoodLifeFleetSummary() {
  const el = document.getElementById('goodlife-fleet-summary');
  if (!el) return;
  const rows = [...goodLifeFleetState.values()]
    .sort((a, b) => {
      const rank = goodLifeFleetRank(a) - goodLifeFleetRank(b);
      if (rank !== 0) return rank;
      return goodLifeFleetAgentName(a).localeCompare(goodLifeFleetAgentName(b));
    });
  if (!rows.length) {
    el.innerHTML = '<div class="h23-goodlife-fleet-empty">Loading agent fleet status...</div>';
    return;
  }
  const statuses = rows.map((row) => ({ row, status: goodLifeFleetStatus(row) }));
  const needsUser = statuses.filter((item) => item.status.state === 'needs-user');
  const repairing = statuses.filter((item) => item.status.state === 'repairing');
  const review = statuses.filter((item) => item.status.state === 'review');
  const resting = statuses.filter((item) => item.status.state === 'resting');
  const working = statuses.filter((item) => item.status.state === 'working');
  const paused = statuses.filter((item) => item.status.state === 'paused');
  const unknown = statuses.filter((item) => item.status.state === 'unknown');
  const headline = needsUser.length
    ? `${needsUser.length} agent${needsUser.length === 1 ? '' : 's'} need jtr`
    : repairing.length
      ? `${repairing.length} agent${repairing.length === 1 ? '' : 's'} repairing`
      : review.length
        ? `${review.length} agent${review.length === 1 ? '' : 's'} need review`
        : resting.length
          ? `${resting.length} agent${resting.length === 1 ? '' : 's'} resting autonomously`
          : working.length
          ? `${working.length} agent${working.length === 1 ? '' : 's'} working autonomously`
          : paused.length
            ? `${paused.length} agent${paused.length === 1 ? '' : 's'} paused by budget`
            : unknown.length
              ? `${unknown.length} agent${unknown.length === 1 ? '' : 's'} status unknown`
              : 'All agents clear or monitoring';
  el.innerHTML = `
    <div class="h23-goodlife-fleet-head">
      <span>Fleet</span>
      <strong>${escapeHtml(headline)}</strong>
    </div>
    <div class="h23-goodlife-fleet-list">
      ${statuses.map(({ row, status }) => {
    const target = goodLifeFleetTarget(row);
    return `<button class="h23-goodlife-fleet-row ${goodLifeCssClass(status.state)}" type="button" onclick="openGoodLifeOperator('${escapeAttr(row.scope || 'home')}', '${escapeAttr(target.id)}', '${escapeAttr(target.tab)}')">
        <span>${escapeHtml(goodLifeFleetAgentName(row))}</span>
        <strong>${escapeHtml(status.label)}</strong>
        <small>${escapeHtml(status.text)}</small>
      </button>`;
  }).join('')}
    </div>
  `;
}

function goodLifeProblemsFor(data, states) {
  const wanted = new Set(states);
  return (data?.liveProblems?.problems || [])
    .filter((problem) => wanted.has(problem.state))
    .sort((a, b) => {
      const interventionRank = Number(goodLifeNeedsUser(b)) - Number(goodLifeNeedsUser(a));
      if (interventionRank !== 0) return interventionRank;
      const rank = { chronic: 0, open: 1, unverifiable: 2, resolved: 3 };
      const stateRank = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
      if (stateRank !== 0) return stateRank;
      return Date.parse(b.updatedAt || b.lastCheckedAt || b.resolvedAt || b.openedAt || 0)
        - Date.parse(a.updatedAt || a.lastCheckedAt || a.resolvedAt || a.openedAt || 0);
    });
}

function goodLifeCountsText(counts = {}) {
  return `${Number(counts.open || 0)} open / ${Number(counts.chronic || 0)} chronic / ${Number(counts.unverifiable || 0)} unverifiable`;
}

function goodLifeAgendaStatusIsActive(status) {
  return ['candidate', 'surfaced', 'acknowledged'].includes(String(status || '').toLowerCase());
}

function goodLifeLatestRoutedText(latest = {}, activeWork = 0) {
  if (latest?.at && goodLifeAgendaStatusIsActive(latest.agendaStatus)) {
    const status = latest.agendaStatus ? ` - ${latest.agendaStatus}` : '';
    return `latest routed ${timeSince(new Date(latest.at))}${status}`;
  }
  return activeWork > 0 ? 'active routed work needs review' : 'no active routed work';
}

function renderGoodLifeJson(value) {
  if (!value) return '<span class="h23-goodlife-empty">None</span>';
  return `<pre class="h23-goodlife-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderGoodLifeProblemList(problems) {
  if (!problems.length) return '<div class="h23-goodlife-empty h23-goodlife-pad">Nothing in this lane</div>';
  const selectedId = goodLifeOverlayState.selectedProblemId;
  return problems.map((problem) => {
    const selected = problem.id === selectedId ? ' selected' : '';
    const age = problem.state === 'resolved'
      ? (problem.resolvedAt ? `resolved ${timeSince(new Date(problem.resolvedAt))}` : 'resolved')
      : (problem.openedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(problem.openedAt)) / 60000))}m` : '');
    const last = problem.lastResult?.detail || problem.fixRecipe?.summary || '';
    return `<button class="h23-goodlife-list-row${selected}" type="button" onclick="selectGoodLifeProblem('${escapeAttr(problem.id)}')">
      <span class="h23-goodlife-problem-state ${goodLifeCssClass(problem.state)}">${escapeHtml(problem.state || 'unknown')}</span>
      <strong>${escapeHtml(problem.id || '')}</strong>
      <span>${escapeHtml(problem.claim || '')}</span>
      <small>${escapeHtml([age, last].filter(Boolean).join(' - '))}</small>
    </button>`;
  }).join('');
}

function renderGoodLifeWorkList(data) {
  const actions = data?.operator?.detail?.work?.dailyActions || [];
  const obligations = data?.operator?.detail?.work?.obligations || {};
  const agenda = obligations.activeAgenda || [];
  const goals = obligations.activeGoals || [];
  const rows = [
    ...agenda.map((item) => ({
      badge: item.status || 'agenda',
      title: item.id || 'agenda',
      text: item.content || '',
      age: [
        item.ageMin != null ? `${item.ageMin}m` : '',
        effectiveGoodLifeAgendaWorkerRoute(item)?.worker ? `worker ${effectiveGoodLifeAgendaWorkerRoute(item).worker}` : '',
      ].filter(Boolean).join(' - '),
    })),
    ...goals.map((goal) => ({
      badge: goal.review?.recommended ? 'review' : (goal.status || 'goal'),
      title: goal.id || 'goal',
      text: goal.description || '',
      age: [
        goal.ageMin != null ? `${goal.ageMin}m` : '',
        goal.review?.recommended ? 'review' : '',
        goal.artifactStatus || '',
      ].filter(Boolean).join(' - '),
    })),
  ];
  if (!rows.length && !actions.length) return '<div class="h23-goodlife-empty h23-goodlife-pad">No routed work or active obligations</div>';
  const obligationHtml = rows.map((row) => `<div class="h23-goodlife-list-row static">
    <span class="h23-goodlife-problem-state ${goodLifeCssClass(row.badge)}">${escapeHtml(row.badge)}</span>
    <strong>${escapeHtml(row.title)}</strong>
    <span>${escapeHtml(row.text)}</span>
    <small>${escapeHtml(row.age)}</small>
  </div>`).join('');
  const actionHtml = actions.slice(0, 6).map((action) => `<div class="h23-goodlife-list-row static">
    <span class="h23-goodlife-problem-state ${goodLifeCssClass(action.mode)}">${escapeHtml(action.mode || 'work')}</span>
    <strong>${escapeHtml(action.agendaId || 'agenda')}</strong>
    <span>${escapeHtml(action.category || action.summary || '')}</span>
    <small>${action.at ? escapeHtml(timeSince(new Date(action.at))) : ''}</small>
  </div>`).join('');
  return obligationHtml + actionHtml;
}

function renderGoodLifeInsightsList(data) {
  const lanes = data?.operator?.lanes || [];
  return lanes.map((lane) => `<div class="h23-goodlife-list-row static">
    <span class="h23-goodlife-problem-state ${goodLifeCssClass(lane.status)}">${escapeHtml(lane.status)}</span>
    <strong>${escapeHtml(lane.name)}</strong>
    <span>${escapeHtml((lane.reasons || []).join(' - ') || lane.title || '')}</span>
    <small>${lane.active ? 'active' : ''}</small>
  </div>`).join('') || '<div class="h23-goodlife-empty h23-goodlife-pad">No lane evidence</div>';
}

function renderGoodLifeTop(data) {
  const operator = data?.operator || {};
  const counts = operator.liveProblems?.counts || {};
  const freshness = operator.freshness || {};
  const latest = operator.latestRegulatorAction || {};
  const workCounts = operator.detail?.work?.obligations?.counts || {};
  const work = operator.work || operator.detail?.work?.summary || {};
  const activeWork = Number(workCounts.activeAgenda || 0) + Number(workCounts.activeGoals || 0);
  const warnings = operator.consistency?.warnings || [];
  const digest = operator.operatorDigest || null;
  const handoff = operator.operatorHandoff || null;
  const answerLines = (operator.operatorAnswer || [])
    .filter(Boolean)
    .slice(0, 5);
  return `
    ${renderGoodLifeBrief(operator, data?._scope || goodLifeOverlayState.scope || 'home')}
    ${renderGoodLifeRings(operator, data?._scope || goodLifeOverlayState.scope || 'home')}
    ${handoff ? `<div class="h23-goodlife-handoff-panel ${goodLifeCssClass(handoff.needsUser ? 'needs-user' : operator.operatorBrief?.severity || operator.status)}">
      <div>
        <label>Situation</label>
        <p>${escapeHtml(handoff.situation || '')}</p>
      </div>
      <div>
        <label>Repair</label>
        <p>${escapeHtml(handoff.repair || '')}</p>
      </div>
      <div>
        <label>User Action</label>
        <p>${escapeHtml(handoff.userAction || '')}</p>
      </div>
      <div>
        <label>Evidence</label>
        ${(handoff.evidence || []).slice(0, 5).map((item) => `<p><strong>${escapeHtml(item.label || '')}:</strong> ${escapeHtml([item.value, item.detail].filter(Boolean).join(' - '))}</p>`).join('') || '<p>No evidence recorded</p>'}
      </div>
    </div>` : ''}
    ${digest ? `<div class="h23-goodlife-digest-grid">
      <div class="h23-goodlife-digest-card"><label>Issue</label><span>${escapeHtml(digest.issue || '')}</span></div>
      <div class="h23-goodlife-digest-card"><label>Now</label><span>${escapeHtml(digest.currentWork || '')}</span></div>
      <div class="h23-goodlife-digest-card"><label>Fixed</label><span>${escapeHtml(digest.latestFix || '')}</span></div>
      <div class="h23-goodlife-digest-card"><label>You</label><span>${escapeHtml(digest.userAction || '')}</span></div>
    </div>` : ''}
    <div class="h23-goodlife-top-grid">
      <div class="h23-goodlife-top-card">
        <label>Mode</label>
        <strong>${escapeHtml((operator.policy?.mode || 'unknown').toUpperCase())}</strong>
        <span>${escapeHtml(operator.policy?.reason || operator.summary || '')}</span>
      </div>
      <div class="h23-goodlife-top-card">
        <label>Issues</label>
        <strong>${escapeHtml(goodLifeCountsText(counts))}</strong>
        <span>${Number(counts.interventionRequired || 0) > 0 ? `${Number(counts.interventionRequired || 0)} need user intervention` : escapeHtml(warnings[0]?.message || 'projection current')}</span>
      </div>
      <div class="h23-goodlife-top-card">
        <label>Freshness</label>
        <strong>${escapeHtml(freshness.status || 'unknown')}</strong>
        <span>${freshness.evaluatedAt ? `evaluated ${escapeHtml(timeSince(new Date(freshness.evaluatedAt)))}` : 'no evaluation timestamp'}</span>
      </div>
      <div class="h23-goodlife-top-card">
        <label>Active Work</label>
        <strong>${activeWork}</strong>
        <span>${escapeHtml(latest?.at && goodLifeAgendaStatusIsActive(latest.agendaStatus)
          ? goodLifeLatestRoutedText(latest, activeWork)
          : (work.statusText || goodLifeLatestRoutedText(latest, activeWork)))}</span>
      </div>
    </div>
    ${answerLines.length ? `<div class="h23-goodlife-operator-answer-panel">
      <label>Operator Readout</label>
      ${answerLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
    </div>` : ''}
  `;
}

function renderGoodLifeTabs(data) {
  const detail = data?.operator?.detail || {};
  const counts = data?.operator?.liveProblems?.counts || {};
  const workCounts = detail.work?.obligations?.counts || {};
  const workTotal = Number(workCounts.activeAgenda || 0)
    + Number(workCounts.activeGoals || 0);
  const tabs = [
    ['issues', `Issues ${Number(counts.open || 0) + Number(counts.chronic || 0) + Number(counts.unverifiable || 0)}`],
    ['work', `Work ${workTotal}`],
    ['resolutions', `Resolutions ${detail.resolutions?.totalResolved || counts.resolved || 0}`],
    ['insights', 'Insights'],
  ];
  return tabs.map(([tab, label]) => `<button class="h23-goodlife-tab ${goodLifeOverlayState.tab === tab ? 'active' : ''}" type="button" onclick="switchGoodLifeTab('${tab}')">${escapeHtml(label)}</button>`).join('');
}

function renderGoodLifeIssueEmptyDetail(data) {
  const operator = data?.operator || {};
  const counts = operator.liveProblems?.counts || {};
  const detail = operator.detail || {};
  const workCounts = detail.work?.obligations?.counts || {};
  const activeWork = Number(workCounts.activeAgenda || 0) + Number(workCounts.activeGoals || 0);
  const resolved = Number(detail.resolutions?.totalResolved || counts.resolved || 0);
  const lanes = (operator.lanes || []).filter((lane) => lane.active || lane.status !== 'healthy').slice(0, 4);
  return `
    <div class="h23-goodlife-clear-state">
      <span class="h23-goodlife-problem-state healthy">clear</span>
      <div>
        <h3>No active Good Life issues</h3>
        <p>Live-problem registry is clear. Home23 does not need user intervention for this agent right now.</p>
      </div>
    </div>
    <div class="h23-goodlife-detail-grid">
      <div><label>Open Problems</label><p>${Number(counts.open || 0)} open / ${Number(counts.chronic || 0)} chronic</p><small>${Number(counts.unverifiable || 0)} unverifiable</small></div>
      <div><label>User Intervention</label><p>${Number(counts.interventionRequired || 0)} needed</p><small>${Number(counts.interventionRequired || 0) > 0 ? 'review the highlighted issue rows' : 'autonomous remediation is not blocked'}</small></div>
      <div><label>Recent Resolutions</label><p>${resolved}</p><small>open the Resolutions tab for evidence receipts and fix recipes</small></div>
      <div><label>Active Work</label><p>${activeWork}</p><small>open the Work tab for routed agenda and goal obligations</small></div>
    </div>
    <section><h4>Watched Lanes</h4>${lanes.length ? lanes.map((lane) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(lane.name)}</strong><span>${escapeHtml((lane.reasons || []).join(' - ') || lane.status || '')}</span><small>${escapeHtml(lane.status || '')}</small></div>`).join('') : '<div class="h23-goodlife-empty">All lanes currently report healthy or non-blocking status.</div>'}</section>
  `;
}

function renderGoodLifeIssueDetail(problem, data) {
  if (!problem) {
    return renderGoodLifeIssueEmptyDetail(data);
  }
  const last = problem.lastResult || {};
  const attempts = (problem.remediationLog || []).slice().reverse();
  const recipes = (problem.fixRecipeHistory || (problem.fixRecipe ? [problem.fixRecipe] : [])).slice().reverse();
  const next = goodLifeNextRemediation(problem);
  const needsUser = goodLifeNeedsUser(problem);
  const repairText = problemRepairText(problem);
  const userText = problemUserText(problem);
  const readiness = data?.operator?.interventionReadiness || {};
  return `
    <div class="h23-goodlife-detail-head">
      <span class="h23-goodlife-problem-state ${goodLifeCssClass(problem.state)}">${escapeHtml(problem.state)}</span>
      <strong>${escapeHtml(problem.id)}</strong>
      ${needsUser ? '<span class="h23-goodlife-needs-user">needs you</span>' : ''}
    </div>
    <h3>${escapeHtml(problem.claim || '')}</h3>
    <div class="h23-goodlife-issue-brief ${needsUser ? 'needs-user' : 'repairing'}">
      <div>
        <label>What is wrong</label>
        <p>${escapeHtml(last.detail || problem.detail || 'The verifier has not produced detail yet.')}</p>
      </div>
      <div>
        <label>What is happening</label>
        <p>${escapeHtml(repairText)}</p>
      </div>
      <div>
        <label>Needed from jtr</label>
        <p>${escapeHtml(userText)}</p>
      </div>
      <div>
        <label>Stop condition</label>
        <p>${escapeHtml(problem.state === 'resolved' ? 'verifier is passing' : 'verifier passes or remediation escalates')}</p>
      </div>
    </div>
    <div class="h23-goodlife-detail-actions">
      ${needsUser ? `<button class="h23-goodlife-plain-btn" type="button" onclick="recordGoodLifeUserIntervention('${escapeAttr(problem.id)}')">Mark Handled + Re-check</button>` : ''}
      <button class="h23-goodlife-plain-btn" type="button" onclick="testGoodLifeVerifier('${escapeAttr(problem.id)}')">Test Verifier</button>
      <button class="h23-goodlife-plain-btn" type="button" onclick="runGoodLifeWorkerCheck('${escapeAttr(problem.id)}')">Run Worker Check</button>
    </div>
    <div class="h23-goodlife-detail-grid">
      <div><label>Last verifier result</label><p>${escapeHtml(last.detail || 'not checked')}</p><small>${last.at ? escapeHtml(timeSince(new Date(last.at))) : ''}</small></div>
      <div><label>Lifecycle</label><p>${escapeHtml(problem.escalated ? 'escalated' : 'normal')} - step ${Number(problem.stepIndex || 0)} / ${(problem.remediation || []).length}</p><small>${problem.openedAt ? `opened ${escapeHtml(timeSince(new Date(problem.openedAt)))}` : ''}</small></div>
      <div><label>Next remediation</label><p>${escapeHtml(next.type || 'none')}</p><small>${escapeHtml(next.text || '')}</small></div>
      <div><label>User intervention</label><p>${needsUser ? 'needed' : 'not needed yet'}</p><small>${needsUser ? 'Home23 has reached a notify/manual step' : 'autonomous remediation can continue'}</small></div>
      <div><label>Decision gate</label><p>${readiness.identifiable ? 'identified enough to act' : 'verify before intervention'}</p><small>${escapeHtml(readiness.smallestRealAction || 'run verifier before changing state')}</small></div>
    </div>
    <section><h4>Known / Unknown</h4>${renderGoodLifeInterventionReadiness(readiness)}</section>
    ${renderGoodLifeIssueInterventionConsole(problem)}
    <section><h4>Verifier</h4>${renderGoodLifeJson(problem.verifier)}</section>
    <section><h4>Remediation Plan</h4>${renderGoodLifeJson(problem.remediation || [])}</section>
    <section><h4>Recent Attempts</h4>${attempts.length ? attempts.map((attempt) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(attempt.type || 'attempt')}</strong><span>${escapeHtml(attempt.outcome || '')}</span><small>${escapeHtml(attempt.detail || '')}</small></div>`).join('') : '<div class="h23-goodlife-empty">No attempts recorded</div>'}</section>
    <section><h4>Fix Recipes</h4>${recipes.length ? recipes.map((recipe) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(recipe.verifierStatus || recipe.dispatchOutcome || 'recipe')}</strong><span>${escapeHtml(recipe.summary || '')}</span><small>${recipe.at ? escapeHtml(timeSince(new Date(recipe.at))) : ''}</small></div>`).join('') : '<div class="h23-goodlife-empty">No fix recipe recorded</div>'}</section>
    ${renderGoodLifeIssueWorkerReceipt(problem)}
  `;
}

function renderGoodLifeInterventionReadiness(readiness) {
  if (!readiness?.schema) return '<div class="h23-goodlife-empty">No intervention-readiness receipt yet</div>';
  const known = (readiness.known || []).slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const unknown = (readiness.unknown || []).slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `
    <div class="h23-goodlife-evidence-row ${readiness.identifiable ? 'healthy' : 'watch'}">
      <strong>${escapeHtml(readiness.decision?.kind || 'decision')}</strong>
      <span>${escapeHtml(readiness.decision?.subject || 'good-life-loop')}</span>
      <small>${escapeHtml(readiness.viewDiscipline || '')}</small>
    </div>
    <div class="h23-goodlife-two-col">
      <div><label>Known</label><ul>${known || '<li>none recorded</li>'}</ul></div>
      <div><label>Unknown</label><ul>${unknown || '<li>none blocking</li>'}</ul></div>
    </div>
  `;
}

function compactGoodLifeProblemForWorker(problem) {
  if (!problem) return {};
  return {
    id: problem.id,
    state: problem.state,
    claim: problem.claim,
    openedAt: problem.openedAt,
    updatedAt: problem.updatedAt,
    lastCheckedAt: problem.lastCheckedAt,
    lastResult: problem.lastResult,
    verifier: problem.verifier,
    remediation: problem.remediation,
    remediationLog: (problem.remediationLog || []).slice(-5),
    fixRecipe: problem.fixRecipe,
  };
}

function buildGoodLifeWorkerPrompt(problem) {
  const scopeLabel = goodLifeLabelForScope(goodLifeOverlayState.scope);
  const payload = compactGoodLifeProblemForWorker(problem);
  return [
    `Good Life operator intervention for ${scopeLabel}.`,
    '',
    'Inspect this live problem with current evidence. Diagnose the exact failing layer, re-run or dry-run the verifier when safe, and return a receipt with pass/fail evidence and the smallest concrete next action.',
    '',
    'Guardrails: do not use global PM2 stop/delete, do not discard local changes, do not restart unrelated services, and do not claim resolution without verifier evidence.',
    '',
    'Live problem payload:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function compactGoodLifeAgendaForWorker(item) {
  if (!item) return {};
  const route = effectiveGoodLifeAgendaWorkerRoute(item);
  return {
    id: item.id,
    status: item.status,
    content: item.content,
    sourceSignal: item.sourceSignal,
    topicTags: item.topicTags,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ageMin: item.ageMin,
    temporalContext: item.temporalContext,
    workerRoute: route,
    originalWorkerRoute: item.workerRoute || null,
    review: item.review || null,
  };
}

function effectiveGoodLifeAgendaWorkerRoute(item) {
  return item?.workerRoute || item?.review?.suggestedWorker || null;
}

function buildGoodLifeAgendaWorkerPrompt(item) {
  const scopeLabel = goodLifeLabelForScope(goodLifeOverlayState.scope);
  const payload = compactGoodLifeAgendaForWorker(item);
  return [
    `Good Life routed work for ${scopeLabel}.`,
    '',
    'Inspect this Good Life agenda item with current evidence. Use the recommended or inferred worker lane as the starting point, verify the relevant files/endpoints when safe, and return a receipt with pass/fail/blocked evidence and the smallest concrete next action.',
    '',
    'Guardrails: do not use global PM2 stop/delete, do not discard local changes, do not restart unrelated services, and do not claim resolution without verifier evidence.',
    '',
    'Good Life agenda payload:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

async function chooseGoodLifeWorker() {
  if (!workersState.workers.length) {
    const data = await workerApi('');
    workersState.workers = data.workers || [];
  }
  return workersState.workers.find((worker) => worker.name === 'systems')
    || workersState.workers.find((worker) => worker.name === 'freshness')
    || workersState.workers.find((worker) => worker.name === 'memory')
    || workersState.workers[0]
    || null;
}

function renderGoodLifeWorkDetail(data) {
  const operator = data?.operator || {};
  const card = operator.actionCard || {};
  const activeCommitments = operator.detail?.insights?.activeCommitments || [];
  const obligations = operator.detail?.work?.obligations || {};
  const agenda = obligations.activeAgenda || [];
  const goals = obligations.activeGoals || [];
  const reviewAgenda = agenda.filter((item) => item.review?.recommended);
  const reviewGoals = goals.filter((goal) => goal.id && goal.review?.recommended);
  const recentWorkerRuns = goodLifeWorkerRunsForScope(goodLifeOverlayState.scope);
  const agendaMeta = (item) => [
    item.status,
    item.ageMin != null ? `${item.ageMin}m` : null,
    effectiveGoodLifeAgendaWorkerRoute(item)?.worker ? `worker: ${effectiveGoodLifeAgendaWorkerRoute(item).worker}` : null,
  ].filter(Boolean).join(' - ');
  const agendaActions = (item) => `<div class="h23-goodlife-mini-actions">
    ${effectiveGoodLifeAgendaWorkerRoute(item)?.worker ? `<button type="button" onclick="runGoodLifeAgendaWorkerCheck('${escapeAttr(item.id || '')}')">Run ${escapeHtml(effectiveGoodLifeAgendaWorkerRoute(item).worker)}</button>` : ''}
    <button type="button" onclick="updateGoodLifeAgendaStatus('${escapeAttr(item.id || '')}', 'acknowledged')">Acknowledge</button>
    <button type="button" onclick="updateGoodLifeAgendaStatus('${escapeAttr(item.id || '')}', 'stale')">Dismiss</button>
  </div>`;
  const goalActions = (goal) => goal?.id ? `<div class="h23-goodlife-mini-actions">
    <button type="button" onclick="archiveGoodLifeGoal('${escapeAttr(goal.id || '')}')">Archive Goal</button>
  </div>` : '';
  const goalArtifact = (goal) => goal?.artifact?.relativePath
    ? `<p><strong>Artifact:</strong> ${escapeHtml(goal.artifact.exists ? 'ready' : 'pending')} - ${escapeHtml(goal.artifact.relativePath)}${goal.artifact.exists && goal.artifact.path ? ` <code>${escapeHtml(goal.artifact.path)}</code>` : ''}</p>`
    : '';
  const primaryAgenda = agenda[0] || null;
  const primaryManifest = primaryAgenda?.manifest || topGoal?.manifest || null;
  return `
    <h3>Current Work</h3>
    ${primaryAgenda ? `<div class="h23-goodlife-primary-action">
      <div>
        <label>Next Action</label>
        <strong>${escapeHtml(primaryAgenda.id || 'agenda')}</strong>
        <p>${escapeHtml(primaryAgenda.content || '')}</p>
        <small>${escapeHtml(agendaMeta(primaryAgenda))}</small>
      </div>
      ${agendaActions(primaryAgenda)}
    </div>` : ''}
    ${renderGoodLifeWorkManifest(primaryManifest)}
    <div class="h23-goodlife-detail-grid">
      <div><label>Intent</label><p>${escapeHtml(card.intent || operator.policy?.mode || 'unknown')}</p></div>
      <div><label>Stop Condition</label><p>${escapeHtml(card.stopCondition || 'not recorded')}</p></div>
      <div><label>Expected Outcome</label><p>${escapeHtml(card.expectedOutcome || 'not recorded')}</p></div>
      <div><label>Risk</label><p>${escapeHtml([card.riskTier != null ? `risk ${card.riskTier}` : null, card.reversible ? 'reversible' : null, card.evidenceRequired ? 'evidence required' : null].filter(Boolean).join(', ') || 'not recorded')}</p></div>
    </div>
    <section><h4>Active Agenda</h4>${reviewAgenda.length ? `<div class="h23-goodlife-section-actions"><button type="button" onclick="dismissGoodLifeAgendaReviewRows()">Dismiss ${reviewAgenda.length} review row${reviewAgenda.length === 1 ? '' : 's'}</button></div>` : ''}${agenda.length ? agenda.map((item) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(item.id || 'agenda')}</strong><span>${escapeHtml(item.content || '')}</span><small>${escapeHtml(agendaMeta(item))}</small>${item.review?.recommended ? `<p><strong>Review:</strong> ${escapeHtml(item.review.reason || 'operator review recommended')}${item.review.next ? ` - ${escapeHtml(item.review.next)}` : ''}</p>` : ''}${agendaActions(item)}</div>`).join('') : '<div class="h23-goodlife-empty">No active agenda rows</div>'}</section>
    <section><h4>Recent Worker Receipts</h4>${recentWorkerRuns.length ? recentWorkerRuns.map((run) => `<div class="h23-goodlife-evidence-row h23-goodlife-worker-run-row"><strong>${escapeHtml(run.worker || 'worker')}</strong><span>${escapeHtml(run.summary || run.runId || '')}</span><small>${escapeHtml([formatWorkerRunSource(run), formatWorkerTime(run.finishedAt || run.startedAt)].filter(Boolean).join(' - '))}</small><div class="h23-goodlife-mini-actions"><span class="h23-worker-status ${workerStatusClass(run.status)}">${escapeHtml(run.status || 'running')}</span><span class="h23-worker-status ${workerStatusClass(run.verifierStatus)}">${escapeHtml(run.verifierStatus || 'unknown')}</span><button type="button" onclick="openGoodLifeWorkerReceipt('${escapeAttr(run.runId || '')}')">Open Receipt</button></div></div>`).join('') : '<div class="h23-goodlife-empty">No Good Life worker receipts yet</div>'}${renderGoodLifeWorkerReceiptDetail()}</section>
    <section><h4>Active Goals</h4>${reviewGoals.length ? `<div class="h23-goodlife-section-actions"><button type="button" onclick="archiveGoodLifeGoalReviewRows()">Archive ${reviewGoals.length} review goal${reviewGoals.length === 1 ? '' : 's'}</button></div>` : ''}${goals.length ? goals.map((goal) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(goal.id || 'goal')}</strong><span>${escapeHtml(goal.description || '')}</span><small>${escapeHtml([goal.status, goal.source, goal.ageMin != null ? `${goal.ageMin}m` : null, goal.review?.recommended ? `review: ${goal.review.reason}` : null].filter(Boolean).join(' - '))}</small>${goalArtifact(goal)}${goal.review?.recommended ? `<p>${escapeHtml(goal.review.next || '')}</p>` : ''}${goalActions(goal)}</div>`).join('') : '<div class="h23-goodlife-empty">No active goals</div>'}</section>
    <section><h4>Active Commitments</h4>${activeCommitments.length ? activeCommitments.map((item) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(item.title || item.id)}</strong><span>${escapeHtml((item.reasons || []).join(' - ') || item.status || '')}</span><small>${escapeHtml(item.lane || '')}</small></div>`).join('') : '<div class="h23-goodlife-empty">No active commitments</div>'}</section>
  `;
}

function renderGoodLifeWorkManifest(manifest) {
  if (!manifest) return '';
  const artifact = manifest.artifact?.relativePath
    ? `${manifest.artifact.relativePath} - ${manifest.artifact.exists ? 'ready' : 'pending'}`
    : 'none required';
  return `
    <section><h4>Work Manifest</h4>
      <div class="h23-goodlife-detail-grid">
        <div><label>Allowed Transition</label><p>${escapeHtml(manifest.allowedTransition || 'not recorded')}</p></div>
        <div><label>Stop Line</label><p>${escapeHtml(manifest.stopLine || 'not recorded')}</p></div>
        <div><label>Source Surface</label><p>${escapeHtml(manifest.sourceSurface || 'not recorded')}</p></div>
        <div><label>Verifier</label><p>${escapeHtml(manifest.verifier || 'not recorded')}</p></div>
        <div><label>Receipt</label><p>${escapeHtml(manifest.receipt || 'not recorded')}</p></div>
        <div><label>Artifact</label><p>${escapeHtml(artifact)}</p><small>${escapeHtml(manifest.artifact?.path || '')}</small></div>
        <div><label>Forbidden Adjacent Work</label><p>${escapeHtml((manifest.forbiddenAdjacentMoves || []).join('; ') || 'not recorded')}</p></div>
        <div><label>Authority</label><p>${escapeHtml(manifest.authority || 'not recorded')}</p></div>
      </div>
    </section>
  `;
}

function renderGoodLifeResolutionDetail(problem) {
  if (!problem) return '<div class="h23-goodlife-empty h23-goodlife-pad">Select a resolution to inspect what closed.</div>';
  const evidence = problem.evidence || null;
  const attempts = (problem.remediationLog || []).slice().reverse();
  const recipes = (problem.fixRecipeHistory || (problem.fixRecipe ? [problem.fixRecipe] : [])).slice().reverse();
  return `
    <div class="h23-goodlife-detail-head">
      <span class="h23-goodlife-problem-state resolved">resolved</span>
      <strong>${escapeHtml(problem.id)}</strong>
    </div>
    <h3>${escapeHtml(problem.claim || '')}</h3>
    <div class="h23-goodlife-detail-grid">
      <div><label>Resolved</label><p>${problem.resolvedAt ? escapeHtml(timeSince(new Date(problem.resolvedAt))) : 'unknown'}</p></div>
      <div><label>Verifier</label><p>${escapeHtml(problem.lastResult?.detail || problem.fixRecipe?.verifierStatus || 'not recorded')}</p></div>
    </div>
    <section><h4>Evidence Receipt</h4>${evidence ? `
      <div class="h23-goodlife-evidence-receipt">
        <strong>${escapeHtml(evidence.receiptId || 'receipt')}</strong>
        <span>${escapeHtml([evidence.result, evidence.claimLevel].filter(Boolean).join(' - ') || 'recorded')}</span>
        ${evidence.receiptPath ? `<code>${escapeHtml(evidence.receiptPath)}</code>` : ''}
      </div>
    ` : '<div class="h23-goodlife-empty">No evidence receipt linked</div>'}</section>
    <section><h4>Remediation Plan</h4>${(problem.remediation || []).length ? renderGoodLifeJson(problem.remediation) : '<div class="h23-goodlife-empty">No remediation plan recorded</div>'}</section>
    <section><h4>Recent Attempts</h4>${attempts.length ? attempts.map((attempt) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(attempt.type || 'attempt')}</strong><span>${escapeHtml(attempt.outcome || '')}</span><small>${escapeHtml(attempt.detail || '')}</small></div>`).join('') : '<div class="h23-goodlife-empty">No attempts recorded</div>'}</section>
    <section><h4>Fix Recipes</h4>${recipes.length ? recipes.map((recipe) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(recipe.verifierStatus || recipe.dispatchOutcome || 'recipe')}</strong><span>${escapeHtml(recipe.summary || '')}</span><small>${recipe.at ? escapeHtml(timeSince(new Date(recipe.at))) : ''}</small></div>`).join('') : '<div class="h23-goodlife-empty">No fix recipe recorded; closure is based on verifier/evidence state.</div>'}</section>
  `;
}

function formatGoodLifeGb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return null;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function compactGoodLifeHostDetail(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function goodLifeHostPressureStatus(kind, host) {
  if (kind === 'cpu') {
    const loadRatio = Number(host?.cpu?.loadRatio);
    if (Number.isFinite(loadRatio) && loadRatio >= 1) return { className: 'watch', label: 'drives rest' };
    return { className: 'info', label: 'below rest threshold' };
  }
  if (kind === 'memory') {
    return { className: 'info', label: 'informational; swap drives pressure' };
  }
  if (kind === 'swap') {
    const usedPct = Number(host?.swap?.usedPct);
    if (Number.isFinite(usedPct) && usedPct >= 95) return { className: 'critical', label: 'drives repair' };
    if (Number.isFinite(usedPct) && usedPct >= 85) return { className: 'watch', label: 'drives rest' };
    return { className: 'info', label: 'below rest threshold' };
  }
  if (kind === 'disk') {
    const usagePct = Number(host?.disk?.usagePct);
    if (Number.isFinite(usagePct) && usagePct >= 95) return { className: 'critical', label: 'drives repair' };
    return { className: 'info', label: 'below repair threshold' };
  }
  if (kind === 'process') {
    const topCpuPct = Number(host?.process?.topCpuPct);
    if (Number.isFinite(topCpuPct) && topCpuPct >= 90) return { className: 'watch', label: 'spike; load/swap decide policy' };
    return { className: 'info', label: 'informational' };
  }
  return { className: 'info', label: 'observed' };
}

function renderGoodLifeHostPressure(host) {
  if (!host) return '';
  const rows = [
    host.cpu ? {
      label: 'CPU Load',
      value: host.cpu.loadRatio != null ? `${Math.round(Number(host.cpu.loadRatio) * 100)}% of cores` : null,
      detail: [
        host.cpu.load1 != null ? `load ${Number(host.cpu.load1).toFixed(2)}` : null,
        host.cpu.cpuCount != null ? `${host.cpu.cpuCount} cores` : null,
      ].filter(Boolean).join(' - '),
      status: goodLifeHostPressureStatus('cpu', host),
    } : null,
    host.memory ? {
      label: 'Memory',
      value: host.memory.freePct != null ? `${Number(host.memory.freePct).toFixed(1)}% raw free` : null,
      detail: [
        formatGoodLifeGb(host.memory.freeBytes),
        host.memory.totalBytes != null ? `of ${formatGoodLifeGb(host.memory.totalBytes)}` : null,
      ].filter(Boolean).join(' '),
      status: goodLifeHostPressureStatus('memory', host),
    } : null,
    host.swap ? {
      label: 'Swap',
      value: host.swap.usedPct != null ? `${Math.round(Number(host.swap.usedPct))}% used` : null,
      detail: [
        host.swap.usedMb != null ? `${Math.round(Number(host.swap.usedMb))} MB used` : null,
        host.swap.totalMb != null ? `of ${Math.round(Number(host.swap.totalMb))} MB` : null,
      ].filter(Boolean).join(' '),
      status: goodLifeHostPressureStatus('swap', host),
    } : null,
    host.disk ? {
      label: 'Disk',
      value: host.disk.usagePct != null ? `${Math.round(Number(host.disk.usagePct))}% used` : null,
      detail: host.disk.mount || '',
      status: goodLifeHostPressureStatus('disk', host),
    } : null,
    host.process ? {
      label: 'Top Process',
      value: host.process.topCpuPct != null ? `${Math.round(Number(host.process.topCpuPct))}% CPU` : null,
      detail: compactGoodLifeHostDetail(host.process.topProcess?.pm2Name || host.process.topProcess?.command || ''),
      status: goodLifeHostPressureStatus('process', host),
    } : null,
  ].filter((row) => row && (row.value || row.detail));

  if (!rows.length) return '';
  return `
    <section><h4>Host Pressure</h4>
      ${rows.map((row) => `<div class="h23-goodlife-evidence-row ${escapeHtml(row.status?.className || 'info')}">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${escapeHtml(row.value || 'observed')}</span>
        <small>${escapeHtml(row.detail || '')}</small>
        <em>${escapeHtml(row.status?.label || 'observed')}</em>
      </div>`).join('')}
    </section>
  `;
}

function renderGoodLifePm2Changes(pm2) {
  if (!pm2) return '';
  const processRows = Array.isArray(pm2.processes) ? pm2.processes : [];
  const offlineRows = Array.isArray(pm2.offlineProcesses) ? pm2.offlineProcesses : [];
  if (processRows.length === 0 && offlineRows.length === 0 && pm2.currentTotal == null) return '';
  const invalid = Number(pm2.invalidRestartCounters || 0);
  const offline = Number(pm2.offline || 0);
  const currentTotal = Number.isFinite(Number(pm2.currentTotal)) ? Number(pm2.currentTotal) : null;
  const currentText = offline > 0
    ? `${offline} currently not online`
    : (currentTotal == null ? 'current PM2 status unavailable' : `${currentTotal} current Home23 processes online`);
  return `
    <section><h4>Runtime Changes</h4>
      <div class="h23-goodlife-evidence-row ${offline || invalid ? 'watch' : 'info'}">
        <strong>PM2 changes</strong>
        <span>${escapeHtml(`${Number(pm2.recentHome23Changes || 0)} Home23 process change${Number(pm2.recentHome23Changes || 0) === 1 ? '' : 's'}`)}</span>
        <small>${escapeHtml([currentText, invalid ? `${invalid} unknown restart counter${invalid === 1 ? '' : 's'}` : null].filter(Boolean).join(' - '))}</small>
        <em>${escapeHtml(offline ? 'repair signal' : (invalid ? 'verify counter' : 'observed'))}</em>
      </div>
      ${offlineRows.slice(0, 4).map((row) => `<div class="h23-goodlife-evidence-row critical">
        <strong>${escapeHtml(row.name || 'pm2 process')}</strong>
        <span>${escapeHtml(row.status || 'not online')}</span>
        <small>${escapeHtml(row.role || 'Home23 process')}</small>
        <em>current</em>
      </div>`).join('')}
      ${processRows.slice(0, 6).map((row) => `<div class="h23-goodlife-evidence-row">
        <strong>${escapeHtml(row.name || 'pm2 process')}</strong>
        <span>${escapeHtml(`${Number(row.changes || 0)} change${Number(row.changes || 0) === 1 ? '' : 's'}`)}</span>
        <small>${escapeHtml([
    row.lastChangeStatus ? `last change ${row.lastChangeStatus}` : null,
    row.role || null,
    row.lastRestartCount == null ? (row.rawRestartCount ? 'restart counter unknown' : null) : `restart ${row.lastRestartCount}`,
  ].filter(Boolean).join(' - '))}</small>
        <em>${escapeHtml(row.lastAt ? timeSince(new Date(row.lastAt)) : 'observed')}</em>
      </div>`).join('')}
    </section>
  `;
}

function renderGoodLifeScheduler(scheduler) {
  if (!scheduler) return '';
  const failing = Number(scheduler.failingJobs || 0);
  const enabled = Number(scheduler.enabledJobs || 0);
  const total = Number(scheduler.totalJobs || 0);
  const rowClass = failing > 0 ? 'watch' : '';
  return `
    <section><h4>Scheduler Sovereignty</h4>
      <div class="h23-goodlife-evidence-row ${rowClass}">
        <strong>${escapeHtml(failing > 0 ? `${failing} failing` : 'clear')}</strong>
        <span>${escapeHtml(`${enabled}/${total} enabled jobs; max error streak ${Number(scheduler.maxConsecutiveErrors || 0)}`)}</span>
        <small>${escapeHtml(scheduler.path || '')}</small>
        <em>${escapeHtml(failing > 0 ? 'repair signal' : 'observed')}</em>
      </div>
      ${(scheduler.worstJobs || []).slice(0, 5).map((job) => `<div class="h23-goodlife-evidence-row watch">
        <strong>${escapeHtml(job.name || job.id || 'scheduler job')}</strong>
        <span>${escapeHtml(`${Number(job.consecutiveErrors || 0)} consecutive error${Number(job.consecutiveErrors || 0) === 1 ? '' : 's'}`)}</span>
        <small>${escapeHtml([job.lastStatus || null, job.lastRunAt ? `last ${timeSince(new Date(job.lastRunAt))}` : null].filter(Boolean).join(' - '))}</small>
        <em>cron</em>
      </div>`).join('')}
    </section>
  `;
}

function renderGoodLifeInsightsDetail(data) {
  const detail = data?.operator?.detail || {};
  const metrics = detail.insights?.trendMetrics || {};
  const ledger = detail.insights?.ledgerTail || [];
  const restraintReceipts = detail.insights?.restraintReceipts || [];
  const provenance = data?.operator?.provenance || null;
  const correctionTombstones = provenance?.correctionTombstones || detail.insights?.correctionTombstones || [];
  const doctrineAdoption = provenance?.doctrineAdoption || detail.insights?.doctrineAdoption || null;
  const budget = detail.insights?.autonomyBudget || data?.operator?.autonomyBudget || null;
  const host = detail.insights?.host || data?.state?.evidence?.host || null;
  const pm2 = detail.insights?.pm2 || data?.state?.evidence?.pm2 || null;
  const scheduler = detail.insights?.scheduler || data?.state?.evidence?.scheduler || null;
  const provenanceHtml = provenance ? `
    <section><h4>Projection Provenance</h4>
      <div class="h23-goodlife-evidence-row">
        <strong>${escapeHtml(provenance.projection?.status || 'unknown')}</strong>
        <span>${escapeHtml(provenance.projection?.authority || '')}</span>
        <small>${escapeHtml(provenance.projection?.surface || '')}</small>
        <em>projection</em>
      </div>
      ${provenance.curriculumArc ? `<div class="h23-goodlife-evidence-row">
        <strong>From The Inside arc</strong>
        <span>${escapeHtml(`${Number(provenance.curriculumArc.issuesRead || 0)} issues mapped from #${String(provenance.curriculumArc.firstIssue || '').padStart(3, '0')} to #${String(provenance.curriculumArc.lastIssue || '').padStart(3, '0')}`)}</span>
        <small>${escapeHtml(provenance.curriculumArc.source || '')}</small>
        <em>doctrine</em>
      </div>` : ''}
      ${(provenance.evidence || []).slice(0, 5).map((row) => `<div class="h23-goodlife-evidence-row">
        <strong>${escapeHtml(row.surface || row.kind || 'evidence')}</strong>
        <span>${escapeHtml(row.authority || '')}</span>
        <small>${escapeHtml(row.counts ? Object.entries(row.counts).map(([key, value]) => `${key}:${value}`).join(' - ') : (row.entriesSampled != null ? `${row.entriesSampled} sampled` : ''))}</small>
        <em>${escapeHtml(row.kind || 'evidence')}</em>
      </div>`).join('')}
      ${(provenance.conflicts || []).slice(0, 4).map((row) => `<div class="h23-goodlife-evidence-row ${row.severity === 'critical' ? 'critical' : 'watch'}">
        <strong>${escapeHtml(row.code || 'conflict')}</strong>
        <span>${escapeHtml(row.message || '')}</span>
        <small>${escapeHtml((row.fields || []).join(', '))}</small>
        <em>${escapeHtml(row.severity || 'warning')}</em>
      </div>`).join('')}
      ${correctionTombstones.length ? `<h5>Correction Tombstones</h5>${correctionTombstones.slice(0, 5).map((row) => `<div class="h23-goodlife-evidence-row watch">
        <strong>${escapeHtml(row.subject || 'correction')}</strong>
        <span>${escapeHtml(row.correctedClaim || '')}</span>
        <small>${escapeHtml([row.oldClaim, row.correctingSurface].filter(Boolean).join(' - '))}</small>
        <em>${escapeHtml(row.actionPosture || 'do_not_inherit_old_projection')}</em>
      </div>`).join('')}` : ''}
      ${doctrineAdoption ? `<h5>Doctrine Adoption</h5>
        <div class="h23-goodlife-evidence-row">
          <strong>${escapeHtml(`${Number(doctrineAdoption.counts?.reusable || 0)} reusable`)}</strong>
          <span>${escapeHtml(`${Number(doctrineAdoption.counts?.blocked || 0)} blocked until source issue and implementation receipt are both named`)}</span>
          <small>${escapeHtml(doctrineAdoption.source || '')}</small>
          <em>curriculum</em>
        </div>
        ${(doctrineAdoption.reusable || []).slice(0, 4).map((row) => `<div class="h23-goodlife-evidence-row">
          <strong>${escapeHtml(row.title || row.id || 'doctrine')}</strong>
          <span>${escapeHtml(`Issue #${String(row.sourceIssue || '').padStart(3, '0')} - receipt ${row.implementationReceipt?.commit || row.implementationReceipt?.id || row.implementationReceipt?.artifact || 'named'}`)}</span>
          <small>${escapeHtml((row.doctrineFiles || []).slice(0, 2).join(' - '))}</small>
          <em>adopted</em>
        </div>`).join('')}
        ${(doctrineAdoption.blocked || []).slice(0, 3).map((row) => `<div class="h23-goodlife-evidence-row watch">
          <strong>${escapeHtml(row.title || row.id || 'blocked doctrine')}</strong>
          <span>${escapeHtml(row.reason || 'blocked')}</span>
          <small>${escapeHtml(row.sourceIssue ? `Issue #${String(row.sourceIssue).padStart(3, '0')}` : 'source issue missing')}</small>
          <em>blocked</em>
        </div>`).join('')}` : ''}
    </section>
  ` : '';
  const budgetHtml = budget ? `
    <section><h4>Autonomy Budget</h4>
      <div class="h23-goodlife-evidence-row">
        <strong>${escapeHtml(budget.status || 'available')}</strong>
        <span>${escapeHtml(budget.reason || '')}</span>
        <small>${escapeHtml(`${Number(budget.used || 0)}/${Number(budget.limit || 0)} used${budget.remaining != null ? ` - ${Number(budget.remaining || 0)} remaining` : ''}`)}</small>
      </div>
    </section>
  ` : '';
  return `
    <h3>Learned Signals</h3>
    <div class="h23-goodlife-detail-grid">
      ${Object.entries(metrics).slice(0, 8).map(([key, value]) => `<div><label>${escapeHtml(key)}</label><p>${escapeHtml(value)}</p></div>`).join('') || '<div><label>Trend Metrics</label><p>not recorded</p></div>'}
    </div>
    ${provenanceHtml}
    ${budgetHtml}
    ${renderGoodLifeHostPressure(host)}
    ${renderGoodLifePm2Changes(pm2)}
    ${renderGoodLifeScheduler(scheduler)}
    <section><h4>Restraint Receipts</h4>${restraintReceipts.length ? restraintReceipts.slice(0, 6).map((entry) => `<div class="h23-goodlife-evidence-row watch"><strong>${escapeHtml(entry.status || 'restraint')}</strong><span>${escapeHtml(entry.reason || entry.policyReason || '')}</span><small>${escapeHtml([entry.receiptId || null, entry.policyMode ? `policy:${entry.policyMode}` : null].filter(Boolean).join(' - '))}</small><em>${escapeHtml(entry.sourceIssue ? `issue #${entry.sourceIssue}` : 'receipt')}</em></div>`).join('') : '<div class="h23-goodlife-empty">No restraint receipts</div>'}</section>
    <section><h4>Recent Good Life Ledger</h4>${ledger.length ? ledger.map((entry) => `<div class="h23-goodlife-evidence-row"><strong>${escapeHtml(entry.event || entry.type || 'entry')}</strong><span>${escapeHtml(entry.summary || entry.message || entry.mode || '')}</span><small>${entry.at || entry.timestamp ? escapeHtml(timeSince(new Date(entry.at || entry.timestamp))) : ''}</small></div>`).join('') : '<div class="h23-goodlife-empty">No ledger entries</div>'}</section>
  `;
}

function renderGoodLifeOverlay() {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const operator = data?.operator || {};
  const overlay = document.getElementById('goodlife-overlay');
  if (!overlay || !data) return;
  setText('goodlife-overlay-title', `Good Life - ${goodLifeLabelForScope(goodLifeOverlayState.scope)}`);
  const status = document.getElementById('goodlife-overlay-status');
  if (status) {
    status.textContent = operator.status === 'current' ? 'CURRENT' : String(operator.status || 'unknown').toUpperCase();
    status.className = `h23-goodlife-overlay-status ${goodLifeCssClass(operator.status)}`;
  }
  setHtml('goodlife-overlay-top', renderGoodLifeTop(data));
  setHtml('goodlife-overlay-tabs', renderGoodLifeTabs(data));

  let listHtml = '';
  let detailHtml = '';
  if (goodLifeOverlayState.tab === 'issues') {
    const problems = goodLifeProblemsFor(data, ['chronic', 'open', 'unverifiable']);
    if (!goodLifeOverlayState.selectedProblemId || !problems.some((problem) => problem.id === goodLifeOverlayState.selectedProblemId)) {
      goodLifeOverlayState.selectedProblemId = problems[0]?.id || null;
    }
    listHtml = renderGoodLifeProblemList(problems);
    detailHtml = renderGoodLifeIssueDetail(problems.find((problem) => problem.id === goodLifeOverlayState.selectedProblemId), data);
  } else if (goodLifeOverlayState.tab === 'work') {
    listHtml = renderGoodLifeWorkList(data);
    detailHtml = renderGoodLifeWorkDetail(data);
  } else if (goodLifeOverlayState.tab === 'resolutions') {
    const problems = goodLifeProblemsFor(data, ['resolved']);
    if (!goodLifeOverlayState.selectedProblemId || !problems.some((problem) => problem.id === goodLifeOverlayState.selectedProblemId)) {
      goodLifeOverlayState.selectedProblemId = problems[0]?.id || null;
    }
    listHtml = renderGoodLifeProblemList(problems);
    detailHtml = renderGoodLifeResolutionDetail(problems.find((problem) => problem.id === goodLifeOverlayState.selectedProblemId));
  } else {
    listHtml = renderGoodLifeInsightsList(data);
    detailHtml = renderGoodLifeInsightsDetail(data);
  }

  setHtml('goodlife-overlay-list', listHtml);
  setHtml('goodlife-overlay-detail', detailHtml);
}

async function openGoodLifeOperator(scope = 'home', selectedProblemId = null, requestedTab = null) {
  const nextScope = scope || 'home';
  const scopeChanged = goodLifeOverlayState.scope !== nextScope;
  goodLifeOverlayState.scope = nextScope;
  const nextTab = requestedTab || (selectedProblemId ? 'issues' : null);
  goodLifeOverlayState.tab = nextTab || (scopeChanged ? 'issues' : goodLifeOverlayState.tab || 'issues');
  goodLifeOverlayState.selectedProblemId = selectedProblemId || (scopeChanged || nextTab ? null : goodLifeOverlayState.selectedProblemId);
  setText('goodlife-overlay-action-status', '');
  const overlay = document.getElementById('goodlife-overlay');
  if (overlay) overlay.style.display = 'flex';
  if (!goodLifeSurfaceState.has(goodLifeOverlayState.scope)) {
    setHtml('goodlife-overlay-list', '<div class="h23-goodlife-empty h23-goodlife-pad">Loading...</div>');
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
  }
  if (!workersState.lastLoadedAt) {
    await loadWorkersSurface().catch(() => {});
  }
  renderGoodLifeOverlay();
}

function closeGoodLifeOperator() {
  const overlay = document.getElementById('goodlife-overlay');
  if (overlay) overlay.style.display = 'none';
}

function switchGoodLifeTab(tab) {
  goodLifeOverlayState.tab = tab;
  goodLifeOverlayState.selectedProblemId = null;
  renderGoodLifeOverlay();
}

function selectGoodLifeProblem(id) {
  goodLifeOverlayState.selectedProblemId = id;
  renderGoodLifeOverlay();
}

async function refreshGoodLifeOperator() {
  setText('goodlife-overlay-action-status', 'Refreshing...');
  await loadGoodLifeForScope(goodLifeOverlayState.scope);
  renderGoodLifeOverlay();
  setText('goodlife-overlay-action-status', 'Fresh data loaded.');
}

function openGoodLifeWorkers() {
  const workerTab = document.querySelector('.h23-tab[data-tab="workers"]');
  if (workerTab) {
    workerTab.click();
    setText('goodlife-overlay-action-status', 'Opened worker desk.');
  }
  loadWorkersSurface().catch(() => {});
}

async function reverifyGoodLifeOperator() {
  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', 'Re-verify queued...');
  try {
    const res = await fetch(`${base}/api/live-problems/tick`, { method: 'POST' });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', result.note || 'Re-verify queued for the next engine tick.');
  } catch (err) {
    setText('goodlife-overlay-action-status', `Re-verify failed: ${err.message}`);
  }
}

async function testGoodLifeVerifier(problemId) {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const problem = (data?.liveProblems?.problems || []).find((entry) => entry.id === problemId);
  if (!problem?.verifier) {
    setText('goodlife-overlay-action-status', 'No verifier to test.');
    return;
  }
  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', 'Testing verifier...');
  try {
    const res = await fetch(`${base}/api/live-problems/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verifier: problem.verifier }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    setText('goodlife-overlay-action-status', result.supported === false
      ? `Verifier needs engine context: ${result.reason}`
      : `Verifier result: ${result.result?.ok ? 'pass' : 'fail'} - ${result.result?.detail || 'no detail'}`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `Verifier test failed: ${err.message}`);
  }
}

async function recordGoodLifeUserIntervention(problemId) {
  if (!problemId) return;
  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  const note = window.prompt('What did you handle for this issue?', 'Manual intervention completed.');
  if (note === null) return;
  setText('goodlife-overlay-action-status', 'Recording user intervention...');
  try {
    const res = await fetch(`${base}/api/live-problems/${encodeURIComponent(problemId)}/user-intervention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'good-life-operator',
        note: note || 'Manual intervention completed.',
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.ok === false) throw new Error(result.error || `HTTP ${res.status}`);
    setText('goodlife-overlay-action-status', 'Intervention recorded; re-checking verifier...');
    await fetch(`${base}/api/live-problems/tick`, { method: 'POST' }).catch(() => null);
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', 'Intervention receipt recorded. Verifier remains the source of truth.');
  } catch (err) {
    setText('goodlife-overlay-action-status', `Intervention record failed: ${err.message}`);
  }
}

async function updateGoodLifeAgendaStatus(agendaId, status) {
  if (!agendaId || !status) return;
  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', `${status === 'stale' ? 'Dismissing' : 'Updating'} ${agendaId}...`);
  try {
    const res = await fetch(`${base}/api/agenda/${encodeURIComponent(agendaId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        actor: 'good-life-operator',
        note: status === 'stale'
          ? 'dismissed from Good Life operator work surface'
          : 'acknowledged from Good Life operator work surface',
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.ok === false) throw new Error(result.error || `HTTP ${res.status}`);
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `${agendaId} marked ${status}.`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `Agenda update failed: ${err.message}`);
  }
}

async function dismissGoodLifeAgendaReviewRows() {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const agenda = data?.operator?.detail?.work?.obligations?.activeAgenda || [];
  const reviewRows = agenda.filter((item) => item?.id && item.review?.recommended);
  if (!reviewRows.length) {
    setText('goodlife-overlay-action-status', 'No Good Life agenda review rows to dismiss.');
    return;
  }

  const confirmed = window.confirm(`Dismiss ${reviewRows.length} Good Life agenda review row${reviewRows.length === 1 ? '' : 's'} as stale? This keeps a status receipt and removes them from active work.`);
  if (!confirmed) return;

  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', `Dismissing ${reviewRows.length} agenda review row${reviewRows.length === 1 ? '' : 's'}...`);
  let updated = 0;
  try {
    for (const row of reviewRows) {
      const res = await fetch(`${base}/api/agenda/${encodeURIComponent(row.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'stale',
          actor: 'good-life-operator',
          note: `dismissed stale Good Life review row: ${row.review?.reason || 'operator review recommended'}`,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || result.ok === false) throw new Error(result.error || `HTTP ${res.status}`);
      updated += 1;
    }
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `${updated} agenda review row${updated === 1 ? '' : 's'} dismissed.`);
  } catch (err) {
    await loadGoodLifeForScope(goodLifeOverlayState.scope).catch(() => {});
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `Dismissed ${updated}/${reviewRows.length}; failed: ${err.message}`);
  }
}

async function archiveGoodLifeGoal(goalId) {
  if (!goalId) return;
  const confirmed = window.confirm(`Archive active goal ${goalId}? This removes it from the engine's active goal list without marking it completed.`);
  if (!confirmed) return;

  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', `Archiving ${goalId}...`);
  try {
    const res = await fetch(`${base}/api/goals/${encodeURIComponent(goalId)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'good-life-operator',
        reason: 'archived from Good Life operator after review',
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.ok === false) throw new Error(result.error || `HTTP ${res.status}`);
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `${goalId} archived.`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `Goal archive failed: ${err.message}`);
  }
}

async function archiveGoodLifeGoalReviewRows() {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const goals = data?.operator?.detail?.work?.obligations?.activeGoals || [];
  const reviewGoals = goals.filter((goal) => goal?.id && goal.review?.recommended);
  if (!reviewGoals.length) {
    setText('goodlife-overlay-action-status', 'No Good Life goals need operator review.');
    return;
  }

  const confirmed = window.confirm(`Archive ${reviewGoals.length} reviewed Good Life goal${reviewGoals.length === 1 ? '' : 's'}? This removes stale goals from the active list without marking them completed.`);
  if (!confirmed) return;

  const base = goodLifeBaseForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', `Archiving ${reviewGoals.length} reviewed goal${reviewGoals.length === 1 ? '' : 's'}...`);
  let updated = 0;
  try {
    for (const goal of reviewGoals) {
      const res = await fetch(`${base}/api/goals/${encodeURIComponent(goal.id)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor: 'good-life-operator',
          reason: `bulk archived from Good Life operator review: ${goal.review?.reason || 'operator review recommended'}`,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || result.ok === false) throw new Error(result.error || `HTTP ${res.status}`);
      updated += 1;
    }
    await loadGoodLifeForScope(goodLifeOverlayState.scope);
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `${updated} reviewed goal${updated === 1 ? '' : 's'} archived.`);
  } catch (err) {
    await loadGoodLifeForScope(goodLifeOverlayState.scope).catch(() => {});
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `Archived ${updated}/${reviewGoals.length}; failed: ${err.message}`);
  }
}

async function runGoodLifeWorkerCheck(problemId) {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const problem = (data?.liveProblems?.problems || []).find((entry) => entry.id === problemId);
  if (!problem) {
    setText('goodlife-overlay-action-status', 'Select an active issue first.');
    return;
  }

  setText('goodlife-overlay-action-status', 'Starting worker check...');
  try {
    const worker = await chooseGoodLifeWorker();
    if (!worker?.name) throw new Error('No worker specialists are available.');
    const result = await workerApi(`/${encodeURIComponent(worker.name)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: buildGoodLifeWorkerPrompt(problem),
        requestedBy: 'good-life-operator',
        requester: 'home23-dashboard',
        ownerAgent: goodLifeOwnerAgentForScope(goodLifeOverlayState.scope),
        source: { type: 'live-problem', id: problem.id },
        metadata: {
          surface: 'good-life',
          scope: goodLifeOverlayState.scope,
          problemId: problem.id,
        },
      }),
    });
    workersState.receipt = result.receipt || null;
    if (result.runId) {
      await loadWorkersSurface().catch(() => {});
      await openWorkerReceipt(result.runId).catch(() => {});
    }
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `Worker check complete: ${formatGoodLifeWorkerResult(workersState.receipt || result.receipt, result.runId)}.`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `Worker check failed: ${err.message}`);
  }
}

async function runGoodLifeAgendaWorkerCheck(agendaId) {
  const data = goodLifeSurfaceState.get(goodLifeOverlayState.scope);
  const agenda = data?.operator?.detail?.work?.obligations?.activeAgenda || [];
  const item = agenda.find((entry) => entry.id === agendaId);
  if (!item) {
    setText('goodlife-overlay-action-status', 'Select an active Good Life work item first.');
    return;
  }
  const workerRoute = effectiveGoodLifeAgendaWorkerRoute(item);
  const workerName = workerRoute?.worker;
  if (!workerName) {
    setText('goodlife-overlay-action-status', 'This Good Life work item does not have a recommended worker route.');
    return;
  }

  const owner = goodLifeOwnerAgentForScope(goodLifeOverlayState.scope);
  setText('goodlife-overlay-action-status', `Starting ${workerName} worker for ${agendaId}...`);
  try {
    const result = await workerApi(`/${encodeURIComponent(workerName)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: buildGoodLifeAgendaWorkerPrompt(item),
        requestedBy: 'good-life-operator',
        requester: 'home23-dashboard',
        ownerAgent: owner,
        source: { type: 'good-life-agenda', id: agendaId },
        metadata: {
          surface: 'good-life',
          scope: goodLifeOverlayState.scope,
          agendaId,
          workerRoute,
        },
      }),
    });
    workersState.receipt = result.receipt || null;
    if (result.runId) {
      await loadWorkersSurface().catch(() => {});
      await openWorkerReceipt(result.runId).catch(() => {});
    }
    await loadGoodLifeForScope(goodLifeOverlayState.scope).catch(() => {});
    renderGoodLifeOverlay();
    setText('goodlife-overlay-action-status', `${workerName} worker complete: ${formatGoodLifeWorkerResult(workersState.receipt || result.receipt, result.runId)}.`);
  } catch (err) {
    setText('goodlife-overlay-action-status', `${workerName} worker failed: ${err.message}`);
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

function extractNodeCount(state) {
  const nodes = state?.memory?.nodes ?? state?.memoryNodes ?? state?.nodeCount;
  if (Array.isArray(nodes)) return nodes.length;
  if (typeof nodes === 'number') return nodes;
  return null;
}

function extractActiveGoalCount(state) {
  const active = state?.goals?.active ?? state?.activeGoals;
  if (Array.isArray(active)) return active.length;
  if (typeof active === 'number') return active;
  if (active && typeof active === 'object') return Object.keys(active).length;
  return null;
}

function formatCompactNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US');
}

function updateOverviewMetrics(state, summary = null) {
  const nodeCount = extractNodeCount(state) ?? extractNodeCount(summary);
  const activeGoalCount = extractActiveGoalCount(state) ?? extractActiveGoalCount(summary);
  const energy = state?.cognitiveState?.energy;
  if (typeof energy === 'number') {
    setText('pulse-energy', `⚡ ${Math.round(energy * 100)}%`);
  }
  setText('pulse-node-count', formatCompactNumber(nodeCount));
  setText('pulse-active-goals', activeGoalCount != null ? String(activeGoalCount) : '—');
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

// ── Auto-Refresh ──

function startAutoRefresh() {
  setInterval(async () => {
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

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
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

// ── Start ──

document.addEventListener('DOMContentLoaded', init);
